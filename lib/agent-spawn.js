const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  HARNESS_BIN,
  HARNESS_CONFIG,
  WORKSPACE_DIR,
  MCP_CONFIG,
  AGENT_TIMEOUT_MS,
  ROOT_DIR,
  loadProjects,
  loadMachines,
} = require("./config");
const { sendToTeams, sendLargeOutput } = require("./teams-io");

const SESSIONS_DIR = path.join(ROOT_DIR, "sessions");

const DEFAULT_ALOLA_NODE = "03";
const DEFAULT_ALOLA_IMAGE = "/cluster/images/hipdnn/hipdnn_latest_gfx90a.sqsh";
const ALOLA_CONTAINER_TIMEOUT_MS = 2 * 24 * 60 * 60 * 1000;

// Track active alola containers for cleanup
const alolaContainers = new Map();

function buildRoutingContext() {
  const os = require("os");
  const projects = loadProjects();
  if (!projects) return "";

  const lines = [
    "## Environment",
    `Host: **${os.hostname()}** (${os.platform()}, ${os.arch()}). Home: \`${os.homedir()}\``,
    "",
    "Check `.claude/registry/machines.json` for machine-specific context.",
    "Verify paths with `test -d` before accessing — SSH may be needed.",
    "",
    "## Projects",
  ];

  for (const [key, proj] of Object.entries(projects.projects)) {
    const aliases = (proj.aliases || []).join(", ");
    lines.push(`- **${proj.name}** (${aliases}) — \`${proj.path}\``);
  }

  lines.push("");
  lines.push("## Machines");

  const machinesData = loadMachines();
  if (machinesData) {
    for (const [key, m] of Object.entries(machinesData.machines)) {
      const nodes = m.nodes ? ` (nodes: ${m.nodes.join(", ")})` : "";
      lines.push(`- **${m.name}**${nodes} — SSH: \`${m.sshScript} <node> "<cmd>"\`, context: \`${m.context}\``);
    }
  }

  lines.push("");
  lines.push("## Jira: ALMIOPEN→rocm-libraries, THEROCK→therock, MLSE→mlse-tools");
  lines.push("");
  lines.push("Use `/goto <project>` to load full project context. Read machine context docs before working on remote machines.");

  return lines.join("\n");
}

function threadSessionDir(threadId) {
  const dir = path.join(SESSIONS_DIR, threadId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function finalizeSession(sessionDir) {
  try {
    const files = fs.readdirSync(sessionDir).sort();
    let latestId = null;
    for (const f of files) {
      const tmpMatch = f.match(/^\.(.+\.jsonl)\.[a-f0-9]+\.tmp$/);
      if (tmpMatch) {
        const src = path.join(sessionDir, f);
        const dst = path.join(sessionDir, tmpMatch[1]);
        try { fs.renameSync(src, dst); } catch {}
        const idMatch = tmpMatch[1].match(/_([0-9a-f-]{36})\.jsonl$/);
        if (idMatch) latestId = idMatch[1];
        continue;
      }
      const jsonlMatch = f.match(/_([0-9a-f-]{36})\.jsonl$/);
      if (jsonlMatch && !f.startsWith(".")) latestId = jsonlMatch[1];
    }
    return latestId;
  } catch {}
  return null;
}

function getProjectDirs() {
  const projects = loadProjects();
  if (!projects) return [];

  const dirs = new Set();
  for (const proj of Object.values(projects.projects)) {
    dirs.add(proj.path);
    for (const wt of Object.values(proj.worktrees || {})) {
      dirs.add(wt.path);
    }
  }
  return [...dirs].filter((d) => fs.existsSync(d));
}

function extractFlags(message) {
  let remaining = message;
  const flags = {};
  const harnessArgs = [];

  while (true) {
    let match = remaining.match(/^--(?:\s+|$)/);
    if (match) {
      remaining = remaining.slice(match[0].length);
      break;
    }

    match = remaining.match(/^--alola(?:=(\d{2})|\s+(\d{2}))?(?:\s+|$)/);
    if (match) {
      flags.alola = match[1] || match[2] || DEFAULT_ALOLA_NODE;
      remaining = remaining.slice(match[0].length);
      continue;
    }

    match = remaining.match(/^(--\w[\w-]*=\S*)(?:\s+|$)/);
    if (match) {
      harnessArgs.push(match[1]);
      remaining = remaining.slice(match[0].length);
      continue;
    }

    match = remaining.match(/^(--\w[\w-]*)(?:\s+|$)/);
    if (match) {
      harnessArgs.push(match[1]);
      remaining = remaining.slice(match[0].length);

      const valueMatch = remaining.startsWith("--")
        ? null
        : remaining.match(/^(\S+)(?:\s+|$)/);
      if (valueMatch) {
        harnessArgs.push(valueMatch[1]);
        remaining = remaining.slice(valueMatch[0].length);
      }
      continue;
    }

    break;
  }

  return { flags, harnessArgs, prompt: remaining };
}
function modelArgIndex(args) {
  const modelFlag = HARNESS_CONFIG.flags.model || "--model";
  if (!modelFlag) return -1;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === modelFlag) return i;
    if (arg.startsWith(`${modelFlag}=`)) return i;
  }

  return -1;
}

