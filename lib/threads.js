const { randomUUID } = require("crypto");
const { CHAT_ID, MAX_CONCURRENT_AGENTS } = require("./config");
const { sendToTeams, stripHtml, isBotMessage, fetchMessages } = require("./teams-io");
const { spawnAgent } = require("./agent-spawn");
const { createPoll, cancelPoll, restartPoll, getPollForResultThread, pollResultThreads } = require("./polls");

const threads = new Map();
const processedMessageIds = new Set();
let lastSeenChannelId = null;
let lastSeenChannelTime = null;

function handleNewThread(text, from, messageId) {
  if (!text || !messageId) return;

  processedMessageIds.add(messageId);

  // Handle /poll command
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
  if (text.trim() === "/polls") {
    const { getPolls } = require("./polls");
    const allPolls = getPolls();
    if (allPolls.size === 0) {
      sendToTeams("No active polls.", messageId);
    } else {
      const lines = [];
      for (const [id, p] of allPolls) {
        const lastRun = p.lastRun ? new Date(p.lastRun).toLocaleString() : "never";
        lines.push(`<b>${id}</b>: every ${p.intervalStr} — ${p.prompt.slice(0, 80)}... (last: ${lastRun})`);
      }
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
  console.log(`[Thread ${messageId}] New session ${threadInfo.sessionId.slice(0, 8)}... from ${from}`);

  sendToTeams("🚀 Processing...", messageId);
  spawnAgent(threadInfo, text, messageId, MAX_CONCURRENT_AGENTS);
}

function handleThreadReply(threadInfo, text, from, messageId) {
  processedMessageIds.add(messageId);

  if (threadInfo.busy) {
    sendToTeams("⏳ Still working on the previous message...", threadInfo.rootMessageId);
    return;
  }

  threadInfo.isFollowUp = true;
  threadInfo.busy = true;

  console.log(`[Thread ${threadInfo.rootMessageId}] Follow-up from ${from}: "${text.slice(0, 80)}"`);
  spawnAgent(threadInfo, text, threadInfo.rootMessageId, MAX_CONCURRENT_AGENTS);
}

function handlePollResultReply(poll, text, from, messageId, rootMessageId) {
  processedMessageIds.add(messageId);

  // Create a thread entry for this poll result thread so future replies work
  if (!threads.has(rootMessageId)) {
    threads.set(rootMessageId, {
      rootMessageId,
      sessionId: poll.sessionId,
      from,
      startTime: new Date(),
      isFollowUp: true,
      busy: true,
      lastSeen: messageId,
      childPid: null,
    });
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
    if (Date.now() - threadInfo.startTime > 24 * 60 * 60 * 1000) {
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

module.exports = { pollChannel, pollThreads, getThreads };
