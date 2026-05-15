const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const { CHAT_ID, ROOT_DIR, MAX_CONCURRENT_AGENTS } = require("./config");
const { sendToTeams, stripHtml, isBotMessage, fetchMessages } = require("./teams-io");
const { spawnAgent } = require("./agent-spawn");

const POLLS_FILE = path.join(ROOT_DIR, "polls.json");
const polls = new Map();

// Track poll result threads so replies resume the right session
// Maps result thread root message ID -> poll ID
const pollResultThreads = new Map();

function parseInterval(str) {
  const match = str.match(/^(\d+)(m|h|d|w)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  return n * multipliers[unit];
}

function parsePollCommand(text) {
  const match = text.match(/^\/poll\s+(\d+[mhdw])\s+([\s\S]+)$/);
  if (!match) return null;
  const intervalMs = parseInterval(match[1]);
  if (!intervalMs) return null;
  return { intervalStr: match[1], intervalMs, prompt: match[2].trim() };
}

function savePollsToDisk() {
  const data = [];
  for (const [id, poll] of polls) {
    data.push({
      id,
      prompt: poll.prompt,
      intervalMs: poll.intervalMs,
      intervalStr: poll.intervalStr,
      sessionId: poll.sessionId,
      from: poll.from,
      createdAt: poll.createdAt,
      lastRun: poll.lastRun,
      active: poll.active,
    });
  }
  fs.writeFileSync(POLLS_FILE, JSON.stringify(data, null, 2));
}

function loadPollsFromDisk() {
  if (!fs.existsSync(POLLS_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(POLLS_FILE, "utf8"));
    for (const p of data) {
      if (!p.active) continue;
      polls.set(p.id, {
        ...p,
        busy: false,
        currentResultThread: null,
      });
    }
    console.log(`[Polls] Loaded ${polls.size} active polls from disk`);
  } catch {}
}

function createPoll(text, from, originThreadId) {
  const parsed = parsePollCommand(text);
  if (!parsed) return false;

  const id = randomUUID().slice(0, 8);
  const poll = {
    id,
    prompt: parsed.prompt,
    intervalMs: parsed.intervalMs,
    intervalStr: parsed.intervalStr,
    sessionId: randomUUID(),
    from,
    createdAt: new Date().toISOString(),
    lastRun: null,
    active: true,
    busy: false,
    currentResultThread: null,
  };

  polls.set(id, poll);
  savePollsToDisk();

  console.log(`[Poll ${id}] Created: every ${parsed.intervalStr}, prompt: "${parsed.prompt.slice(0, 60)}"`);

  sendToTeams(
    `🔄 <b>Poll created</b> (id: ${id})<br>` +
      `<b>Interval:</b> every ${parsed.intervalStr}<br>` +
      `<b>Prompt:</b> ${parsed.prompt.slice(0, 200)}<br><br>` +
      `First run starting now. Results will be posted as new threads.`,
    originThreadId
  );

  runPoll(poll);
  return true;
}

function cancelPoll(text) {
  const match = text.match(/^\/poll-cancel\s+(\S+)/);
  if (!match) return false;
  const id = match[1];
  const poll = polls.get(id);
  if (!poll) return false;
  poll.active = false;
  polls.delete(id);
  savePollsToDisk();
  console.log(`[Poll ${id}] Cancelled`);
  return true;
}

function runPoll(poll) {
  if (!poll.active || poll.busy) return;

  poll.busy = true;
  poll.lastRun = new Date().toISOString();
  savePollsToDisk();

  console.log(`[Poll ${poll.id}] Running: "${poll.prompt.slice(0, 60)}"`);

  const threadInfo = {
    rootMessageId: null,
    sessionId: poll.sessionId,
    from: `poll:${poll.id}`,
    startTime: new Date(),
    isFollowUp: poll.lastRun !== null,
    busy: true,
    lastSeen: null,
    childPid: null,
  };

  const claudePath = require("./config").CLAUDE_BIN;
  const { spawn } = require("child_process");
  const agentSpawn = require("./agent-spawn");

  // Build args manually to handle the poll's session
  const args = ["--print", "--dangerously-skip-permissions"];

  if (threadInfo.isFollowUp) {
    args.push("--resume", poll.sessionId);
  } else {
    args.push("--session-id", poll.sessionId);
    args.push("--append-system-prompt", agentSpawn.buildRoutingContext());
  }

  const fsMod = require("fs");
  const config = require("./config");
  if (fsMod.existsSync(config.MCP_CONFIG)) {
    args.push("--mcp-config", config.MCP_CONFIG);
  }

  for (const dir of agentSpawn.getProjectDirs()) {
    args.push("--add-dir", dir);
  }

  args.push("-p", poll.prompt);

  const proc = spawn(claudePath, args, {
    cwd: config.WORKSPACE_DIR,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const timeout = setTimeout(() => {
    proc.kill("SIGTERM");
  }, config.AGENT_TIMEOUT_MS);

  proc.on("close", (code) => {
    clearTimeout(timeout);
    poll.busy = false;

    const result = stdout || stderr || "(no output)";
    console.log(`[Poll ${poll.id}] Done (exit ${code}, ${result.length} chars)`);

    const { markdownToHtml } = require("./teams-io");
    const header = `🔄 <b>Poll: ${poll.id}</b> (every ${poll.intervalStr})<br><hr>`;

    // Post as a new top-level thread
    const { execSync } = require("child_process");
    try {
      const html = markdownToHtml ? markdownToHtml(result) : result;
      const fullMessage = `${header}${html}`;
      const sendResult = execSync(
        `python3 ${config.SCRIPTS_DIR}/send_chat.py --chat-id "${CHAT_ID}" -m ${JSON.stringify(fullMessage)} --html --json`,
        { timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }
      );
      try {
        const parsed = JSON.parse(sendResult.toString());
        if (parsed.message_id) {
          pollResultThreads.set(parsed.message_id, poll.id);
        }
      } catch {}
    } catch (err) {
      console.error(`[Poll ${poll.id}] Failed to post result:`, err.message);
    }
  });

  proc.on("error", () => {
    clearTimeout(timeout);
    poll.busy = false;
  });
}

function tickPolls() {
  const now = Date.now();
  for (const [id, poll] of polls) {
    if (!poll.active || poll.busy) continue;
    const lastRun = poll.lastRun ? new Date(poll.lastRun).getTime() : 0;
    if (now - lastRun >= poll.intervalMs) {
      runPoll(poll);
    }
  }
}

function getPollForResultThread(messageId) {
  const pollId = pollResultThreads.get(messageId);
  if (!pollId) return null;
  return polls.get(pollId) || null;
}

function getPolls() {
  return polls;
}

module.exports = {
  parsePollCommand,
  createPoll,
  cancelPoll,
  tickPolls,
  loadPollsFromDisk,
  getPolls,
  getPollForResultThread,
  pollResultThreads,
};
