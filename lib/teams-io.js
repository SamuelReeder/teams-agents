const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { marked } = require("marked");
const { SCRIPTS_DIR, REPLY_SCRIPT, ROOT_DIR, STATE_DIR } = require("./config");

marked.setOptions({ breaks: true, gfm: true });

const BOT_IDS_FILE = path.join(STATE_DIR || ROOT_DIR, "bot-message-ids.json");
const botMessageIds = new Set();
const agentResponseIds = new Set();

function saveBotIds() {
  const ids = [...botMessageIds].slice(-500);
  const agentIds = [...agentResponseIds].slice(-500);
  try { fs.writeFileSync(BOT_IDS_FILE, JSON.stringify({ ids, agentIds })); } catch {}
}

function loadBotIds() {
  try {
    const raw = JSON.parse(fs.readFileSync(BOT_IDS_FILE, "utf8"));
    const ids = Array.isArray(raw) ? raw : (raw.ids || []);
    const agentIds = Array.isArray(raw) ? [] : (raw.agentIds || []);
    for (const id of ids) botMessageIds.add(id);
    for (const id of agentIds) agentResponseIds.add(id);
    console.log(`[Bot] Loaded ${botMessageIds.size} bot message IDs (${agentResponseIds.size} agent responses)`);
  } catch {}
}

function sendToTeams(chatId, message, replyToId, isAgentResponse = false) {
  try {
    let cmd;
    if (replyToId) {
      cmd = `python3 ${REPLY_SCRIPT} --chat-id "${chatId}" --reply-to "${replyToId}" -m - --html --json`;
    } else {
      cmd = `python3 ${SCRIPTS_DIR}/send_chat.py --chat-id "${chatId}" -m - --html --json`;
    }
    const result = execSync(cmd, {
      timeout: 30000,
      input: message,
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const parsed = JSON.parse(result.toString());
      if (parsed.message_id) {
        botMessageIds.add(parsed.message_id);
        if (isAgentResponse) agentResponseIds.add(parsed.message_id);
        saveBotIds();
      }
    } catch {}
  } catch (err) {
    console.error("Failed to send to Teams:", err.message);
  }
}

function markdownToHtml(md) {
  const normalized = md.replace(/\\n/g, "\n");
  return marked.parse(normalized).trim();
}

function sendLargeOutput(chatId, output, replyToId) {
  const html = markdownToHtml(output);
  const MAX_CHUNK = 8000;

  if (html.length <= MAX_CHUNK) {
    sendToTeams(chatId, html, replyToId, true);
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
    sendToTeams(chatId, `${header}${chunks[i]}`, replyToId, true);
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
  if (msg.from && msg.from.startsWith("8:orgid:")) return true;
  const text = stripHtml(msg.content);
  if (!text) return true;
  if (text.startsWith("🚀") || text.startsWith("⏳") || text.startsWith("🤖") || text.startsWith("🔄") || text.startsWith("⚠️")) return true;
  if (text.startsWith("Failed to start agent")) return true;
  return false;
}

function isAgentResponse(msg) {
  return agentResponseIds.has(msg.id);
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
  isAgentResponse,
  fetchMessages,
  loadBotIds,
  botMessageIds,
  agentResponseIds,
};
