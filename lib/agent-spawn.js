const { spawn } = require("child_process");
const fs = require("fs");
const {
  CLAUDE_BIN,
  WORKSPACE_DIR,
  MCP_CONFIG,
  AGENT_TIMEOUT_MS,
  loadProjects,
} = require("./config");
const { sendToTeams, sendLargeOutput } = require("./teams-io");

function buildRoutingContext() {
  const projects = loadProjects();
  if (!projects) return "";

  const lines = ["## Project & Machine Context\n"];

  for (const [key, proj] of Object.entries(projects.projects)) {
    const aliases = (proj.aliases || []).join(", ");
    lines.push(`**${proj.name}** (${aliases}) — \`${proj.path}\``);
    if (proj.components) lines.push(`  Components: ${proj.components.join(", ")}`);
    if (proj.subprojects) lines.push(`  Subprojects: ${proj.subprojects.join(", ")}`);
    const wts = Object.entries(proj.worktrees || {});
    if (wts.length > 0) {
      const wtList = wts.map(([n, w]) => `${n}: \`${w.path}\` (${w.branch})`);
      lines.push(`  Worktrees: ${wtList.join("; ")}`);
    }
    lines.push("");
  }

  lines.push("### Remote Machines");

  let machinesData;
  try {
    const machinesPath = require("path").join(WORKSPACE_DIR, ".claude/registry/machines.json");
    machinesData = JSON.parse(fs.readFileSync(machinesPath, "utf8"));
  } catch {}

  if (machinesData) {
    for (const [key, m] of Object.entries(machinesData.machines)) {
      lines.push(`- **/${key}**: ${m.host} — SSH via \`${WORKSPACE_DIR}/${m.sshScript} "<cmd>"\``);
    }
  }

  lines.push("");
  lines.push("### Jira Mapping");
  lines.push("- ALMIOPEN → rocm-libraries (base: develop)");
  lines.push("- THEROCK → therock (base: main)");
  lines.push("- MLSE → mlse-tools (base: main)");
  lines.push("");
  lines.push("Use `/goto <project>` to navigate. Use specialist subagents (commit, therock-builder, worktree-setup, hipdnn-build-test) when appropriate.");

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

  const flagPattern = /^--(\w[\w-]*)\s+(\S+)\s*/;
  let match;
  while ((match = remaining.match(flagPattern))) {
    flags[match[1]] = match[2];
    remaining = remaining.slice(match[0].length);
  }

  return { flags, prompt: remaining };
}

function buildAgentArgs(threadInfo, message) {
  const { flags, prompt } = extractFlags(message);
  const args = ["--print"];

  if (threadInfo.isFollowUp) {
    args.push("--resume", threadInfo.sessionId);
  } else {
    args.push("--session-id", threadInfo.sessionId);
    args.push("--append-system-prompt", buildRoutingContext());
  }

  args.push("--dangerously-skip-permissions");

  if (flags.model) args.push("--model", flags.model);
  if (flags.effort) args.push("--effort", flags.effort);

  if (fs.existsSync(MCP_CONFIG)) {
    args.push("--mcp-config", MCP_CONFIG);
  }

  for (const dir of getProjectDirs()) {
    args.push("--add-dir", dir);
  }

  args.push("-p", prompt);
  return args;
}

let activeAgents = 0;

function spawnAgent(threadInfo, message, replyToId, maxConcurrent = 3) {
  if (activeAgents >= maxConcurrent) {
    sendToTeams("⏳ Too many agents running. Please wait...", replyToId);
    threadInfo.busy = false;
    return;
  }

  const args = buildAgentArgs(threadInfo, message);
  activeAgents++;

  console.log(
    `[Thread ${threadInfo.rootMessageId}] Spawning claude (session: ${threadInfo.sessionId.slice(0, 8)}..., follow-up: ${threadInfo.isFollowUp}, active: ${activeAgents})`
  );

  const proc = spawn(CLAUDE_BIN, args, {
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

module.exports = { spawnAgent, buildRoutingContext, getProjectDirs };