function hasModelArg(args) {
  return modelArgIndex(args) !== -1;
}

function withDefaultModel(args, model) {
  const modelFlag = HARNESS_CONFIG.flags.model || "--model";
  if (!modelFlag || !model || hasModelArg(args)) return args;
  return [...args, modelFlag, model];
}

function getModelValue(args) {
  const modelFlag = HARNESS_CONFIG.flags.model || "--model";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === modelFlag && i + 1 < args.length) return args[i + 1];
    if (arg.startsWith(`${modelFlag}=`)) return arg.slice(modelFlag.length + 1);
  }
  return null;
}

function setModelValue(args, value) {
  const modelFlag = HARNESS_CONFIG.flags.model || "--model";
  const out = args.slice();
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === modelFlag && i + 1 < out.length) {
      out[i + 1] = value;
      return out;
    }
    if (out[i].startsWith(`${modelFlag}=`)) {
      out[i] = `${modelFlag}=${value}`;
      return out;
    }
  }
  return out;
}

function normalizeBareModel(model) {
  if (typeof model !== "string" || !model || model.includes("/")) return model;
  if (/^(gpt-|o1-|o3-)/.test(model)) return `openai/${model}`;
  if (model.startsWith("claude-")) return `anthropic/${model}`;
  return model;
}

function applyStickyOptions(threadInfo, harnessArgs) {
  const modelFlag = HARNESS_CONFIG.flags.model || "--model";
  const explicit = getModelValue(harnessArgs);
  if (explicit) {
    const normalized = normalizeBareModel(explicit);
    threadInfo.model = normalized;
    return normalized === explicit ? harnessArgs : setModelValue(harnessArgs, normalized);
  }
  if (threadInfo.model) {
    return [...harnessArgs, modelFlag, threadInfo.model];
  }
  return harnessArgs;
}

function normalizeAlolaModelArg(args) {
  const modelFlag = HARNESS_CONFIG.flags.model || "--model";
  if (!modelFlag) return args;
  const normalized = args.slice();

  for (let i = 0; i < normalized.length; i += 1) {
    const arg = normalized[i];
    if (arg === modelFlag && i + 1 < normalized.length) {
      normalized[i + 1] = normalizeAlolaModelName(normalized[i + 1]);
      i += 1;
    } else if (arg.startsWith(`${modelFlag}=`)) {
      normalized[i] = `${modelFlag}=${normalizeAlolaModelName(arg.slice(modelFlag.length + 1))}`;
    }
  }

  return normalized;
}

function normalizeAlolaModelName(model) {
  if (typeof model !== "string") return model;
  return model.replace(/claude-opus-4\.7/g, "claude-opus-4-7");
}

