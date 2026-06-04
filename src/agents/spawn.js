const fs = require("fs");
const path = require("path");
const {
  HARNESS_CONFIG,
  MCP_CONFIG,
  AGENT_TIMEOUT_MS,
  ROOT_DIR,
  STATE_DIR,
  loadProjects,
  loadMachines,
  AGENT_RUNTIME_HOST,
  DEPLOYMENT_HOST,
  ALOLA_CONFIG,
  ALOLA_SESSION_BIN,
  resolveWorkspace,
  workspaceFromPersisted,
  attachWorkspace,
} = require("../config/env");
const {
  parseAlolaTarget,
  isAsicToken,
  isGpuToken,
  buildSessionMetadata,
  coerceAlolaMetadata,
  describeAlolaTarget,
} = require("../alola/session");
const { sendToTeams, sendLargeOutput, AI_PREFIX } = require("../teams/io");
const { runHarness, runnerMode } = require("./harness-runner");

const SESSIONS_DIR = path.join(STATE_DIR || ROOT_DIR, "sessions");
const ALOLA_WORK_RE = /\b(build|rebuild|compile|test|ctest|smoke|benchmark|bench|perf|gpu|rocm|hipcc|rocminfo|rocm-smi|cmake|ninja|provider verification|verify providers?|runtime)\b/i;

function workspaceForThread(threadInfo = null) {
  if (threadInfo?.workspaceDir) {
    return workspaceFromPersisted(threadInfo.workspaceId, threadInfo.workspaceDir, threadInfo.workspaceSource || "thread");
  }
  const ws = resolveWorkspace();
  if (threadInfo) attachWorkspace(threadInfo, ws);
  return ws;
}

function existingDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function workspaceRelative(workspace, suffix) {
  return path.join(workspace.dir, suffix);
}

function getProjectDirs(workspace = null) {
  const ws = workspace || resolveWorkspace();
  const projects = loadProjects(ws);
  if (!projects?.projects) return [];

  const dirs = new Set();
  for (const proj of Object.values(projects.projects)) {
    if (proj.path) dirs.add(path.isAbsolute(proj.path) ? proj.path : path.resolve(ws.dir, proj.path));
    for (const wt of Object.values(proj.worktrees || {})) {
      if (wt.path) dirs.add(path.isAbsolute(wt.path) ? wt.path : path.resolve(ws.dir, wt.path));
    }
  }
  return [...dirs].filter((d) => existingDir(d));
}

