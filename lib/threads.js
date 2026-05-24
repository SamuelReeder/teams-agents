const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const { CHAT_ID, MAX_CONCURRENT_AGENTS, ROOT_DIR, THREAD_TTL_MS } = require("./config");
const { sendToTeams, stripHtml, isBotMessage, fetchMessages } = require("./teams-io");
const { spawnAgent, finalizeSession, threadSessionDir } = require("./agent-spawn");
const { createPoll, cancelPoll, restartPoll, getPollForResultThread, pollResultThreads } = require("./polls");

const THREADS_FILE = path.join(ROOT_DIR, "threads.json");

const threads = new Map();
const processedMessageIds = new Set();
let lastSeenChannelId = null;
let lastSeenChannelTime = null;

function saveThreadsToDisk() {
  const data = [];
  for (const [key, t] of threads) {
    data.push({
      mapKey: key !== t.rootMessageId ? key : undefined,
      rootMessageId: t.rootMessageId,
      sessionId: t.sessionId,
      harnessSessionId: t.harnessSessionId || null,
      from: t.from,
      startTime: t.startTime instanceof Date ? t.startTime.toISOString() : t.startTime,
      model: t.model || null,
      alola: t.alola || null,
    });
  }
  fs.writeFileSync(THREADS_FILE, JSON.stringify(data, null, 2));
}

function loadThreadsFromDisk() {
  if (!fs.existsSync(THREADS_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(THREADS_FILE, "utf8"));
    const now = Date.now();
    let restored = 0;
    for (const t of data) {
      const age = now - new Date(t.startTime).getTime();
      if (age > THREAD_TTL_MS) continue;

      let harnessSessionId = t.harnessSessionId;
      if (!harnessSessionId) {
        try {
          harnessSessionId = finalizeSession(threadSessionDir(t.rootMessageId)) || null;
        } catch {}
      }

      const mapKey = t.mapKey || t.rootMessageId;
      threads.set(mapKey, {
        rootMessageId: t.rootMessageId,
        sessionId: t.sessionId,
        harnessSessionId,
        from: t.from,
        startTime: new Date(t.startTime),
        isFollowUp: true,
        busy: false,
        lastSeen: t.rootMessageId,
        childPid: null,
        model: t.model || undefined,
        alola: t.alola || undefined,
      });

      try {
        const threadConvId = `${CHAT_ID};messageid=${mapKey}`;
        const msgs = fetchMessages(threadConvId, 10);
        for (const m of msgs) processedMessageIds.add(m.id);
      } catch {}

      restored++;
    }
    console.log(`[Threads] Restored ${restored} threads from disk`);
  } catch (err) {
    console.error("[Threads] Failed to load threads:", err.message);
  }
}

