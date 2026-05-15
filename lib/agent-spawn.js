const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  CLAUDE_BIN,
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

const ROUTING_CONTEXT_FILE = path.join(WORKSPACE_DIR, ".claude", "routing-context.md");

function writeRoutingContextFile() {
  const context = buildRoutingContext();
  fs.mkdirSync(path.dirname(ROUTING_CONTEXT_FILE), { recursive: true });
  fs.writeFileSync(ROUTING_CONTEXT_FILE, context);
  return ROUTING_CONTEXT_FILE;
}

function buildClaudeArgs(threadInfo, prompt, flags, { useFile = false } = {}) {
  const args = ["--print"];

  if (threadInfo.isFollowUp) {
    args.push("--resume", threadInfo.sessionId);
  } else {
    args.push("--session-id", threadInfo.sessionId);
    if (useFile) {
      writeRoutingContextFile();
      args.push("--append-system-prompt-file", ROUTING_CONTEXT_FILE);
    } else {
      args.push("--append-system-prompt", buildRoutingContext());
    }
  }

  args.push("--dangerously-skip-permissions");

  if (flags.model) args.push("--model", flags.model);
  if (flags.effort) args.push("--effort", flags.effort);

  args.push("-p", prompt);
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
    execSync(
      `${script} ${node} "enroot create -n ${containerName} ${DEFAULT_ALOLA_IMAGE}"`,
      { timeout: 120000, stdio: ["ignore", "pipe", "pipe"] }
    );
    console.log(`[Alola] Container ${containerName} created`);
    return true;
  } catch (err) {
    console.error(`[Alola] Failed to ensure container: ${err.message}`);
    return false;
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

function writeAlolaRunScript(threadInfo, prompt, flags, containerName) {
  const sessionSlug = threadInfo.sessionId.slice(0, 8);
  const runScriptPath = path.join(WORKSPACE_DIR, ".claude", `run-${sessionSlug}.sh`);
  const promptFilePath = path.join(WORKSPACE_DIR, ".claude", `prompt-${sessionSlug}.txt`);

  // Write prompt to a separate file to avoid all quoting issues
  fs.writeFileSync(promptFilePath, prompt);

  // Build claude args without -p (prompt comes from file)
  const claudeArgs = ["--print", "--dangerously-skip-permissions"];

  if (threadInfo.isFollowUp) {
    claudeArgs.push("--resume", threadInfo.sessionId);
  } else {
    writeRoutingContextFile();
    claudeArgs.push("--session-id", threadInfo.sessionId);
    claudeArgs.push("--append-system-prompt-file", ROUTING_CONTEXT_FILE);
  }

  if (flags.model) claudeArgs.push("--model", flags.model);
  if (flags.effort) claudeArgs.push("--effort", flags.effort);

  const argsStr = claudeArgs.map((a) => `"${a}"`).join(" ");

  const script = [
    "#!/bin/bash",
    "set -e",
    "cd ~/ROCm-workspace && git pull --ff-only -q 2>/dev/null || true",
    `PROMPT=$(cat "${promptFilePath}")`,
    `enroot start --rw --mount "$HOME:$HOME" ${containerName} -- \\`,
    `  bash -c "cd ~/ROCm-workspace && claude ${argsStr} -p \\"\$PROMPT\\""`,
  ].join("\n");

  fs.writeFileSync(runScriptPath, script + "\n");
  fs.chmodSync(runScriptPath, "755");
  return runScriptPath;
}

function spawnAlolaAgent(threadInfo, message, replyToId, maxConcurrent) {
  const { flags, prompt } = extractFlags(message);
  const node = flags.alola || DEFAULT_ALOLA_NODE;
  const containerName = alolaContainerName(threadInfo.sessionId);

  if (!threadInfo.isFollowUp) {
    sendToTeams(`🚀 Starting on Alola node ${node}...`, replyToId);
  }

  if (!ensureAlolaContainer(node, containerName)) {
    sendToTeams(`Failed to create container on Alola node ${node}`, replyToId);
    threadInfo.busy = false;
    return;
  }

  const runScript = writeAlolaRunScript(threadInfo, prompt, flags, containerName);

  const script = sshScript();
  activeAgents++;
  threadInfo.alola = { node, containerName };

  console.log(
    `[Thread ${threadInfo.rootMessageId}] Spawning on Alola ${node} (container: ${containerName}, session: ${threadInfo.sessionId.slice(0, 8)}..., active: ${activeAgents})`
  );

  const proc = spawn(script, [node, `bash ${runScript}`], {
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

    // Clean up temp files
    try { fs.unlinkSync(runScript); } catch {}
    try { fs.unlinkSync(path.join(WORKSPACE_DIR, ".claude", `prompt-${threadInfo.sessionId.slice(0, 8)}.txt`)); } catch {}

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
  const { flags } = extractFlags(message);
  if (flags.alola || threadInfo.alola) {
    if (!flags.alola && threadInfo.alola) {
      // Follow-up in an alola thread — re-add the flag
      message = `--alola ${threadInfo.alola.node} ${message}`;
    }
    spawnAlolaAgent(threadInfo, message, replyToId, maxConcurrent);
    return;
  }

  // Local spawn
  const { prompt } = extractFlags(message);
  const claudeArgs = buildClaudeArgs(threadInfo, prompt, flags);

  if (fs.existsSync(MCP_CONFIG)) {
    claudeArgs.splice(claudeArgs.indexOf("-p"), 0, "--mcp-config", MCP_CONFIG);
  }

  for (const dir of getProjectDirs()) {
    claudeArgs.splice(claudeArgs.indexOf("-p"), 0, "--add-dir", dir);
  }

  activeAgents++;

  console.log(
    `[Thread ${threadInfo.rootMessageId}] Spawning local (session: ${threadInfo.sessionId.slice(0, 8)}..., follow-up: ${threadInfo.isFollowUp}, active: ${activeAgents})`
  );

  const proc = spawn(CLAUDE_BIN, claudeArgs, {
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

module.exports = { spawnAgent, buildRoutingContext, getProjectDirs, extractFlags, removeAlolaContainer, alolaContainers };