function buildRoutingContext(threadInfo = null) {
  const os = require("os");
  const workspace = workspaceForThread(threadInfo || {});
  const projects = loadProjects(workspace);
  const machinesData = loadMachines(workspace);
  const reposDir = workspaceRelative(workspace, "repos");
  const worktreesDir = workspaceRelative(workspace, "worktrees");
  const hasRepos = existingDir(reposDir);
  const hasWorktrees = existingDir(worktreesDir);
  const alolaCommand = ALOLA_SESSION_BIN;
  const lines = [
    "## Environment",
    `Controller host: **${AGENT_RUNTIME_HOST || os.hostname()}** (${os.platform()}, ${os.arch()}). Deployment host: **${DEPLOYMENT_HOST || AGENT_RUNTIME_HOST || os.hostname()}**. Home: \`${os.homedir()}\``,
    `Harness working directory: \`${workspace.dir}\` (${workspace.source}). Treat the workspace as opaque; follow its own instructions and registries when present.`,
    "",
    "## Execution routing",
    "- The harness process runs locally on the controller host by default. Use local state for ordinary code reading, editing, review, planning, and research.",
    `- For build/test/benchmark/runtime work, use \`${alolaCommand} run -- <command>\`; default Alola target is login node ${ALOLA_CONFIG.defaultLoginNode} (${ALOLA_CONFIG.defaultAsic}).`,
    `- For a non-login GPU allocation, use \`${alolaCommand} run --target <asic> -- <command>\`; the default constraint is ${ALOLA_CONFIG.defaultConstraintPrefix || "<ASIC>"}&<ASIC_UPPER> and the image template is \`${ALOLA_CONFIG.imageTemplate}\`.`,
    `- For login-node enroot work, home/project paths and ${ALOLA_CONFIG.imageTemplate} are shared, but named enroot rootfses such as ${ALOLA_CONFIG.defaultLoginContainer} are node-local under /var/tmp. If a login node lacks the rootfs, recreate it from the shared image instead of switching nodes permanently.`,
    "- Do not run ROCm builds, CMake/Ninja, ctest, benchmarks, provider verification, GPU runtime checks, hipcc, rocminfo, or rocm-smi directly on the controller host.",
    "- If Alola verification is requested for a branch or patch, do not skip because the default Alola checkout is dirty, on another branch, or at a different path. Fetch/checkout the requested branch on Alola, or create an isolated Alola worktree and run from that path.",
    "- If the patch exists only as uncommitted controller-local edits, first make those edits available in the Alola worktree; never run a different checkout and claim it verifies the local patch.",
  ];

  if (hasRepos || hasWorktrees) {
    lines.push(`- Optional workspace source roots found: ${hasRepos ? `\`${reposDir}\`` : "no repos/"}${hasRepos && hasWorktrees ? " and " : ""}${hasWorktrees ? `\`${worktreesDir}\`` : "no worktrees/"}. Do not assume these paths are mounted inside Alola sessions.`);
  }

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
    lines.push("- No app-level project registry was found. Inspect the selected workspace before assuming project paths.");
  }

  lines.push("");
  lines.push("## Machines");
  if (machinesData?.machines) {
    for (const m of Object.values(machinesData.machines)) {
      const nodes = m.nodes ? ` (nodes: ${m.nodes.join(", ")})` : "";
      lines.push(`- **${m.name}**${nodes} — SSH: \`${m.sshScript} <node> \"<cmd>\"\`, context: \`${m.context}\``);
    }
  } else {
    lines.push("- No app-level machine registry was found. Read workspace machine docs when present.");
  }

  lines.push("");
  lines.push("## Jira: ALMIOPEN→rocm-libraries, THEROCK→therock, MLSE→mlse-tools");
  lines.push("");
  lines.push("Use workspace-local instructions and registries when they exist; otherwise ask for missing project/machine context instead of guessing paths.");

  return lines.join("\n");
}

function safeSessionSegment(value) {
  const safe = String(value || "session").replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "session";
}

function workspaceScopedSessionDir(threadId, workspaceOrThread = null) {
  const workspace = workspaceOrThread?.dir
    ? workspaceOrThread
    : workspaceOrThread?.workspaceDir
      ? workspaceFromPersisted(workspaceOrThread.workspaceId, workspaceOrThread.workspaceDir, workspaceOrThread.workspaceSource || "thread")
      : workspaceForThread(null);
  return path.join(SESSIONS_DIR, safeSessionSegment(workspace.id), safeSessionSegment(threadId));
}

function legacyThreadSessionDir(threadId) {
  return path.join(SESSIONS_DIR, safeSessionSegment(threadId));
}

function migrateLegacySessionDir(threadId, workspaceOrThread = null) {
  const current = workspaceScopedSessionDir(threadId, workspaceOrThread);
  const legacy = legacyThreadSessionDir(threadId);
  if (!existingDir(legacy) || existingDir(current)) return current;
  try {
    fs.mkdirSync(path.dirname(current), { recursive: true });
    fs.cpSync(legacy, current, { recursive: true, errorOnExist: false, force: false });
  } catch (err) {
    console.warn(`[Sessions] Failed to migrate legacy session dir ${legacy} -> ${current}: ${err.message}`);
  }
  return current;
}

