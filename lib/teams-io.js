const { execSync } = require("child_process");
const { marked } = require("marked");
const { CHAT_ID, SCRIPTS_DIR, REPLY_SCRIPT } = require("./config");

marked.setOptions({ breaks: true, gfm: true });

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

function markdownToHtml(md) {
  return marked.parse(md).trim();
}

function sendLargeOutput(output, replyToId) {
  const html = markdownToHtml(output);
  const MAX_CHUNK = 8000;

  if (html.length <= MAX_CHUNK) {
    sendToTeams(html, replyToId);
    return;
  }

  const chunks = [];
  let remaining = html;
  while (remaining.length > 0) {
    let cut = Math.min(remaining.length, MAX_CHUNK);
    if (cut < remaining.length) {
      const lastBreak = remaining.lastIndexOf("<br", cut);
      const lastP = remaining.lastIndexOf("</p>", cut);
      const best = Math.max(lastBreak, lastP > 0 ? lastP + 4 : 0);
      if (best > cut * 0.3) cut = best;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }

  for (let i = 0; i < chunks.length; i++) {
    const header = chunks.length > 1 ? `<b>[${i + 1}/${chunks.length}]</b><br>` : "";
    sendToTeams(`${header}${chunks[i]}`, replyToId);
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
  markdownToHtml,
  stripHtml,
  escapeHtml,
  isBotMessage,
  fetchMessages,
  botMessageIds,
};
