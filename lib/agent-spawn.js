const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  HARNESS_BIN,
  HARNESS_CONFIG,
  WORKSPACE_DIR,
  MCP_CONFIG,
  AGENT_TIMEOUT_MS,
  ROOT_DIR,
  STATE_DIR,
  loadProjects,
  loadMachines,
  AGENT_RUNTIME_HOST,
  DEPLOYMENT_HOST,
  ALOLA_CONFIG,
} = require("./config");
const {
  parseAlolaTarget,
  isAsicToken,
  isGpuToken,
  buildSessionMetadata,
  coerceAlolaMetadata,
  describeAlolaTarget,
} = require("./alola-session");
const { sendToTeams, sendLargeOutput, AI_PREFIX } = require("./teams-io");

const SESSIONS_DIR = path.join(STATE_DIR || ROOT_DIR, "sessions");

const ALOLA_WORK_RE = /\b(build|rebuild|compile|test|ctest|benchmark|bench|perf|gpu|rocm|hipcc|rocminfo|rocm-smi|cmake|ninja|provider verification|verify providers?|runtime)\b/i;

function buildRoutingContext(threadInfo = null) {
  const os = require("os");
  const projects = loadProjects();
  const lines = [
    "## Environment",
    `Controller host: **${AGENT_RUNTIME_HOST || os.hostname()}** (${os.platform()}, ${os.arch()}). Deployment host: **${DEPLOYMENT_HOST || AGENT_RUNTIME_HOST || os.hostname()}**. Home: \`${os.homedir()}\``,
    "",
    "Check `.claude/registry/machines.json` for machine-specific context.",
    "Verify paths with `test -d` before accessing — SSH may be needed.",
    "",
    "## Execution routing",
    "- The harness process runs locally on the HPE/controller host by default. Use local HPE state for ordinary code reading, editing, review, planning, and research.",
    "- Do not run ROCm builds, CMake/Ninja, ctest, benchmarks, provider verification, GPU runtime checks, hipcc, rocminfo, or rocm-smi directly on HPE.",
    `- For build/test/benchmark/runtime work, use \`workspace/scripts/alola-session run -- <command>\`; default Alola target is login node ${ALOLA_CONFIG.defaultLoginNode} (${ALOLA_CONFIG.defaultAsic}).`,
    `- For login-node enroot work, home/project paths and ${ALOLA_CONFIG.imageTemplate} are shared, but named enroot rootfses such as ${ALOLA_CONFIG.defaultLoginContainer} are node-local under /var/tmp. If a login node lacks the rootfs, recreate it from the shared image instead of switching nodes permanently.`,
    `- For a non-login GPU allocation, use \`workspace/scripts/alola-session run --target <asic> -- <command>\`; the default constraint is ${ALOLA_CONFIG.defaultConstraintPrefix || "<ASIC>"}&<ASIC_UPPER> and the image template is \`${ALOLA_CONFIG.imageTemplate}\`.`,
  ];

  const alola = coerceAlolaMetadata(threadInfo?.alola, threadInfo || undefined);
  if (alola) {
    lines.push(`- This thread has an explicit Alola target: ${describeAlolaTarget(alola)}.`);
  }

  lines.push("");
  lines.push("## Projects");
  if (projects?.projects) {
    for (const proj of Object.values(projects.projects)) {
      const aliases = (proj.aliases || []).join(", ");
      lines.push(`- **${proj.name}** (${aliases}) — \`${proj.path}\``);
    }
  } else {
    lines.push("- Project registry unavailable; inspect workspace/.claude/registry/projects.json before assuming paths.");
  }

  lines.push("");
  lines.push("## Machines");

  const machinesData = loadMachines();
  if (machinesData?.machines) {
    for (const m of Object.values(machinesData.machines)) {
      const nodes = m.nodes ? ` (nodes: ${m.nodes.join(", ")})` : "";
      lines.push(`- **${m.name}**${nodes} — SSH: \`${m.sshScript} <node> "<cmd>"\`, context: \`${m.context}\``);
    }
  }

  lines.push("");
  lines.push("## Jira: ALMIOPEN→rocm-libraries, THEROCK→therock, MLSE→mlse-tools");
  lines.push("");
  lines.push("Use workspace/.claude/registry/projects.json to resolve project context. Read machine context docs before working on remote machines.");

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

function peekToken(text) {
  const match = text.match(/^(\S+)(?:\s+|$)/);
  if (!match) return null;
  return { token: match[1], width: match[0].length };
}

function isNodeToken(token) {
  return /^\d{1,2}$/.test(String(token || ""));
}

function consumeAlolaTargetTokens(remaining) {
  const tokens = [];
  let rest = remaining;
  const first = peekToken(rest);
  if (!first) return { tokens, remaining: rest };

  if (isNodeToken(first.token) || isAsicToken(first.token) || isGpuToken(first.token)) {
    tokens.push(first.token);
    rest = rest.slice(first.width);

    if (isNodeToken(first.token)) {
      const second = peekToken(rest);
      if (second && (isAsicToken(second.token) || isGpuToken(second.token))) {
        tokens.push(second.token);
        rest = rest.slice(second.width);
      }
    }
  }

  return { tokens, remaining: rest };
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

    match = remaining.match(/^--alola(?:=([^\s]+))?(?:\s+|$)/);
    if (match) {
      remaining = remaining.slice(match[0].length);
      let tokens;
      if (match[1]) {
        tokens = [match[1]];
      } else {
        const consumed = consumeAlolaTargetTokens(remaining);
        tokens = consumed.tokens;
        remaining = consumed.remaining;
      }
      flags.alola = parseAlolaTarget(tokens);
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

function promptNeedsAlola(prompt) {
  return ALOLA_WORK_RE.test(String(prompt || ""));
}

function targetArg(metadata) {
  if (metadata.mode === "gpu") return metadata.asic;
  return metadata.loginNode === ALOLA_CONFIG.defaultLoginNode ? "default" : metadata.loginNode;
}

function buildPromptWithExecutionContext(threadInfo, prompt) {
  const explicitTarget = coerceAlolaMetadata(threadInfo.alola, threadInfo);
  const inferredTarget = explicitTarget || (promptNeedsAlola(prompt) ? buildSessionMetadata(threadInfo, parseAlolaTarget([])) : null);
  if (!inferredTarget) return prompt;

  const target = targetArg(inferredTarget);
  const targetFlag = target === "default" ? "" : ` --target ${target}`;
  const lines = [
    "[Execution routing]",
    "The harness stays local to the HPE/controller host. Run ROCm build/test/benchmark/runtime commands through a durable Alola session, not directly on HPE.",
    `Target: ${describeAlolaTarget(inferredTarget)}.`,
    `Use \`workspace/scripts/alola-session run${targetFlag} -- <command>\` for CMake/Ninja/ctest/hipcc/rocminfo/rocm-smi/provider-verification work.`,
    `Alola home/project paths and images are shared, but login-node enroot rootfses such as ${inferredTarget.container || ALOLA_CONFIG.defaultLoginContainer} are node-local under /var/tmp; if \`enroot list\` lacks the target container, recreate it from the shared image and retry.`,
  ];
  if (inferredTarget.mode === "gpu") {
    lines.push(`GPU allocation is non-exclusive, image ${inferredTarget.image}, constraint ${inferredTarget.constraint}, timeout ${inferredTarget.timeLimit}.`);
  }
  return `${lines.join("\n")}\n\n${prompt}`;
}

function buildHarnessArgs(threadInfo, prompt, harnessArgs = []) {
  const args = Array.from(HARNESS_CONFIG.baseArgs);
  const finalPrompt = buildPromptWithExecutionContext(threadInfo, prompt);

  const canResume = threadInfo.isFollowUp && threadInfo.harnessSessionId;

  if (canResume) {
    args.push(HARNESS_CONFIG.flags.resume, threadInfo.harnessSessionId);
  } else {
    if (!threadInfo.isFollowUp && HARNESS_CONFIG.flags.sessionId) {
      args.push(HARNESS_CONFIG.flags.sessionId, threadInfo.sessionId);
    }
    if (HARNESS_CONFIG.appendSystemPrompt && HARNESS_CONFIG.flags.appendSystemPrompt) {
      args.push(HARNESS_CONFIG.flags.appendSystemPrompt, buildRoutingContext(threadInfo));
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
    args.push(HARNESS_CONFIG.flags.prompt, finalPrompt);
  } else {
    args.push(finalPrompt);
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

let activeAgents = 0;

function processPending(threadInfo, replyToId, maxConcurrent) {
  if (!threadInfo.hasPending) return;
  threadInfo.hasPending = false;
  const { gatherThreadMessages } = require("./threads");
  const text = gatherThreadMessages(threadInfo);
  if (!text) return;
  threadInfo.isFollowUp = true;
  threadInfo.busy = true;
  console.log(`[Thread ${threadInfo.rootMessageId}] Processing queued messages: "${text.slice(0, 60)}"`);
  sendToTeams(threadInfo.chatId, `${AI_PREFIX} 🚀 Processing...`, replyToId);
  spawnAgent(threadInfo, text, replyToId, maxConcurrent);
}

function persistThreadsBestEffort() {
  try { require("./threads").saveThreadsToDisk(); } catch {}
}

function isTransientProviderStreamFailure(text) {
  return /\b(?:Provider|OpenAI responses|OpenAI completions|Azure OpenAI responses|Anthropic) stream (?:timed out while waiting for the first event|stalled while waiting for the next event)\b/i.test(String(text || ""));
}

function buildAgentResult(stdout, stderr, code, wasResuming) {
  const trimmed = (stdout || "").trim();
  const stderrTrimmed = (stderr || "").trim();
  let result;
  let resetSession = false;

  if (trimmed) {
    result = stdout;
  } else if (stderrTrimmed) {
    result = stderr;
  } else if (wasResuming) {
    resetSession = true;
    result = `⚠️ Agent finished with no output (exit ${code}) while resuming this thread's saved harness session. I reset the saved session for future replies; retry your message in this thread to start fresh.`;
  } else {
    result = `⚠️ Agent finished with no output (exit ${code}). Likely a model/gateway issue — try a different \`--model\` (e.g. \`--model anthropic/claude-haiku-4-5\` or \`--model openai/gpt-5.4\`).`;
  }

  if (wasResuming && code !== 0 && (trimmed || stderrTrimmed)) {
    if (isTransientProviderStreamFailure(result)) {
      result += "\n\n⚠️ This looks like a transient provider stream timeout. I preserved this thread's saved harness session; retry your message in this thread to resume with the previous context.";
    } else {
      resetSession = true;
      result += "\n\n⚠️ This failed while resuming this thread's saved harness session. I reset the saved session for future replies; retry your message in this thread to start fresh.";
    }
  }

  return { result, resetSession };
}

function spawnAgent(threadInfo, message, replyToId, maxConcurrent = 3) {
  if (activeAgents >= maxConcurrent) {
    sendToTeams(threadInfo.chatId, `${AI_PREFIX} ⏳ Too many agents running. Please wait...`, replyToId);
    threadInfo.busy = false;
    return;
  }

  let parsedFlags;
  try {
    parsedFlags = extractFlags(message);
  } catch (err) {
    sendToTeams(threadInfo.chatId, `${AI_PREFIX} Invalid agent flags: ${err.message}`, replyToId);
    threadInfo.busy = false;
    return;
  }

  if (parsedFlags.flags.alola) {
    threadInfo.alola = buildSessionMetadata(threadInfo, parsedFlags.flags.alola);
    persistThreadsBestEffort();
  } else if (threadInfo.alola) {
    threadInfo.alola = coerceAlolaMetadata(threadInfo.alola, threadInfo);
  }

  const prompt = parsedFlags.prompt;
  const stickyArgs = applyStickyOptions(threadInfo, parsedFlags.harnessArgs);
  const harnessArgs = prepareHarnessArgs(buildHarnessArgs(threadInfo, prompt, stickyArgs));
  const wasResumingHarnessSession = Boolean(threadInfo.isFollowUp && threadInfo.harnessSessionId);

  activeAgents++;

  const target = threadInfo.alola ? `, target: ${describeAlolaTarget(threadInfo.alola)}` : "";
  console.log(
    `[Thread ${threadInfo.rootMessageId}] Spawning local (session: ${threadInfo.sessionId.slice(0, 8)}..., follow-up: ${threadInfo.isFollowUp}${target}, active: ${activeAgents})`
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

    const { result, resetSession } = buildAgentResult(stdout, stderr, code, wasResumingHarnessSession);
    if (resetSession) threadInfo.harnessSessionId = null;
    persistThreadsBestEffort();
    console.log(`[Thread ${threadInfo.rootMessageId}] Done (exit ${code}, ${result.length} chars, active: ${activeAgents})`);

    sendLargeOutput(threadInfo.chatId, result, replyToId);
    processPending(threadInfo, replyToId, maxConcurrent);
  });

  proc.on("error", (err) => {
    clearTimeout(timeout);
    activeAgents--;
    threadInfo.busy = false;
    threadInfo.childPid = null;
    console.error(`[Thread ${threadInfo.rootMessageId}] Spawn error:`, err.message);
    sendToTeams(threadInfo.chatId, `${AI_PREFIX} Failed to start agent: ${err.message}`, replyToId);
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
  applyStickyOptions,
  normalizeBareModel,
  finalizeSession,
  threadSessionDir,
  promptNeedsAlola,
  isTransientProviderStreamFailure,
  buildPromptWithExecutionContext,
  buildAgentResult,
};
