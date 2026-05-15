const express = require("express");
const { spawn, execSync } = require("child_process");
const { randomUUID } = require("crypto");
const path = require("path");
const fs = require("fs");

// Load .env
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3978;
const CHAT_ID = process.env.TEAMS_CHAT_ID;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "5000", 10);
const SCRIPTS_DIR = path.join(process.env.HOME, ".claude/skills/m365-teams/scripts");
const REPLY_SCRIPT = path.join(__dirname, "reply.py");

// Skills define the agent personality via system prompt
const SKILLS = {
  "/review": {
    name: "Code Reviewer",
    prompt: "You are a senior code reviewer. Review code for bugs, security issues, performance problems, and best practices. Be thorough but concise.",
  },
  "/security": {
    name: "Security Analyst",
    prompt: "You are a security analyst. Focus on identifying vulnerabilities, misconfigurations, and security risks. Reference OWASP and CWE where applicable.",
  },
  "/explain": {
    name: "Code Explainer",
    prompt: "You are a patient code explainer. Break down complex code into understandable parts. Explain the why, not just the what.",
  },
  "/debug": {
    name: "Debugger",
    prompt: "You are an expert debugger. Help diagnose and fix issues. Ask clarifying questions if needed. Focus on root cause analysis.",
  },
  "/architect": {
    name: "Architect",
    prompt: "You are a software architect. Help with system design, architecture decisions, and technical planning. Consider trade-offs and scalability.",
  },
  "/ops": {
    name: "DevOps Engineer",
    prompt: "You are a DevOps engineer. Help with infrastructure, CI/CD, deployment, monitoring, and operational concerns.",
  },
  "/alola3": {
    name: "Alola-3 (Remote)",
    prompt: `You are working on remote machine ctr2-alola-login-03. Run ALL commands via the SSH wrapper script: ~/teams-bot/ssh-alola3.sh "<command>". Never run commands locally — always use the wrapper. You can chain commands with && inside the quotes. When the user asks you to do something, do it on the remote machine.`,
  },
  "/alola4": {
    name: "Alola-4 (Remote)",
    prompt: `You are working on remote machine ctr2-alola-login-04. Run ALL commands via the SSH wrapper script: ~/teams-bot/ssh-alola4.sh "<command>". Never run commands locally — always use the wrapper. You can chain commands with && inside the quotes. When the user asks you to do something, do it on the remote machine.`,
  },
};

// Thread state: maps root message ID -> session info
const threads = new Map();
// Track message IDs sent by the bot to avoid self-triggering
const botMessageIds = new Set();
let lastSeenMessageId = null;
let lastSeenTimestamp = null;

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

function truncate(str, maxLen = 2000) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "\n... (truncated)";
}

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

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseSkill(text) {
  const match = text.match(/^(\/\w+)\s*([\s\S]*)$/);
  if (match && SKILLS[match[1]]) {
    return { skill: match[1], config: SKILLS[match[1]], message: match[2].trim() };
  }
  return { skill: null, config: null, message: text };
}

function spawnAgent(threadInfo, message, replyToId) {
  const claudePath = process.env.HOME + "/.local/bin/claude";
  const args = ["--print"];

  if (threadInfo.isFollowUp) {
    args.push("--resume", threadInfo.sessionId);
  } else {
    args.push("--session-id", threadInfo.sessionId);
    if (threadInfo.systemPrompt) {
      args.push("--system-prompt", threadInfo.systemPrompt);
    }
  }

  args.push("-p", message);

  console.log(`[Thread ${threadInfo.rootMessageId}] Spawning claude (session: ${threadInfo.sessionId.slice(0, 8)}..., follow-up: ${threadInfo.isFollowUp})`);

  const proc = spawn(claudePath, args, {
    cwd: process.env.HOME,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  proc.on("close", (code) => {
    const result = stdout || stderr || "(no output)";
    threadInfo.busy = false;
    console.log(`[Thread ${threadInfo.rootMessageId}] Done (exit ${code})`);
    sendToTeams(truncate(result), replyToId);
  });

  proc.on("error", (err) => {
    threadInfo.busy = false;
    console.error(`[Thread ${threadInfo.rootMessageId}] Spawn error:`, err.message);
    sendToTeams(`Failed to start agent: ${err.message}`, replyToId);
  });
}

function handleNewThread(text, from, messageId) {
  if (!text || !messageId) return;

  const { skill, config, message } = parseSkill(text);
  const sessionId = randomUUID();

  const threadInfo = {
    rootMessageId: messageId,
    sessionId,
    skillName: config ? config.name : "General",
    systemPrompt: config ? config.prompt : null,
    from,
    startTime: new Date(),
    isFollowUp: false,
    busy: true,
    lastSeen: null,
  };

  threads.set(messageId, threadInfo);

  const prompt = message || text;
  const skillLabel = config ? `<b>[${config.name}]</b> ` : "";
  sendToTeams(`🚀 ${skillLabel}Processing...`, messageId);

  spawnAgent(threadInfo, prompt, messageId);
}

function handleThreadReply(threadInfo, text, from, messageId) {
  if (threadInfo.busy) {
    sendToTeams("⏳ Still working on the previous message, please wait...", threadInfo.rootMessageId);
    return;
  }

  threadInfo.isFollowUp = true;
  threadInfo.busy = true;

  console.log(`[Thread ${threadInfo.rootMessageId}] Follow-up from ${from}: "${text.slice(0, 80)}"`);
  spawnAgent(threadInfo, text, threadInfo.rootMessageId);
}

function pollChannel() {
  try {
    const result = execSync(
      `python3 ${SCRIPTS_DIR}/list_messages.py --chat-id "${CHAT_ID}" --limit 10 --json`,
      { timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }
    );

    const messages = JSON.parse(result.toString());
    if (!messages || messages.length === 0) return;

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
        if (botMessageIds.has(msg.id)) continue;
        const text = stripHtml(msg.content);
        if (!text) continue;
        // Skip bot's own messages by content pattern
        if (text.startsWith("🚀") || text.startsWith("⏳") || text.startsWith("🤖")) continue;
        if (text.startsWith("Failed to start agent")) continue;

        const from = msg.from || "unknown";
        console.log(`[Poll] New channel message from ${from} (id=${msg.id}): "${text.slice(0, 80)}"`);
        handleNewThread(text, from, msg.id);
      }
    }
  } catch (err) {
    console.error("[Poll:channel] Error:", err.message);
  }
}