function threadSessionDir(threadId, workspaceOrThread = null, options = {}) {
  const dir = options.migrateLegacy === false
    ? workspaceScopedSessionDir(threadId, workspaceOrThread)
    : migrateLegacySessionDir(threadId, workspaceOrThread);
  if (options.create !== false) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function existingThreadSessionDir(threadId, workspaceOrThread = null) {
  const current = threadSessionDir(threadId, workspaceOrThread, { create: false });
  if (existingDir(current)) return current;
  const legacy = legacyThreadSessionDir(threadId);
  if (existingDir(legacy)) return legacy;
  return current;
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

function finalizeThreadSession(threadInfo, threadId = null) {
  const id = threadId || threadInfo.rootMessageId;
  return finalizeSession(existingThreadSessionDir(id, threadInfo));
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

function inferAlolaTarget(threadInfo, prompt) {
  const explicitTarget = coerceAlolaMetadata(threadInfo.alola, threadInfo);
  return explicitTarget || (promptNeedsAlola(prompt) ? buildSessionMetadata(threadInfo, parseAlolaTarget([])) : null);
}

function buildPromptWithExecutionContext(threadInfo, prompt) {
  const inferredTarget = inferAlolaTarget(threadInfo, prompt);
  if (!inferredTarget) return prompt;

  const target = targetArg(inferredTarget);
  const targetFlag = target === "default" ? "" : ` --target ${target}`;
  const workspace = workspaceForThread(threadInfo);
  const lines = [
    "[Execution routing]",
    "The harness stays local to the controller host. Run ROCm build/test/benchmark/runtime commands through a durable Alola session, not directly on the controller host.",
    `Harness working directory: ${workspace.dir}`,
    `Target: ${describeAlolaTarget(inferredTarget)}.`,
    `Use \`${ALOLA_SESSION_BIN} run${targetFlag} -- <command>\` for CMake/Ninja/ctest/hipcc/rocminfo/rocm-smi/provider-verification work.`,
    `Alola home/project paths and images are shared, but login-node enroot rootfses such as ${inferredTarget.container || ALOLA_CONFIG.defaultLoginContainer} are node-local under /var/tmp; if \`enroot list\` lacks the target container, recreate it from the shared image and retry.`,
    "Do not assume workspace-local repos or worktrees are mounted inside Alola sessions.",
    "Do not skip requested Alola verification because the default Alola checkout is dirty, on another branch, or at a different path; fetch/checkout the requested branch or create an isolated Alola worktree, then run from that path.",
    "If the patch exists only as uncommitted local edits, first make those edits available in the Alola worktree; otherwise report that exact missing prerequisite instead of verifying the wrong checkout.",
  ];
  if (inferredTarget.mode === "gpu") {
    lines.push(`GPU allocation is non-exclusive, image ${inferredTarget.image}, constraint ${inferredTarget.constraint}, timeout ${inferredTarget.timeLimit}.`);
  }
  return `${lines.join("\n")}\n\n${prompt}`;
}

function defaultModelForPrompt(threadInfo, prompt) {
  const usesAlola = Boolean(inferAlolaTarget(threadInfo, prompt));
  if (usesAlola) {
    return threadInfo.alolaDefaultModel || threadInfo.defaultModel || HARNESS_CONFIG.alolaDefaultModel || HARNESS_CONFIG.defaultModel;
  }
  return threadInfo.defaultModel || HARNESS_CONFIG.defaultModel;
}

function buildHarnessArgs(threadInfo, prompt, harnessArgs = []) {
  const workspace = workspaceForThread(threadInfo);
  const args = Array.from(HARNESS_CONFIG.baseArgs);
  const finalPrompt = buildPromptWithExecutionContext(threadInfo, prompt);
  const defaultModel = defaultModelForPrompt(threadInfo, prompt);

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
    args.push(HARNESS_CONFIG.flags.sessionDir, threadSessionDir(threadInfo.rootMessageId, workspace));
  }

  if (HARNESS_CONFIG.skipPermissions && HARNESS_CONFIG.flags.skipPermissions) {
    args.push(HARNESS_CONFIG.flags.skipPermissions);
  }

  args.push(...withDefaultModel(harnessArgs, defaultModel));

  if (HARNESS_CONFIG.flags.prompt) {
    args.push(HARNESS_CONFIG.flags.prompt, finalPrompt);
  } else {
    args.push(finalPrompt);
  }

  return args;
}

function prepareHarnessArgs(baseArgs, workspaceOrThread = null) {
  const workspace = workspaceOrThread?.dir
    ? workspaceOrThread
    : workspaceOrThread?.workspaceDir
      ? workspaceFromPersisted(workspaceOrThread.workspaceId, workspaceOrThread.workspaceDir, workspaceOrThread.workspaceSource || "thread")
      : resolveWorkspace();
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
    for (const dir of getProjectDirs(workspace)) {
      args.splice(insertAt, 0, HARNESS_CONFIG.flags.addDir, dir);
      insertAt += 2;
    }
  }

  return args;
}

const activeAgents = new Map();
function concurrencyKey(threadInfo) {
  return threadInfo.chatId || threadInfo.workspaceId || "default";
}

function activeCountFor(threadInfo) {
  return activeAgents.get(concurrencyKey(threadInfo)) || 0;
}

function incrementActive(threadInfo) {
  const key = concurrencyKey(threadInfo);
  activeAgents.set(key, (activeAgents.get(key) || 0) + 1);
}

function decrementActive(threadInfo) {
  const key = concurrencyKey(threadInfo);
  const next = Math.max(0, (activeAgents.get(key) || 0) - 1);
  if (next) activeAgents.set(key, next);
  else activeAgents.delete(key);
}

function acquireAgentSlot(threadInfo, maxConcurrent) {
  if (activeCountFor(threadInfo) >= maxConcurrent) return false;
  incrementActive(threadInfo);
  return true;
}

function releaseAgentSlot(threadInfo) {
  decrementActive(threadInfo);
}


function processPending(threadInfo, replyToId, maxConcurrent) {
  if (!threadInfo.hasPending) return;
  threadInfo.hasPending = false;
  const { gatherThreadMessages } = require("../teams/threads");
  const text = gatherThreadMessages(threadInfo);
  if (!text) return;
  threadInfo.isFollowUp = true;
  threadInfo.busy = true;
  console.log(`[Thread ${threadInfo.rootMessageId}] Processing queued messages: "${text.slice(0, 60)}"`);
  sendToTeams(threadInfo.chatId, `${AI_PREFIX} 🚀 Processing...`, replyToId);
  spawnAgent(threadInfo, text, replyToId, maxConcurrent);
}

function persistThreadsBestEffort() {
  try { require("../teams/threads").saveThreadsToDisk(); } catch {}
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

  const workspace = workspaceForThread(threadInfo);
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
  const harnessArgs = prepareHarnessArgs(buildHarnessArgs(threadInfo, prompt, stickyArgs), workspace);
  const wasResumingHarnessSession = Boolean(threadInfo.isFollowUp && threadInfo.harnessSessionId);
  const includeAlola = Boolean(inferAlolaTarget(threadInfo, prompt));

  if (!acquireAgentSlot(threadInfo, maxConcurrent)) {
    sendToTeams(threadInfo.chatId, `${AI_PREFIX} ⏳ Too many agents running. Please wait...`, replyToId);
    threadInfo.busy = false;
    return;
  }

  const target = threadInfo.alola ? `, target: ${describeAlolaTarget(threadInfo.alola)}` : "";
  console.log(
    `[Thread ${threadInfo.rootMessageId}] Spawning ${runnerMode()} (session: ${threadInfo.sessionId.slice(0, 8)}..., workspace: ${workspace.id}, follow-up: ${threadInfo.isFollowUp}${target}, active: ${activeCountFor(threadInfo)}/${maxConcurrent})`
  );

  threadInfo.childPid = null;
  runHarness(harnessArgs, {
    cwd: workspace.dir,
    includeAlola,
    timeoutMs: AGENT_TIMEOUT_MS,
    onStart: (pid) => { threadInfo.childPid = pid || null; },
  }).then(({ stdout = "", stderr = "", code = null }) => {
    releaseAgentSlot(threadInfo);
    threadInfo.busy = false;
    threadInfo.childPid = null;

    if (HARNESS_CONFIG.flags.sessionDir && threadInfo.rootMessageId) {
      const sid = finalizeThreadSession(threadInfo);
      if (sid) {
        threadInfo.harnessSessionId = sid;
        console.log(`[Thread ${threadInfo.rootMessageId}] Session: ${sid.slice(0, 12)}...`);
      }
    }

    const { result, resetSession } = buildAgentResult(stdout, stderr, code, wasResumingHarnessSession);
    if (resetSession) threadInfo.harnessSessionId = null;
    persistThreadsBestEffort();
    console.log(`[Thread ${threadInfo.rootMessageId}] Done (exit ${code}, ${result.length} chars, active: ${activeCountFor(threadInfo)}/${maxConcurrent})`);

    sendLargeOutput(threadInfo.chatId, result, replyToId);
    processPending(threadInfo, replyToId, maxConcurrent);
  }).catch((err) => {
    releaseAgentSlot(threadInfo);
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
  finalizeThreadSession,
  threadSessionDir,
  legacyThreadSessionDir,
  migrateLegacySessionDir,
  activeCountFor,
  acquireAgentSlot,
  releaseAgentSlot,
  existingThreadSessionDir,
  workspaceForThread,
  promptNeedsAlola,
  isTransientProviderStreamFailure,
  buildPromptWithExecutionContext,
  buildAgentResult,
  defaultModelForPrompt,
};
