const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  ROOT_DIR,
  STATE_DIR,
  AGENT_TIMEOUT_MS,
  loadChannels,
  resolveWorkspace,
  workspaceFromPersisted,
  attachWorkspace,
  channelDefaultModel,
  channelAlolaDefaultModel,
  channelMaxConcurrentAgents,
} = require("../config/env");
const { sendToTeams } = require("../teams/io");
const { buildSessionMetadata, coerceAlolaMetadata } = require("../alola/session");
const { runHarness } = require("../agents/harness-runner");

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

function channelForChat(chatId) {
  try {
    const channels = loadChannels();
    const channel = channels.find((entry) => entry.chatId === chatId);
    if (channel) return channel;
  } catch (err) {
    if (!/Channel config file does not exist/.test(err.message)) throw err;
  }
  return {
    chatId: chatId || null,
    label: chatId || "Default",
    prefix: require("../config/env").AGENT_PREFIX,
    defaultModel: null,
    alolaDefaultModel: null,
    workspace: null,
    maxConcurrentAgents: null,
  };
}

function normalizeChannelInput(channelOrChatId) {
  return typeof channelOrChatId === "object" && channelOrChatId !== null
    ? channelOrChatId
    : channelForChat(channelOrChatId || null);
}

function workspaceForPollRecord(record, channel) {
  if (record.workspaceDir) return workspaceFromPersisted(record.workspaceId, record.workspaceDir, record.workspaceSource || "poll");
  return resolveWorkspace(channel || channelForChat(record.chatId || null));
}