function buildHarnessArgs(threadInfo, prompt, harnessArgs = []) {
  const args = Array.from(HARNESS_CONFIG.baseArgs);

  if (threadInfo.isFollowUp) {
    if (HARNESS_CONFIG.flags.resume && threadInfo.harnessSessionId) {
      args.push(HARNESS_CONFIG.flags.resume, threadInfo.harnessSessionId);
    }
  } else {
    if (HARNESS_CONFIG.flags.sessionId) {
      args.push(HARNESS_CONFIG.flags.sessionId, threadInfo.sessionId);
    }
    if (HARNESS_CONFIG.appendSystemPrompt && HARNESS_CONFIG.flags.appendSystemPrompt) {
      args.push(HARNESS_CONFIG.flags.appendSystemPrompt, buildRoutingContext());
    }
  }

  if (HARNESS_CONFIG.flags.sessionDir && threadInfo.rootMessageId) {
    args.push(HARNESS_CONFIG.flags.sessionDir, threadSessionDir(threadInfo.rootMessageId));
  }

  if (HARNESS_CONFIG.skipPermissions && HARNESS_CONFIG.flags.skipPermissions) {
    args.push(HARNESS_CONFIG.flags.skipPermissions);
  }

  args.push(...withDefaultModel(harnessArgs, HARNESS_CONFIG.defaultModel));

  if (HARNESS_CONFIG.flags.prompt) {
    args.push(HARNESS_CONFIG.flags.prompt, prompt);
  } else {
    args.push(prompt);
  }

  return args;
}

function prepareHarnessArgs(baseArgs) {
  const args = baseArgs.slice();
  const promptFlag = HARNESS_CONFIG.flags.prompt;
  let promptIndex = promptFlag ? args.lastIndexOf(promptFlag) : args.length - 1;
  if (promptIndex < 0) promptIndex = args.length;

  let insertAt = promptIndex;
  if (HARNESS_CONFIG.flags.mcpConfig && fs.existsSync(MCP_CONFIG)) {
    args.splice(insertAt, 0, HARNESS_CONFIG.flags.mcpConfig, MCP_CONFIG);
    insertAt += 2;
  }

  if (HARNESS_CONFIG.flags.addDir) {
    for (const dir of getProjectDirs()) {
      args.splice(insertAt, 0, HARNESS_CONFIG.flags.addDir, dir);
      insertAt += 2;
    }
  }

  return args;
}

function sshScript() {
  return path.join(WORKSPACE_DIR, "scripts/ssh/ssh-alola.sh");
}

function alolaContainerName(sessionId) {
  return `claude-${sessionId.slice(0, 8)}`;
}

function ensureAlolaContainer(node, containerName) {
  const script = sshScript();
  try {
    const existing = execSync(
      `${script} ${node} "enroot list 2>/dev/null | grep -q '^${containerName}$' && echo exists || echo missing"`,
      { timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }
    ).toString().trim();

    if (existing === "exists") {
      console.log(`[Alola] Container ${containerName} already exists on node ${node}`);
      return true;
    }

    console.log(`[Alola] Creating container ${containerName} on node ${node}...`);
    const createOut = execSync(
      `${script} ${node} "enroot create -n ${containerName} ${DEFAULT_ALOLA_IMAGE} 2>&1"`,
      { timeout: 300000, stdio: ["ignore", "pipe", "pipe"] }
    ).toString();
    if (createOut.includes("No space left") || createOut.includes("FATAL ERROR")) {
      throw new Error(createOut.trim().split("\n").find(l => l.includes("FATAL") || l.includes("No space")) || createOut.trim());
    }
    console.log(`[Alola] Container ${containerName} created`);
    return true;
  } catch (err) {
    const msg = err.message || String(err);
    console.error(`[Alola] Failed to ensure container: ${msg}`);
    throw err;
  }
}

function removeAlolaContainer(node, containerName) {
  const script = sshScript();
  try {
    execSync(
      `${script} ${node} "enroot remove -f ${containerName} 2>/dev/null || true"`,
      { timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }
    );
    console.log(`[Alola] Container ${containerName} removed from node ${node}`);
  } catch (err) {
    console.error(`[Alola] Failed to remove container: ${err.message}`);
  }
}

function scheduleContainerCleanup(node, containerName, sessionId) {
  const existing = alolaContainers.get(sessionId);
  if (existing?.timer) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    console.log(`[Alola] Container ${containerName} timed out, removing`);
    removeAlolaContainer(node, containerName);
    alolaContainers.delete(sessionId);
  }, ALOLA_CONTAINER_TIMEOUT_MS);

  alolaContainers.set(sessionId, { node, containerName, timer });
}

