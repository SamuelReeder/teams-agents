const { execSync } = require("child_process");
const { CHAT_ID, SCRIPTS_DIR, REPLY_SCRIPT } = require("./config");

const botMessageIds = new Set();

function sendToTeams(message, replyToId) {
  try {
    let result;
    if (replyToId) {
      result = execSync(
        `python3 ${REPLY_SCRIPT} --chat-id "${CHAT_ID}" --reply-to "${replyToId}" -m ${JSON.stringify(message)} --html --json`,
        { timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }
      );
    } else {
      result = execSync(
        `python3 ${SCRIPTS_DIR}/send_chat.py --chat-id "${CHAT_ID}" -m ${JSON.stringify(message)} --html --json`,
        { timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }
      );
    }
    try {
      const parsed = JSON.parse(result.toString());
      if (parsed.message_id) botMessageIds.add(parsed.message_id);
    } catch {}
  } catch (err) {
    console.error("Failed to send to Teams:", err.message);
  }
}

function sendLargeOutput(output, replyToId) {
  const MAX_CHUNK = 4000;
  if (output.length <= MAX_CHUNK) {
    sendToTeams(output, replyToId);
    return;
  }

  const chunks = [];
  let remaining = output;
  while (remaining.length > 0) {
    let cut = Math.min(remaining.length, MAX_CHUNK);
    if (cut < remaining.length) {
      const lastNewline = remaining.lastIndexOf("\n", cut);
      if (lastNewline > cut * 0.5) cut = lastNewline + 1;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }

  for (let i = 0; i < chunks.length; i++) {
    const header = chunks.length > 1 ? `<b>[${i + 1}/${chunks.length}]</b><br>` : "";
    sendToTeams(`${header}<pre>${escapeHtml(chunks[i])}</pre>`, replyToId);
  }
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isBotMessage(msg) {
  if (botMessageIds.has(msg.id)) return true;
  const text = stripHtml(msg.content);
  if (!text) return true;
  if (text.startsWith("🚀") || text.startsWith("⏳") || text.startsWith("🤖")) return true;
  if (text.startsWith("Failed to start agent")) return true;
  return false;
}

function fetchMessages(chatId, limit = 10) {
  try {
    const result = execSync(
      `python3 ${SCRIPTS_DIR}/list_messages.py --chat-id "${chatId}" --limit ${limit} --json`,
      { timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }
    );
    return JSON.parse(result.toString()) || [];
  } catch {
    return [];
  }
}

module.exports = {
  sendToTeams,
  sendLargeOutput,
  stripHtml,
  escapeHtml,
  isBotMessage,
  fetchMessages,
  botMessageIds,
};