function handleNewThread(text, from, messageId) {
  if (!text || !messageId) return;

  processedMessageIds.add(messageId);

  // Handle /help command
  if (text.trim() === "/help") {
    sendToTeams(
      `<b>Teams Agents</b><br><br>` +
        `Post a message to start a new agent session. Reply in a thread to continue the conversation.<br><br>` +
        `<b>Flags</b> (prefix your message):<br>` +
        `<code>--alola [node]</code> — reserved; run on Alola cluster (default node 03)<br>` +
        `<code>--&lt;flag&gt; [value]</code> — forwarded verbatim to the harness before the prompt<br>` +
        `<code>--</code> — end harness flags, useful before prompts that start with dashes<br><br>` +
        `<b>Commands</b>:<br>` +
        `<code>/help</code> — this message<br>` +
        `<code>/poll &lt;interval&gt; &lt;prompt&gt;</code> — recurring agent (e.g. <code>/poll 2d check my PRs</code>)<br>` +
        `<code>/poll-cancel &lt;id&gt;</code> — cancel a poll<br>` +
        `<code>/poll-restart &lt;id&gt;</code> — restart an expired poll<br>` +
        `<code>/polls</code> — list active polls (<code>/polls --all</code> includes cancelled/expired)<br><br>` +
        `<b>Workspace commands</b> (passed to the harness):<br>` +
        `<code>/goto</code>, <code>/status</code>, <code>/worktrees</code>, <code>/task</code>, <code>/wip</code>, ` +
        `<code>/prep-pr</code>, <code>/review-pr</code>, <code>/create-pr</code>, <code>/orchestrate</code>, <code>/descriptor</code><br><br>` +
        `<b>Examples</b>:<br>` +
        `<code>--alola build hipDNN in the consumption worktree</code><br>` +
        `<code>--model opus explain the descriptor lifting architecture</code><br>` +
        `<code>/poll 1d check CI status on my open PRs</code>`,
      messageId
    );
    return;
  }

  // Handle /poll command
  if (text.trim() === "/poll") {
    sendToTeams(
      `Usage: <code>/poll &lt;interval&gt; &lt;prompt&gt;</code><br>` +
        `Example: <code>/poll 2d check my open PRs</code><br>` +
        `Intervals: <code>Nm</code> (minutes), <code>Nh</code> (hours), <code>Nd</code> (days), <code>Nw</code> (weeks)`,
      messageId
    );
    return;
  }
  if (text.startsWith("/poll ")) {
    createPoll(text, from, messageId);
    return;
  }

  // Handle /poll-cancel command
  if (text.startsWith("/poll-cancel ")) {
    const cancelled = cancelPoll(text);
    sendToTeams(
      cancelled ? "✅ Poll cancelled." : "❌ Poll not found.",
      messageId
    );
    return;
  }

  // Handle /poll-restart command
  if (text.startsWith("/poll-restart ")) {
    const restarted = restartPoll(text, messageId);
    if (!restarted) sendToTeams("❌ Poll not found.", messageId);
    return;
  }

  // Handle /polls list command
  if (text.trim() === "/polls" || text.trim() === "/polls --all") {
    const showAll = text.trim() === "/polls --all";
    const { getPolls } = require("./polls");
    const allPolls = getPolls();
    const list = showAll
      ? [...allPolls.values()]
      : [...allPolls.values()].filter((p) => p.active);
    if (list.length === 0) {
      sendToTeams(showAll ? "No polls." : "No active polls.", messageId);
    } else {
      const lines = list.map((p) => {
        const lastRun = p.lastRun ? new Date(p.lastRun).toLocaleString() : "never";
        const status = p.active ? "▶️" : "⏹️";
        const model = p.model ? ` [${p.model}]` : "";
        return `${status} <code>${p.id}</code>: every ${p.intervalStr}${model} — ${p.prompt.slice(0, 60)} (${p.runCount}/${p.maxRuns}, last: ${lastRun})`;
      });
      sendToTeams(lines.join("<br>"), messageId);
    }
    return;
  }

  const threadInfo = {
    rootMessageId: messageId,
    sessionId: randomUUID(),
    from,
    startTime: new Date(),
    isFollowUp: false,
    busy: true,
    lastSeen: messageId,
    childPid: null,
  };

  threads.set(messageId, threadInfo);
  saveThreadsToDisk();
  console.log(`[Thread ${messageId}] New session ${threadInfo.sessionId.slice(0, 8)}... from ${from}`);

  sendToTeams("🚀 Processing...", messageId);
  spawnAgent(threadInfo, text, messageId, MAX_CONCURRENT_AGENTS);
}

function handleThreadReply(threadInfo, text, from, messageId) {
  processedMessageIds.add(messageId);

  if (threadInfo.busy) {
    const replaced = !!threadInfo.pending;
    threadInfo.pending = { text, from, messageId };
    sendToTeams(
      replaced
        ? "⏳ Replaced queued message with this one."
        : "⏳ Working — will process this next.",
      threadInfo.rootMessageId
    );
    return;
  }

  threadInfo.isFollowUp = true;
  threadInfo.busy = true;

  console.log(`[Thread ${threadInfo.rootMessageId}] Follow-up from ${from}: "${text.slice(0, 80)}"`);
  spawnAgent(threadInfo, text, threadInfo.rootMessageId, MAX_CONCURRENT_AGENTS);
}

function handlePollResultReply(poll, text, from, messageId, rootMessageId) {
  processedMessageIds.add(messageId);

  if (!threads.has(rootMessageId)) {
    threads.set(rootMessageId, {
      rootMessageId: `poll-${poll.id}`,
      sessionId: poll.sessionId,
      harnessSessionId: poll.harnessSessionId || null,
      from,
      startTime: new Date(),
      isFollowUp: true,
      busy: true,
      lastSeen: messageId,
      childPid: null,
    });
    saveThreadsToDisk();
  }
  const threadInfo = threads.get(rootMessageId);
  if (threadInfo.busy && threadInfo.childPid) {
    sendToTeams("⏳ Still working on the previous message...", rootMessageId);
    return;
  }

  threadInfo.isFollowUp = true;
  threadInfo.busy = true;

  console.log(`[PollThread ${poll.id}] Reply from ${from}: "${text.slice(0, 80)}"`);
  spawnAgent(threadInfo, text, rootMessageId, MAX_CONCURRENT_AGENTS);
}

