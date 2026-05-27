const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  CHAT_ID,
  ROOT_DIR,
  STATE_DIR,
  HARNESS_BIN,
  WORKSPACE_DIR,
  AGENT_TIMEOUT_MS,
  SCRIPTS_DIR,
} = require("./config");
// CHAT_ID kept for backward compat migration of polls without chatId
const { sendToTeams } = require("./teams-io");
const { buildSessionMetadata, coerceAlolaMetadata } = require("./alola-session");

const POLLS_FILE = path.join(STATE_DIR || ROOT_DIR, "polls.json");
const DEFAULT_MAX_RUNS = 20;
const polls = new Map();
const pollResultThreads = new Map();
const RESULT_THREAD_KEY_SEPARATOR = "\0";

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

function pollBelongsToChat(poll, chatId) {
  return (poll.chatId || CHAT_ID || null) === (chatId || null);
}

function resultThreadKey(chatId, messageId) {
  return `${chatId || ""}${RESULT_THREAD_KEY_SEPARATOR}${messageId}`;
}

function resultThreadMessageId(key) {
  const separator = key.indexOf(RESULT_THREAD_KEY_SEPARATOR);
  return separator === -1 ? key : key.slice(separator + 1);
}

function rememberPollResultThread(chatId, messageId, pollId) {
  pollResultThreads.set(resultThreadKey(chatId, messageId), pollId);
}

function hasPollResultThread(messageId, chatId) {
  return pollResultThreads.has(resultThreadKey(chatId, messageId));
}

function savePollsToDisk() {
  const data = [];
  for (const [id, poll] of polls) {
    const resultThreadIds = [];
    for (const [resultThreadId, pId] of pollResultThreads) {
      if (pId === id) resultThreadIds.push(resultThreadMessageId(resultThreadId));
    }
    data.push({
      id,
      chatId: poll.chatId || null,
      prompt: poll.prompt,
      harnessArgs: poll.harnessArgs || undefined,
      intervalMs: poll.intervalMs,
      intervalStr: poll.intervalStr,
      sessionId: poll.sessionId,
      harnessSessionId: poll.harnessSessionId || null,
      model: poll.model || null,
      alola: coerceAlolaMetadata(poll.alola, poll) || null,
      fresh: !!poll.fresh,
      from: poll.from,
      createdAt: poll.createdAt,
      lastRun: poll.lastRun,
      active: poll.active,
      runCount: poll.runCount,
      maxRuns: poll.maxRuns,
      originThreadId: poll.originThreadId,
      resultThreadIds,
    });
  }
  fs.writeFileSync(POLLS_FILE, JSON.stringify(data, null, 2));
}

function loadPollsFromDisk() {
  if (!fs.existsSync(POLLS_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(POLLS_FILE, "utf8"));
    for (const p of data) {
      const chatId = p.chatId || CHAT_ID || null;
      if (p.resultThreadIds) {
        for (const msgId of p.resultThreadIds) {
          rememberPollResultThread(chatId, msgId, p.id);
        }
      }
      if (!p.active) {
        polls.set(p.id, { ...p, chatId, busy: false });
        continue;
      }
      polls.set(p.id, {
        ...p,
        chatId,
        busy: false,
      });
    }
    const activeCount = [...polls.values()].filter((p) => p.active).length;
    console.log(`[Polls] Loaded ${activeCount} active polls (${polls.size} total) from disk`);
    scheduleNextTick();
  } catch {}
}

function createPoll(chatId, text, from, originThreadId) {
  const parsed = parsePollCommand(text);
  if (!parsed) return false;

  const agentSpawn = require("./agent-spawn");
  const { flags, harnessArgs, prompt } = agentSpawn.extractFlags(parsed.prompt);

  // Detect --fresh as a cron-specific option (consumed here, not forwarded to harness)
  const freshIdx = harnessArgs.indexOf("--fresh");
  const fresh = freshIdx !== -1;
  if (fresh) harnessArgs.splice(freshIdx, 1);

  const threadInfo = {};
  const stickyArgs = agentSpawn.applyStickyOptions(threadInfo, harnessArgs);

  const id = randomUUID().slice(0, 8);
  const pollSessionId = randomUUID();
  const alola = flags.alola
    ? buildSessionMetadata({ rootMessageId: `poll-${id}`, sessionId: pollSessionId }, flags.alola)
    : null;
  const poll = {
    id,
    chatId,
    prompt: prompt,
    harnessArgs: stickyArgs.length > 0 ? stickyArgs : undefined,
    intervalMs: parsed.intervalMs,
    intervalStr: parsed.intervalStr,
    sessionId: pollSessionId,
    model: threadInfo.model || null,
    alola,
    fresh,
    from,
    createdAt: new Date().toISOString(),
    lastRun: null,
    active: true,
    busy: false,
    runCount: 0,
    maxRuns: DEFAULT_MAX_RUNS,
    originThreadId,
  };

  polls.set(id, poll);
  savePollsToDisk();

  console.log(`[Poll ${id}] Created: every ${parsed.intervalStr}, max ${poll.maxRuns} runs, model: ${poll.model || "default"}, fresh: ${fresh}, prompt: "${poll.prompt.slice(0, 60)}"`);

  const modelLine = poll.model ? `<b>Model:</b> ${poll.model}<br>` : "";
  const freshLine = fresh ? `<b>Mode:</b> fresh (no session memory across runs)<br>` : "";
  sendToTeams(chatId,
    `🔄 <b>Cron created</b> (id: <code>${id}</code>)<br>` +
      `<b>Interval:</b> every ${parsed.intervalStr}<br>` +
      modelLine +
      freshLine +
      `<b>Max runs:</b> ${poll.maxRuns}<br>` +
      `<b>Prompt:</b> ${poll.prompt.slice(0, 200)}<br><br>` +
      `First run starting now. Results will be posted as new threads.<br>` +
      `Cancel with <code>!cron-cancel ${id}</code>. Restart with <code>!cron-restart ${id}</code>.`,
    originThreadId
  );

  runPoll(poll);
  scheduleNextTick();
  return true;
}

