const { randomUUID } = require("crypto");
const { CHAT_ID, POLL_INTERVAL, MAX_CONCURRENT_AGENTS } = require("./config");
const { sendToTeams, stripHtml, isBotMessage, fetchMessages } = require("./teams-io");
const { spawnAgent } = require("./agent-spawn");

const threads = new Map();
let lastSeenMessageId = null;
let lastSeenTimestamp = null;

function handleNewThread(text, from, messageId) {
  if (!text || !messageId) return;

  const threadInfo = {
    rootMessageId: messageId,
    sessionId: randomUUID(),
    from,
    startTime: new Date(),
    isFollowUp: false,
    busy: true,
    lastSeen: null,
    childPid: null,
  };

  threads.set(messageId, threadInfo);
  console.log(`[Thread ${messageId}] New session ${threadInfo.sessionId.slice(0, 8)}... from ${from}`);

  sendToTeams("🚀 Processing...", messageId);
  spawnAgent(threadInfo, text, messageId, MAX_CONCURRENT_AGENTS);
}

function handleThreadReply(threadInfo, text, from) {
  if (threadInfo.busy) {
    sendToTeams("⏳ Still working on the previous message...", threadInfo.rootMessageId);
    return;
  }

  threadInfo.isFollowUp = true;
  threadInfo.busy = true;

  console.log(`[Thread ${threadInfo.rootMessageId}] Follow-up from ${from}: "${text.slice(0, 80)}"`);
  spawnAgent(threadInfo, text, threadInfo.rootMessageId, MAX_CONCURRENT_AGENTS);
}

function pollChannel() {
  const messages = fetchMessages(CHAT_ID, 10);
  if (messages.length === 0) return;

  if (lastSeenMessageId === null) {
    lastSeenMessageId = messages[0].id;
    lastSeenTimestamp = messages[0].time;
    console.log(`[Poll] Initial sync — latest: ${lastSeenMessageId}`);
    return;
  }

  const newMessages = [];
  for (const msg of messages) {
    if (msg.id === lastSeenMessageId) break;
    if (msg.time && lastSeenTimestamp && msg.time <= lastSeenTimestamp) break;
    newMessages.push(msg);
  }

  if (newMessages.length > 0) {
    lastSeenMessageId = newMessages[0].id;
    lastSeenTimestamp = newMessages[0].time;

    for (const msg of newMessages.reverse()) {
      if (msg.messagetype !== "RichText/Html" && msg.messagetype !== "Text") continue;
      if (isBotMessage(msg)) continue;

      const text = stripHtml(msg.content);
      if (!text) continue;

      const from = msg.from || "unknown";
      console.log(`[Poll] New message from ${from} (id=${msg.id}): "${text.slice(0, 80)}"`);
      handleNewThread(text, from, msg.id);
    }
  }
}

function pollThreads() {
  for (const [rootId, threadInfo] of threads) {
    if (Date.now() - threadInfo.startTime > 24 * 60 * 60 * 1000) {
      threads.delete(rootId);
      continue;
    }

    try {
      const threadConvId = `${CHAT_ID};messageid=${rootId}`;
      const messages = fetchMessages(threadConvId, 5);
      if (messages.length === 0) continue;

      if (!threadInfo.lastSeen) {
        threadInfo.lastSeen = messages[0].id;
        continue;
      }

      const newReplies = [];
      for (const msg of messages) {
        if (msg.id === threadInfo.lastSeen) break;
        newReplies.push(msg);
      }

      if (newReplies.length > 0) {
        threadInfo.lastSeen = newReplies[0].id;

        for (const msg of newReplies.reverse()) {
          if (msg.messagetype !== "RichText/Html" && msg.messagetype !== "Text") continue;
          if (isBotMessage(msg)) continue;

          const text = stripHtml(msg.content);
          if (!text) continue;

          const from = msg.from || "unknown";
          handleThreadReply(threadInfo, text, from);
        }
      }
    } catch {}
  }
}

function getThreads() {
  return threads;
}

module.exports = { pollChannel, pollThreads, getThreads };