function pollChannel() {
  const messages = fetchMessages(CHAT_ID, 10);
  if (messages.length === 0) return;

  if (lastSeenChannelId === null) {
    lastSeenChannelId = messages[0].id;
    lastSeenChannelTime = messages[0].time;
    messages.forEach((m) => processedMessageIds.add(m.id));
    console.log(`[Poll] Initial sync — latest: ${lastSeenChannelId}`);
    return;
  }

  const newMessages = [];
  for (const msg of messages) {
    if (msg.id === lastSeenChannelId) break;
    if (msg.time && lastSeenChannelTime && msg.time <= lastSeenChannelTime) break;
    newMessages.push(msg);
  }

  if (newMessages.length > 0) {
    lastSeenChannelId = newMessages[0].id;
    lastSeenChannelTime = newMessages[0].time;

    for (const msg of newMessages.reverse()) {
      if (processedMessageIds.has(msg.id)) continue;
      if (msg.messagetype !== "RichText/Html" && msg.messagetype !== "Text") continue;
      if (isBotMessage(msg)) {
        processedMessageIds.add(msg.id);
        continue;
      }

      const text = stripHtml(msg.content);
      if (!text) continue;

      processedMessageIds.add(msg.id);
      const from = msg.from || "unknown";

      // Check if this is a reply in an existing agent thread
      let claimed = false;
      for (const [rootId, threadInfo] of threads) {
        const threadConvId = `${CHAT_ID};messageid=${rootId}`;
        const threadMsgs = fetchMessages(threadConvId, 5);
        if (threadMsgs.some((tm) => tm.id === msg.id)) {
          console.log(`[Poll] Routing to thread ${rootId}: "${text.slice(0, 60)}"`);
          threadInfo.lastSeen = msg.id;
          handleThreadReply(threadInfo, text, from, msg.id);
          claimed = true;
          break;
        }
      }

      // Check if this is a reply in a poll result thread
      if (!claimed) {
        for (const [resultThreadId, pollId] of pollResultThreads) {
          const threadConvId = `${CHAT_ID};messageid=${resultThreadId}`;
          const threadMsgs = fetchMessages(threadConvId, 5);
          if (threadMsgs.some((tm) => tm.id === msg.id)) {
            const poll = getPollForResultThread(resultThreadId);
            if (poll) {
              console.log(`[Poll] Routing to poll result thread ${resultThreadId}: "${text.slice(0, 60)}"`);
              handlePollResultReply(poll, text, from, msg.id, resultThreadId);
              claimed = true;
              break;
            }
          }
        }
      }

      if (!claimed) {
        console.log(`[Poll] New thread from ${from} (id=${msg.id}): "${text.slice(0, 60)}"`);
        handleNewThread(text, from, msg.id);
      }
    }
  }
}

function pollThreads() {
  // Poll active agent threads
  for (const [rootId, threadInfo] of threads) {
    if (Date.now() - threadInfo.startTime > THREAD_TTL_MS) {
      threads.delete(rootId);
      continue;
    }

    try {
      const threadConvId = `${CHAT_ID};messageid=${rootId}`;
      const messages = fetchMessages(threadConvId, 5);
      if (messages.length === 0) continue;

      for (const msg of messages.reverse()) {
        if (processedMessageIds.has(msg.id)) continue;
        if (msg.messagetype !== "RichText/Html" && msg.messagetype !== "Text") continue;
        if (isBotMessage(msg)) {
          processedMessageIds.add(msg.id);
          continue;
        }

        const text = stripHtml(msg.content);
        if (!text) continue;

        const from = msg.from || "unknown";
        console.log(`[ThreadPoll] Reply in thread ${rootId} from ${from}: "${text.slice(0, 60)}"`);
        threadInfo.lastSeen = msg.id;
        handleThreadReply(threadInfo, text, from, msg.id);
      }
    } catch {}
  }
}

function getThreads() {
  return threads;
}

module.exports = { pollChannel, pollThreads, getThreads, saveThreadsToDisk, loadThreadsFromDisk };