function pollBelongsToChat(poll, chatId) {
  return (poll.chatId || null) === (chatId || null);
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
    if (!poll.workspaceDir) attachWorkspace(poll, workspaceForPollRecord(poll, channelForChat(poll.chatId || null)));
    const resultThreadIds = [];
    for (const [resultThreadId, pId] of pollResultThreads) {
      if (pId === id) resultThreadIds.push(resultThreadMessageId(resultThreadId));
    }
    data.push({
      id,
      chatId: poll.chatId || null,
      workspaceId: poll.workspaceId || null,
      workspaceDir: poll.workspaceDir || null,
      workspaceSource: poll.workspaceSource || null,
      prompt: poll.prompt,
      harnessArgs: poll.harnessArgs || undefined,
      intervalMs: poll.intervalMs,
      intervalStr: poll.intervalStr,
      sessionId: poll.sessionId,
      harnessSessionId: poll.harnessSessionId || null,
      model: poll.model || null,
      defaultModel: poll.defaultModel || null,
      alolaDefaultModel: poll.alolaDefaultModel || null,
      maxConcurrentAgents: poll.maxConcurrentAgents || null,
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

function configuredChatIdSet() {
  try {
    return new Set(loadChannels().map((channel) => channel.chatId));
  } catch (err) {
    if (/Channel config file does not exist/.test(err.message)) return null;
    throw err;
  }
}

function loadPollsFromDisk() {
  if (!fs.existsSync(POLLS_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(POLLS_FILE, "utf8"));
    const configuredChatIds = configuredChatIdSet();
    let skipped = 0;
    for (const p of data) {
      const chatId = p.chatId || null;
      if (configuredChatIds && !configuredChatIds.has(chatId)) {
        skipped++;
        continue;
      }
      const channel = channelForChat(chatId);
      const workspace = workspaceForPollRecord(p, channel);
      if (p.resultThreadIds) {
        for (const msgId of p.resultThreadIds) {
          rememberPollResultThread(chatId, msgId, p.id);
        }
      }
      const poll = attachWorkspace({
        ...p,
        chatId,
        defaultModel: p.defaultModel || channelDefaultModel(channel),
        alolaDefaultModel: p.alolaDefaultModel || channelAlolaDefaultModel(channel),
        maxConcurrentAgents: p.maxConcurrentAgents || channelMaxConcurrentAgents(channel),
        busy: false,
      }, workspace);
      polls.set(p.id, poll);
    }
    const activeCount = [...polls.values()].filter((p) => p.active).length;
    console.log(`[Polls] Loaded ${activeCount} active polls (${polls.size} total) from disk${skipped ? `; skipped ${skipped} for unconfigured channels` : ""}`);
    scheduleNextTick();
  } catch (err) {
    console.error("[Polls] Failed to load polls:", err.message);
  }
}

function createPoll(channelOrChatId, text, from, originThreadId) {
  const channel = normalizeChannelInput(channelOrChatId);
  const chatId = channel.chatId;
  const parsed = parsePollCommand(text);
  if (!parsed) return false;

  const agentSpawn = require("../agents/spawn");
  const { flags, harnessArgs, prompt } = agentSpawn.extractFlags(parsed.prompt);

  const freshIdx = harnessArgs.indexOf("--fresh");
  const fresh = freshIdx !== -1;
  if (fresh) harnessArgs.splice(freshIdx, 1);

  const threadInfo = {
    defaultModel: channelDefaultModel(channel),
    alolaDefaultModel: channelAlolaDefaultModel(channel),
  };
  const stickyArgs = agentSpawn.applyStickyOptions(threadInfo, harnessArgs);

  const id = randomUUID().slice(0, 8);
  const pollSessionId = randomUUID();
  const workspace = resolveWorkspace(channel);
  const alola = flags.alola
    ? buildSessionMetadata({ rootMessageId: `poll-${id}`, sessionId: pollSessionId }, flags.alola)
    : null;
  const poll = attachWorkspace({
    id,
    chatId,
    prompt,
    harnessArgs: stickyArgs.length > 0 ? stickyArgs : undefined,
    intervalMs: parsed.intervalMs,
    intervalStr: parsed.intervalStr,
    sessionId: pollSessionId,
    model: threadInfo.model || null,
    defaultModel: threadInfo.defaultModel || null,
    alolaDefaultModel: threadInfo.alolaDefaultModel || null,
    maxConcurrentAgents: channelMaxConcurrentAgents(channel),
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
  }, workspace);

  polls.set(id, poll);
  savePollsToDisk();

  console.log(`[Poll ${id}] Created: every ${parsed.intervalStr}, max ${poll.maxRuns} runs, model: ${poll.model || "default"}, workspace: ${poll.workspaceId}, fresh: ${fresh}, prompt: "${poll.prompt.slice(0, 60)}"`);

  const modelLine = poll.model ? `<b>Model:</b> ${poll.model}<br>` : "";
  const freshLine = fresh ? `<b>Mode:</b> fresh (no session memory across runs)<br>` : "";
  sendToTeams(chatId,
    `🔄 <b>Cron created</b> (id: <code>${id}</code>)<br>` +
      `<b>Interval:</b> every ${parsed.intervalStr}<br>` +
      modelLine +
      freshLine +
      `<b>Workspace:</b> <code>${poll.workspaceDir}</code><br>` +
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

  const workspace = workspaceForPollRecord(poll, channelForChat(poll.chatId));
  attachWorkspace(poll, workspace);
  const agentSpawn = require("../agents/spawn");
  const maxConcurrent = poll.maxConcurrentAgents || channelMaxConcurrentAgents(channelForChat(poll.chatId));
  if (!agentSpawn.acquireAgentSlot(poll, maxConcurrent)) {
    console.log(`[Poll ${poll.id}] Deferring run because ${poll.chatId || "default"} is at concurrency limit ${maxConcurrent}`);
    scheduleNextTick();
    return;
  }
  poll.busy = true;
  poll.runCount++;
  poll.lastRun = new Date().toISOString();

  console.log(`[Poll ${poll.id}] Run ${poll.runCount}/${poll.maxRuns}: "${poll.prompt.slice(0, 60)}"`);


  const threadInfo = poll.fresh
    ? attachWorkspace({
        rootMessageId: `poll-${poll.id}-${poll.runCount}`,
        sessionId: randomUUID(),
        harnessSessionId: null,
        isFollowUp: false,
        model: poll.model || undefined,
        defaultModel: poll.defaultModel || undefined,
        alolaDefaultModel: poll.alolaDefaultModel || undefined,
        alola: coerceAlolaMetadata(poll.alola, { rootMessageId: `poll-${poll.id}-${poll.runCount}`, sessionId: poll.sessionId }) || undefined,
      }, workspace)
    : attachWorkspace({
        rootMessageId: `poll-${poll.id}`,
        sessionId: poll.sessionId,
        harnessSessionId: poll.harnessSessionId || null,
        isFollowUp: poll.runCount > 1,
        model: poll.model || undefined,
        defaultModel: poll.defaultModel || undefined,
        alolaDefaultModel: poll.alolaDefaultModel || undefined,
        alola: coerceAlolaMetadata(poll.alola, { rootMessageId: `poll-${poll.id}`, sessionId: poll.sessionId }) || undefined,
      }, workspace);

  const stickyArgs = agentSpawn.applyStickyOptions(threadInfo, poll.harnessArgs || []);
  const args = agentSpawn.prepareHarnessArgs(
    agentSpawn.buildHarnessArgs(threadInfo, poll.prompt, stickyArgs),
    workspace
  );
  savePollsToDisk();
  const includeAlola = Boolean(agentSpawn.defaultModelForPrompt(threadInfo, poll.prompt) && threadInfo.alola) || agentSpawn.promptNeedsAlola(poll.prompt) || Boolean(threadInfo.alola);

  runHarness(args, {
    cwd: workspace.dir,
    includeAlola,
    alolaThreadId: threadInfo.sessionId,
    timeoutMs: AGENT_TIMEOUT_MS,
  }).then(({ stdout = "", stderr = "", code = null }) => {
    poll.busy = false;
    agentSpawn.releaseAgentSlot(poll);

    if (!poll.fresh) {
      const sid = agentSpawn.finalizeThreadSession(threadInfo, `poll-${poll.id}`);
      if (sid) poll.harnessSessionId = sid;
    } else {
      agentSpawn.finalizeThreadSession(threadInfo, `poll-${poll.id}-${poll.runCount}`);
    }

    const result = stdout || stderr || "(no output)";
    console.log(`[Poll ${poll.id}] Done run ${poll.runCount}/${poll.maxRuns} (exit ${code}, ${result.length} chars)`);

    const { markdownToHtml } = require("../teams/io");
    const header =
      `🔄 <b>Poll: ${poll.id}</b> (every ${poll.intervalStr}, run ${poll.runCount}/${poll.maxRuns})<br><hr>`;

    try {
      const html = markdownToHtml ? markdownToHtml(result) : result;
      const fullMessage = `${header}${html}`;
      const parsed = sendToTeams(poll.chatId, fullMessage, null, false);
      if (parsed?.message_id) {
        rememberPollResultThread(poll.chatId, parsed.message_id, poll.id);
      }
    } catch (err) {
      console.error(`[Poll ${poll.id}] Failed to post result:`, err.message);
    }

    savePollsToDisk();
    scheduleNextTick();
  }).catch((err) => {
    poll.busy = false;
    agentSpawn.releaseAgentSlot(poll);
    console.error(`[Poll ${poll.id}] Harness run failed:`, err.message);
    savePollsToDisk();
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
  parseInterval,
  parsePollCommand,
  createPoll,
  cancelPoll,
  restartPoll,
  loadPollsFromDisk,
  savePollsToDisk,
  runPoll,
  getPolls,
  getPollForResultThread,
  getPollsForChat,
  hasPollResultThread,
  rememberPollResultThread,
  pollResultThreads,
};
