const { randomUUID } = require("crypto");
const { CHAT_ID, MAX_CONCURRENT_AGENTS } = require("./config");
const { sendToTeams, stripHtml, isBotMessage, fetchMessages } = require("./teams-io");
const { spawnAgent } = require("./agent-spawn");

const threads = new Map();
const processedMessageIds = new Set();
let lastSeenChannelId = null;
let lastSeenChannelTime = null;

function handleNewThread(text, from, messageId) {
  if (!text || !messageId) return;

  processedMessageIds.add(messageId);

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

function pollChannel() {
  const messages = fetchMessages(CHAT_ID, 10);
  if (messages.length === 0) return;

  if (lastSeenChannelId === null) {
    lastSeenChannelId = messages[0].id;
    lastSeenChannelTime = messages[0].time;
    // Mark all existing messages as processed
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

      // Don't create a new thread — pollThreads will pick it up if it's a reply.
      // Only create new threads for messages that don't belong to any existing thread.
      // We defer this check: mark as seen but don't process yet.
      // If pollThreads claims it within 2 cycles, it's a thread reply.
      // Otherwise, handleNewThread on the next pollChannel pass.
      processedMessageIds.add(msg.id);
      const from = msg.from || "unknown";

      // Check if this could be a thread reply (belongs to any active thread)
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

      if (!claimed) {
        console.log(`[Poll] New thread from ${from} (id=${msg.id}): "${text.slice(0, 60)}"`);
        handleNewThread(text, from, msg.id);
      }
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