function pollThreads() {
  for (const [rootId, threadInfo] of threads) {
    // Skip threads older than 24 hours
    if (Date.now() - threadInfo.startTime > 24 * 60 * 60 * 1000) {
      threads.delete(rootId);
      continue;
    }

    try {
      const threadConvId = `${CHAT_ID};messageid=${rootId}`;
      const result = execSync(
        `python3 ${SCRIPTS_DIR}/list_messages.py --chat-id "${threadConvId}" --limit 5 --json`,
        { timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }
      );

      const messages = JSON.parse(result.toString());
      if (!messages || messages.length === 0) continue;

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
          if (botMessageIds.has(msg.id)) continue;
          const text = stripHtml(msg.content);
          if (!text) continue;
          if (text.startsWith("🚀") || text.startsWith("⏳") || text.startsWith("🤖")) continue;
          if (text.startsWith("Failed to start agent")) continue;

          const from = msg.from || "unknown";
          handleThreadReply(threadInfo, text, from, msg.id);
        }
      }
    } catch (err) {
      // Thread might not exist yet, ignore
    }
  }
}

// Dashboard
app.get("/", (req, res) => {
  const threadList = Array.from(threads.values()).sort((a, b) => b.startTime - a.startTime);

  const rows = threadList
    .map((t) => {
      const status = t.busy ? "🔄 Working" : "💤 Idle";
      const age = `${((Date.now() - t.startTime) / 60000).toFixed(0)}m`;
      return `<tr>
        <td>${t.rootMessageId}</td>
        <td>${status}</td>
        <td>${escapeHtml(t.skillName)}</td>
        <td>${escapeHtml(t.from)}</td>
        <td>${t.sessionId.slice(0, 8)}...</td>
        <td>${age}</td>
      </tr>`;
    })
    .join("\n");

  const skillList = Object.entries(SKILLS)
    .map(([cmd, s]) => `<tr><td><code>${cmd}</code></td><td>${escapeHtml(s.name)}</td></tr>`)
    .join("\n");

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Teams Bot - Agent Dashboard</title>
  <meta http-equiv="refresh" content="10">
  <style>
    body { font-family: system-ui; margin: 2rem; background: #1a1a2e; color: #eee; }
    h1, h2 { color: #e94560; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
    th, td { border: 1px solid #333; padding: 8px; text-align: left; }
    th { background: #16213e; }
    tr:nth-child(even) { background: #0f3460; }
    code { background: #16213e; padding: 2px 6px; border-radius: 3px; }
    .info { color: #aaa; }
  </style>
</head>
<body>
  <h1>Agent Dashboard</h1>
  <p class="info">Polling every ${POLL_INTERVAL / 1000}s | ${threads.size} active threads</p>

  <h2>Active Threads</h2>
  <table>
    <tr><th>Thread</th><th>Status</th><th>Agent</th><th>From</th><th>Session</th><th>Age</th></tr>
    ${rows || "<tr><td colspan=6>No active threads</td></tr>"}
  </table>

  <h2>Available Skills</h2>
  <table>
    <tr><th>Command</th><th>Agent Type</th></tr>
    ${skillList}
    <tr><td><i>(no prefix)</i></td><td>General Assistant</td></tr>
  </table>
</body>
</html>`);
});

// Start
app.listen(PORT, () => {
  console.log(`Teams bot server running on http://localhost:${PORT}`);
  console.log(`Monitoring: ${CHAT_ID}`);
  console.log(`Poll interval: ${POLL_INTERVAL}ms`);
  console.log(`Skills: ${Object.keys(SKILLS).join(", ")}`);

  if (!CHAT_ID) {
    console.error("ERROR: Set TEAMS_CHAT_ID in .env");
    process.exit(1);
  }

  const skillHelp = Object.entries(SKILLS)
    .map(([cmd, s]) => `<b>${cmd}</b> — ${s.name}`)
    .join("<br>");

  sendToTeams(
    `🤖 <b>Agent Bot Online</b><br><br>` +
    `Post a message to start a new agent thread. Reply in the thread to continue the conversation.<br><br>` +
    `<b>Available skills:</b><br>${skillHelp}<br><br>` +
    `Or just post without a prefix for a general assistant.`
  );

  setInterval(pollChannel, POLL_INTERVAL);
  setInterval(pollThreads, POLL_INTERVAL + 1000);
  setTimeout(pollChannel, 2000);
});