function cancelPoll(text, chatId) {
  const match = text.match(/^\/poll-cancel\s+(\S+)/);
  if (!match) return false;
  const id = match[1];
  const poll = polls.get(id);
  if (!poll) return false;
  if (chatId !== undefined && !pollBelongsToChat(poll, chatId)) return false;
  poll.active = false;
  savePollsToDisk();
  console.log(`[Poll ${id}] Cancelled`);
  scheduleNextTick();
  return true;
}

function restartPoll(text, originThreadId, chatId) {
  const match = text.match(/^\/poll-restart\s+(\S+)/);
  if (!match) return false;
  const id = match[1];
  const poll = polls.get(id);
  if (!poll) return false;
  if (chatId !== undefined && !pollBelongsToChat(poll, chatId)) return false;

  poll.active = true;
  poll.runCount = 0;
  poll.sessionId = randomUUID();
  poll.lastRun = null;
  savePollsToDisk();

  console.log(`[Poll ${id}] Restarted`);

  sendToTeams(poll.chatId,
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

  sendToTeams(poll.chatId,
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

  const threadInfo = poll.fresh
    ? {
        // Each fresh run gets its own session dir so omp can't resume the prior run
        rootMessageId: `poll-${poll.id}-${poll.runCount}`,
        sessionId: randomUUID(),
        harnessSessionId: null,
        isFollowUp: false,
        model: poll.model || undefined,
        alola: coerceAlolaMetadata(poll.alola, { rootMessageId: `poll-${poll.id}-${poll.runCount}`, sessionId: poll.sessionId }) || undefined,
      }
    : {
        rootMessageId: `poll-${poll.id}`,
        sessionId: poll.sessionId,
        harnessSessionId: poll.harnessSessionId || null,
        isFollowUp: poll.runCount > 1,
        model: poll.model || undefined,
        alola: coerceAlolaMetadata(poll.alola, { rootMessageId: `poll-${poll.id}`, sessionId: poll.sessionId }) || undefined,
      };

  const stickyArgs = agentSpawn.applyStickyOptions(threadInfo, poll.harnessArgs || []);
  const args = agentSpawn.prepareHarnessArgs(
    agentSpawn.buildHarnessArgs(threadInfo, poll.prompt, stickyArgs)
  );
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

    if (!poll.fresh) {
      const sid = agentSpawn.finalizeSession(agentSpawn.threadSessionDir(`poll-${poll.id}`));
      if (sid) poll.harnessSessionId = sid;
    } else {
      // Finalize the per-run dir so .tmp files become .jsonl, but don't store the id
      agentSpawn.finalizeSession(agentSpawn.threadSessionDir(`poll-${poll.id}-${poll.runCount}`));
    }

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
        `python3 ${SCRIPTS_DIR}/send_chat.py --chat-id "${poll.chatId}" -m - --html --json`,
        { timeout: 30000, input: fullMessage, stdio: ["pipe", "pipe", "pipe"] }
      );
      try {
        const parsed = JSON.parse(sendResult.toString());
        if (parsed.message_id) {
          rememberPollResultThread(poll.chatId, parsed.message_id, poll.id);
        }
      } catch {}
    } catch (err) {
      console.error(`[Poll ${poll.id}] Failed to post result:`, err.message);
    }

    savePollsToDisk();
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

function getPollForResultThread(messageId, chatId) {
  const pollId = pollResultThreads.get(resultThreadKey(chatId, messageId));
  if (!pollId) return null;
  return polls.get(pollId) || null;
}

function getPollsForChat(chatId, includeInactive = false) {
  const list = [];
  for (const poll of polls.values()) {
    if (!pollBelongsToChat(poll, chatId)) continue;
    if (!includeInactive && !poll.active) continue;
    list.push(poll);
  }
  return list;
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
  getPollsForChat,
  hasPollResultThread,
  rememberPollResultThread,
  pollResultThreads,
};
