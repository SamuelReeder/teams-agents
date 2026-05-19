const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  CHAT_ID,
  ROOT_DIR,
  HARNESS_BIN,
  WORKSPACE_DIR,
  AGENT_TIMEOUT_MS,
  SCRIPTS_DIR,
} = require("./config");
const { sendToTeams } = require("./teams-io");

const POLLS_FILE = path.join(ROOT_DIR, "polls.json");
const DEFAULT_MAX_RUNS = 20;
const polls = new Map();
const pollResultThreads = new Map();

let tickTimer = null;

function parseInterval(str) {
  const match = str.match(/^(\d+)(m|h|d|w)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const multipliers = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  return n * multipliers[match[2]];
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
      runCount: poll.runCount,
      maxRuns: poll.maxRuns,
      originThreadId: poll.originThreadId,
      model: poll.model || null,
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
        model: p.model || null,
        busy: false,
      });
    }
    console.log(`[Polls] Loaded ${polls.size} active polls from disk`);
    scheduleNextTick();
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
    model: null,
    runCount: 0,
    maxRuns: DEFAULT_MAX_RUNS,
    originThreadId,
  };

  polls.set(id, poll);
  savePollsToDisk();

  console.log(`[Poll ${id}] Created: every ${parsed.intervalStr}, max ${poll.maxRuns} runs, prompt: "${parsed.prompt.slice(0, 60)}"`);

  sendToTeams(
    `🔄 <b>Poll created</b> (id: <code>${id}</code>)<br>` +
      `<b>Interval:</b> every ${parsed.intervalStr}<br>` +
      `<b>Max runs:</b> ${poll.maxRuns}<br>` +
      `<b>Prompt:</b> ${parsed.prompt.slice(0, 200)}<br><br>` +
      `First run starting now. Results will be posted as new threads.<br>` +
      `Cancel with <code>/poll-cancel ${id}</code>. Restart with <code>/poll-restart ${id}</code>.`,
    originThreadId
  );

  runPoll(poll);
  scheduleNextTick();
  return true;
}

function cancelPoll(text) {
  const match = text.match(/^\/poll-cancel\s+(\S+)/);
  if (!match) return false;
  const id = match[1];
  const poll = polls.get(id);
  if (!poll) return false;
  poll.active = false;
  savePollsToDisk();
  console.log(`[Poll ${id}] Cancelled`);
  scheduleNextTick();
  return true;
}

function restartPoll(text, originThreadId) {
  const match = text.match(/^\/poll-restart\s+(\S+)/);
  if (!match) return false;
  const id = match[1];
  const poll = polls.get(id);
  if (!poll) return false;

  poll.active = true;
  poll.runCount = 0;
  poll.sessionId = randomUUID();
  poll.lastRun = null;
  savePollsToDisk();

  console.log(`[Poll ${id}] Restarted`);

  sendToTeams(
    `🔄 <b>Poll ${id} restarted</b> — ${poll.maxRuns} runs remaining. Running now.`,
    originThreadId
  );

  runPoll(poll);
  scheduleNextTick();
  return true;
}

function expirePoll(poll) {
  poll.active = false;
  savePollsToDisk();

  console.log(`[Poll ${poll.id}] Expired after ${poll.runCount} runs`);

  sendToTeams(
    `⏹️ <b>Poll ${poll.id} expired</b> after ${poll.runCount}/${poll.maxRuns} runs.<br>` +
      `Restart with <code>/poll-restart ${poll.id}</code>.`,
    poll.originThreadId
  );
}

function runPoll(poll) {
  if (!poll.active || poll.busy) return;

  if (poll.runCount >= poll.maxRuns) {
    expirePoll(poll);
    return;
  }

  poll.busy = true;
  poll.runCount++;
  poll.lastRun = new Date().toISOString();

  console.log(`[Poll ${poll.id}] Run ${poll.runCount}/${poll.maxRuns}: "${poll.prompt.slice(0, 60)}"`);


  const { spawn } = require("child_process");
  const agentSpawn = require("./agent-spawn");


  const threadInfo = {
    sessionId: poll.sessionId,
    isFollowUp: poll.runCount > 1,
    model: poll.model || null,
  };

  const args = agentSpawn.prepareHarnessArgs(
    agentSpawn.buildHarnessArgs(threadInfo, poll.prompt, {})
  );
  poll.model = threadInfo.model || poll.model || null;
  savePollsToDisk();
  const proc = spawn(HARNESS_BIN, args, {
    cwd: WORKSPACE_DIR,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const timeout = setTimeout(() => {
    proc.kill("SIGTERM");
  }, AGENT_TIMEOUT_MS);

  proc.on("close", (code) => {
    clearTimeout(timeout);
    poll.busy = false;

    const result = stdout || stderr || "(no output)";
    console.log(`[Poll ${poll.id}] Done run ${poll.runCount}/${poll.maxRuns} (exit ${code}, ${result.length} chars)`);

    const { markdownToHtml } = require("./teams-io");
    const remaining = poll.maxRuns - poll.runCount;
    const header =
      `🔄 <b>Poll: ${poll.id}</b> (every ${poll.intervalStr}, run ${poll.runCount}/${poll.maxRuns})<br><hr>`;

    const { execSync } = require("child_process");
    try {
      const html = markdownToHtml ? markdownToHtml(result) : result;
      const fullMessage = `${header}${html}`;
      const sendResult = execSync(
        `python3 ${SCRIPTS_DIR}/send_chat.py --chat-id "${CHAT_ID}" -m ${JSON.stringify(fullMessage)} --html --json`,
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

    scheduleNextTick();
  });

  proc.on("error", () => {
    clearTimeout(timeout);
    poll.busy = false;
    scheduleNextTick();
  });
}

function scheduleNextTick() {
  if (tickTimer) clearTimeout(tickTimer);

  const now = Date.now();
  let soonest = Infinity;

  for (const [, poll] of polls) {
    if (!poll.active || poll.busy) continue;
    if (poll.runCount >= poll.maxRuns) continue;
    const lastRun = poll.lastRun ? new Date(poll.lastRun).getTime() : 0;
    const nextDue = lastRun + poll.intervalMs;
    const delay = nextDue - now;
    if (delay < soonest) soonest = delay;
  }

  if (soonest === Infinity) {
    console.log("[Polls] No active polls — ticker idle");
    return;
  }

  const delayMs = Math.max(soonest, 1000);
  console.log(`[Polls] Next tick in ${(delayMs / 1000).toFixed(0)}s`);

  tickTimer = setTimeout(() => {
    for (const [, poll] of polls) {
      if (!poll.active || poll.busy) continue;
      const lastRun = poll.lastRun ? new Date(poll.lastRun).getTime() : 0;
      if (Date.now() - lastRun >= poll.intervalMs) {
        runPoll(poll);
      }
    }
    scheduleNextTick();
  }, delayMs);
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
  restartPoll,
  loadPollsFromDisk,
  getPolls,
  getPollForResultThread,
  pollResultThreads,
};