const ALOLA_RUN_SCRIPT = "~/ROCm-workspace/scripts/run-agent.sh";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildAlolaExtraArgs(threadInfo, harnessArgs = []) {
  const extraArgs = [];
  if (threadInfo.isFollowUp) extraArgs.push("--resume");
  extraArgs.push(
    ...normalizeAlolaModelArg(
      withDefaultModel(harnessArgs, HARNESS_CONFIG.alolaDefaultModel)
    )
  );
  return extraArgs;
}

function buildAlolaRemoteCommand(containerName, sessionId, extraArgs) {
  const quotedArgs = [containerName, sessionId, ...extraArgs].map(shellQuote).join(" ");
  return `cd ~/ROCm-workspace && git pull --ff-only -q 2>/dev/null; ${ALOLA_RUN_SCRIPT} ${quotedArgs}`;
}

function spawnAlolaAgent(threadInfo, message, replyToId, maxConcurrent) {
  const { flags, harnessArgs: rawArgs, prompt } = extractFlags(message);
  const harnessArgs = applyStickyOptions(threadInfo, rawArgs);
  const node = flags.alola || DEFAULT_ALOLA_NODE;
  const containerName = alolaContainerName(threadInfo.sessionId);

  if (!threadInfo.isFollowUp) {
    sendToTeams(`🚀 Starting on Alola node ${node}...`, replyToId);
  }

  try {
    ensureAlolaContainer(node, containerName);
  } catch (err) {
    const detail = err.message?.split("\n")[0] || "unknown error";
    sendToTeams(`Failed to create container on Alola node ${node}: ${detail}`, replyToId);
    threadInfo.busy = false;
    return;
  }

  const extraArgs = buildAlolaExtraArgs(threadInfo, harnessArgs);
  const remoteCmd = buildAlolaRemoteCommand(containerName, threadInfo.sessionId, extraArgs);

  const sshScriptPath = sshScript();
  activeAgents++;
  threadInfo.alola = { node, containerName };

  console.log(
    `[Thread ${threadInfo.rootMessageId}] Spawning on Alola ${node} (container: ${containerName}, session: ${threadInfo.sessionId.slice(0, 8)}..., active: ${activeAgents})`
  );

  const proc = spawn(sshScriptPath, [node, remoteCmd], {
    cwd: WORKSPACE_DIR,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Send prompt via stdin
  proc.stdin.write(prompt);
  proc.stdin.end();

  threadInfo.childPid = proc.pid;
  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const timeout = setTimeout(() => {
    console.log(`[Thread ${threadInfo.rootMessageId}] Alola agent timed out, killing`);
    proc.kill("SIGTERM");
  }, AGENT_TIMEOUT_MS);

  proc.on("close", (code) => {
    clearTimeout(timeout);
    activeAgents--;
    threadInfo.busy = false;
    threadInfo.childPid = null;

    const trimmed = (stdout || "").trim();
    const stderrTrimmed = (stderr || "").trim();
    let result;
    if (trimmed) {
      result = stdout;
    } else if (stderrTrimmed) {
      result = stderr;
    } else {
      result = `⚠️ Agent finished with no output (exit ${code}) on Alola ${node}. Likely a model/gateway issue — try a different \`--model\` (e.g. \`--model anthropic/claude-haiku-4-5\` or \`--model openai/gpt-5.4\`).`;
    }
    console.log(`[Thread ${threadInfo.rootMessageId}] Alola done (exit ${code}, ${result.length} chars, active: ${activeAgents})`);

    scheduleContainerCleanup(node, containerName, threadInfo.sessionId);
    try { require("./threads").saveThreadsToDisk(); } catch {}
    sendLargeOutput(result, replyToId);
    processPending(threadInfo, replyToId, maxConcurrent);
  });

  proc.on("error", (err) => {
    clearTimeout(timeout);
    activeAgents--;
    threadInfo.busy = false;
    threadInfo.childPid = null;
    console.error(`[Thread ${threadInfo.rootMessageId}] Alola spawn error:`, err.message);
    sendToTeams(`Failed to start Alola agent: ${err.message}`, replyToId);
    processPending(threadInfo, replyToId, maxConcurrent);
  });
}

let activeAgents = 0;

function processPending(threadInfo, replyToId, maxConcurrent) {
  if (!threadInfo.pending) return;
  const { text, from } = threadInfo.pending;
  threadInfo.pending = null;
  threadInfo.isFollowUp = true;
  threadInfo.busy = true;
  console.log(`[Thread ${threadInfo.rootMessageId}] Processing queued message from ${from}: "${text.slice(0, 60)}"`);
  spawnAgent(threadInfo, text, replyToId, maxConcurrent);
}

function spawnAgent(threadInfo, message, replyToId, maxConcurrent = 3) {
  if (activeAgents >= maxConcurrent) {
    sendToTeams("⏳ Too many agents running. Please wait...", replyToId);
    threadInfo.busy = false;
    return;
  }

  // Check for --alola flag
  const parsedFlags = extractFlags(message);
  const { flags } = parsedFlags;
  if (flags.alola || threadInfo.alola) {
    if (!flags.alola && threadInfo.alola) {
      // Follow-up in an alola thread — re-add the flag
      message = `--alola ${threadInfo.alola.node} ${message}`;
    }
    spawnAlolaAgent(threadInfo, message, replyToId, maxConcurrent);
    return;
  }

  // Local spawn
  const prompt = parsedFlags.prompt;
  const stickyArgs = applyStickyOptions(threadInfo, parsedFlags.harnessArgs);
  const harnessArgs = prepareHarnessArgs(buildHarnessArgs(threadInfo, prompt, stickyArgs));



  activeAgents++;

  console.log(
    `[Thread ${threadInfo.rootMessageId}] Spawning local (session: ${threadInfo.sessionId.slice(0, 8)}..., follow-up: ${threadInfo.isFollowUp}, active: ${activeAgents})`
  );

  const proc = spawn(HARNESS_BIN, harnessArgs, {
    cwd: WORKSPACE_DIR,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  threadInfo.childPid = proc.pid;
  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const timeout = setTimeout(() => {
    console.log(`[Thread ${threadInfo.rootMessageId}] Agent timed out, killing`);
    proc.kill("SIGTERM");
  }, AGENT_TIMEOUT_MS);

  proc.on("close", (code) => {
    clearTimeout(timeout);
    activeAgents--;
    threadInfo.busy = false;
    threadInfo.childPid = null;

    if (HARNESS_CONFIG.flags.sessionDir && threadInfo.rootMessageId) {
      const sid = finalizeSession(threadSessionDir(threadInfo.rootMessageId));
      if (sid) {
        threadInfo.harnessSessionId = sid;
        console.log(`[Thread ${threadInfo.rootMessageId}] Session: ${sid.slice(0, 12)}...`);
      }
    }

    try { require("./threads").saveThreadsToDisk(); } catch {}

    const trimmed = (stdout || "").trim();
    const stderrTrimmed = (stderr || "").trim();
    let result;
    if (trimmed) {
      result = stdout;
    } else if (stderrTrimmed) {
      result = stderr;
    } else {
      result = `⚠️ Agent finished with no output (exit ${code}). Likely a model/gateway issue — try a different \`--model\` (e.g. \`--model anthropic/claude-haiku-4-5\` or \`--model openai/gpt-5.4\`).`;
    }
    console.log(`[Thread ${threadInfo.rootMessageId}] Done (exit ${code}, ${result.length} chars, active: ${activeAgents})`);

    sendLargeOutput(result, replyToId);
    processPending(threadInfo, replyToId, maxConcurrent);
  });

  proc.on("error", (err) => {
    clearTimeout(timeout);
    activeAgents--;
    threadInfo.busy = false;
    threadInfo.childPid = null;
    console.error(`[Thread ${threadInfo.rootMessageId}] Spawn error:`, err.message);
    sendToTeams(`Failed to start agent: ${err.message}`, replyToId);
    processPending(threadInfo, replyToId, maxConcurrent);
  });
}

module.exports = {
  spawnAgent,
  buildRoutingContext,
  getProjectDirs,
  extractFlags,
  buildHarnessArgs,
  prepareHarnessArgs,
  buildAlolaExtraArgs,
  buildAlolaRemoteCommand,
  removeAlolaContainer,
  alolaContainers,
  applyStickyOptions,
  normalizeBareModel,
  finalizeSession,
  threadSessionDir,
};
