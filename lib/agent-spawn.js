const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  HARNESS_BIN,
  HARNESS_CONFIG,
  WORKSPACE_DIR,
  MCP_CONFIG,
  AGENT_TIMEOUT_MS,
  loadProjects,
  loadMachines,
} = require("./config");
const { sendToTeams, sendLargeOutput } = require("./teams-io");

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

  while (true) {
    // Handle --alola with optional 2-digit node number
    let match = remaining.match(/^--alola(?:\s+(\d{2}))?\s+/);
    if (match) {
      flags.alola = match[1] || DEFAULT_ALOLA_NODE;
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Handle --key value flags
    match = remaining.match(/^--(\w[\w-]*)\s+(\S+)\s*/);
    if (match) {
      flags[match[1]] = match[2];
      remaining = remaining.slice(match[0].length);
      continue;
    }

    break;
  }

  return { flags, prompt: remaining };
}
function resolveModel(threadInfo, flags) {
  if (!threadInfo || !flags) return null;
  const modelFlag = HARNESS_CONFIG.flags.model;
  if (!modelFlag) return null;

  const normalize = (value) =>
    typeof value === "string" ? value.trim() : "";

  const explicit = normalize(flags.model);
  if (explicit) {
    threadInfo.model = explicit;
    flags.model = explicit;
    return explicit;
  }

  const cached = normalize(threadInfo.model);
  if (cached) {
    flags.model = cached;
    return cached;
  }

  if (!threadInfo.isFollowUp) {
    const fallback = normalize(HARNESS_CONFIG.defaultModel);
    if (fallback) {
      threadInfo.model = fallback;
      flags.model = fallback;
      return fallback;
    }
  }

  return null;
}

function buildHarnessArgs(threadInfo, prompt, flags) {
  const args = Array.from(HARNESS_CONFIG.baseArgs);
  const modelFlag = HARNESS_CONFIG.flags.model;

  resolveModel(threadInfo, flags);

  if (threadInfo.isFollowUp) {
    if (HARNESS_CONFIG.flags.resume) {
      args.push(HARNESS_CONFIG.flags.resume, threadInfo.sessionId);
    }
  } else {
    if (HARNESS_CONFIG.flags.sessionId) {
      args.push(HARNESS_CONFIG.flags.sessionId, threadInfo.sessionId);
    }
    if (HARNESS_CONFIG.appendSystemPrompt && HARNESS_CONFIG.flags.appendSystemPrompt) {
      args.push(HARNESS_CONFIG.flags.appendSystemPrompt, buildRoutingContext());
    }
  }

  if (HARNESS_CONFIG.skipPermissions && HARNESS_CONFIG.flags.skipPermissions) {
    args.push(HARNESS_CONFIG.flags.skipPermissions);
  }

  if (modelFlag && typeof flags.model === "string" && flags.model.length > 0) {
    const existingIndex = args.lastIndexOf(modelFlag);
    if (existingIndex !== -1 && existingIndex + 1 < args.length) {
      args[existingIndex + 1] = flags.model;
    } else {
      args.push(modelFlag, flags.model);
    }
  }
  if (HARNESS_CONFIG.flags.effort && flags.effort) {
    args.push(HARNESS_CONFIG.flags.effort, flags.effort);
  }

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
      { timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }
    ).toString().trim();

    if (existing === "exists") {
      console.log(`[Alola] Container ${containerName} already exists on node ${node}`);
      return true;
    }

    console.log(`[Alola] Creating container ${containerName} on node ${node}...`);
    const createOut = execSync(
      `${script} ${node} "enroot create -n ${containerName} ${DEFAULT_ALOLA_IMAGE} 2>&1"`,
      { timeout: 120000, stdio: ["ignore", "pipe", "pipe"] }
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

function buildAlolaExtraArgs(threadInfo, flags) {
  const extraArgs = [];
  if (threadInfo.isFollowUp) extraArgs.push("--resume");
  if (HARNESS_CONFIG.flags.model && flags.model) {
    extraArgs.push(HARNESS_CONFIG.flags.model, flags.model);
  }
  if (HARNESS_CONFIG.flags.effort && flags.effort) {
    extraArgs.push(HARNESS_CONFIG.flags.effort, flags.effort);
  }
  return extraArgs;
}

function buildAlolaRemoteCommand(containerName, sessionId, extraArgs) {
  const quotedArgs = [containerName, sessionId, ...extraArgs].map(shellQuote).join(" ");
  return `cd ~/ROCm-workspace && git pull --ff-only -q 2>/dev/null; ${ALOLA_RUN_SCRIPT} ${quotedArgs}`;
}

function spawnAlolaAgent(threadInfo, message, replyToId, maxConcurrent) {
  const { flags, prompt } = extractFlags(message);
  resolveModel(threadInfo, flags);
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

  const extraArgs = buildAlolaExtraArgs(threadInfo, flags);
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

    const result = stdout || stderr || "(no output)";
    console.log(`[Thread ${threadInfo.rootMessageId}] Alola done (exit ${code}, ${result.length} chars, active: ${activeAgents})`);

    scheduleContainerCleanup(node, containerName, threadInfo.sessionId);
    sendLargeOutput(result, replyToId);
  });

  proc.on("error", (err) => {
    clearTimeout(timeout);
    activeAgents--;
    threadInfo.busy = false;
    threadInfo.childPid = null;
    console.error(`[Thread ${threadInfo.rootMessageId}] Alola spawn error:`, err.message);
    sendToTeams(`Failed to start Alola agent: ${err.message}`, replyToId);
  });
}

let activeAgents = 0;

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
  const harnessArgs = prepareHarnessArgs(buildHarnessArgs(threadInfo, prompt, flags));



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

    const result = stdout || stderr || "(no output)";
    console.log(`[Thread ${threadInfo.rootMessageId}] Done (exit ${code}, ${result.length} chars, active: ${activeAgents})`);

    sendLargeOutput(result, replyToId);
  });

  proc.on("error", (err) => {
    clearTimeout(timeout);
    activeAgents--;
    threadInfo.busy = false;
    threadInfo.childPid = null;
    console.error(`[Thread ${threadInfo.rootMessageId}] Spawn error:`, err.message);
    sendToTeams(`Failed to start agent: ${err.message}`, replyToId);
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
};
