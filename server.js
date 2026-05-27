const express = require("express");
const { PORT, POLL_INTERVAL, WORKSPACE_DIR, HARNESS_BIN, HARNESS_CONFIG, AGENT_TIMEOUT_MS, MAX_CONCURRENT_AGENTS, loadChannels, ALOLA_CONFIG } = require("./lib/config");
const { escapeHtml, loadBotIds } = require("./lib/teams-io");
const { pollAllChannels, getThreads, loadThreadsFromDisk } = require("./lib/threads");
const { loadPollsFromDisk, getPolls } = require("./lib/polls");
const { coerceAlolaMetadata, describeAlolaTarget } = require("./lib/alola-session");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  const threads = getThreads();
  const polls = getPolls();
  const threadList = Array.from(threads.values()).sort(
    (a, b) => b.startTime - a.startTime
  );

  const channels = loadChannels();
  const channelLabel = (chatId) => {
    const ch = channels.find((c) => c.chatId === chatId);
    return ch ? escapeHtml(ch.label) : (chatId || "?").slice(0, 20);
  };

  const alolaSummary = (thread) => {
    const metadata = coerceAlolaMetadata(thread.alola, thread);
    if (!metadata) return "HPE local";
    return describeAlolaTarget(metadata);
  };

  const threadRows = threadList
    .map((t) => {
      const status = t.busy ? "🔄 Working" : "💤 Idle";
      const age = `${((Date.now() - t.startTime) / 60000).toFixed(0)}m`;
      return `<tr>
        <td>${channelLabel(t.chatId)}</td>
        <td>${t.rootMessageId}</td>
        <td>${status}</td>
        <td>${escapeHtml(t.from)}</td>
        <td>${t.sessionId.slice(0, 8)}...</td>
        <td>${escapeHtml(alolaSummary(t))}</td>
        <td>${age}</td>
      </tr>`;
    })
    .join("\n");

  const pollRows = Array.from(polls.values())
    .map((p) => {
      const status = p.busy ? "🔄 Running" : "💤 Waiting";
      const lastRun = p.lastRun
        ? new Date(p.lastRun).toLocaleString()
        : "never";
      return `<tr>
        <td>${channelLabel(p.chatId)}</td>
        <td>${p.id}</td>
        <td>${status}</td>
        <td>every ${p.intervalStr}</td>
        <td>${escapeHtml(p.prompt.slice(0, 80))}</td>
        <td>${lastRun}</td>
      </tr>`;
    })
    .join("\n");

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Teams Agents Dashboard</title>
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
  <h1>Teams Agents Dashboard</h1>
  <p class="info">
    Polling every ${POLL_INTERVAL / 1000}s |
    ${channels.length} channels |
    ${threads.size} active threads |
    ${polls.size} active polls |
    Workspace: <code>${WORKSPACE_DIR}</code>
  </p>

  <h2>Channels</h2>
  <table>
    <tr><th>Label</th><th>Prefix</th><th>Chat ID</th></tr>
    ${channels.map((ch) => `<tr><td>${escapeHtml(ch.label)}</td><td>${ch.prefix ? `<code>${escapeHtml(ch.prefix)}</code>` : "(none)"}</td><td><code>${escapeHtml(ch.chatId).slice(0, 40)}...</code></td></tr>`).join("\n")}
  </table>

  <h2>Active Threads</h2>
  <table>
    <tr><th>Channel</th><th>Thread</th><th>Status</th><th>From</th><th>Session</th><th>Alola target</th><th>Age</th></tr>
    ${threadRows || "<tr><td colspan=7>No active threads</td></tr>"}
  </table>

  <h2>Active Polls</h2>
  <table>
    <tr><th>Channel</th><th>ID</th><th>Status</th><th>Interval</th><th>Prompt</th><th>Last Run</th></tr>
    ${pollRows || "<tr><td colspan=6>No active polls</td></tr>"}
  </table>

  <h2>Commands</h2>
  <p><code>!help</code> — show usage info</p>
  <p><code>!cron &lt;interval&gt; &lt;prompt&gt;</code> — start a recurring task (e.g., <code>!cron 2d check my open PRs</code>). Expires after 20 runs.</p>
  <p><code>!cron-restart &lt;id&gt;</code> — restart an expired or cancelled task</p>
  <p><code>!cron-cancel &lt;id&gt;</code> — cancel a task</p>
  <p><code>!crons</code> — list active recurring tasks</p>
  <p><code>--alola</code> keeps the harness local to HPE while selecting a durable Alola session target. Default: login ${ALOLA_CONFIG.defaultLoginNode}/${ALOLA_CONFIG.defaultAsic}; GPU target example: <code>--alola gfx942</code>.</p>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Teams agents server on http://localhost:${PORT}`);
  console.log(`Workspace: ${WORKSPACE_DIR}`);
  console.log(`Harness: ${HARNESS_BIN}`);
  console.log(`Default model: ${HARNESS_CONFIG.defaultModel || "(none)"}`);
  console.log(`Alola default model: ${HARNESS_CONFIG.alolaDefaultModel || "(none)"}`);
  console.log(`Poll interval: ${POLL_INTERVAL}ms | Max concurrent agents: ${MAX_CONCURRENT_AGENTS} | Agent timeout: ${(AGENT_TIMEOUT_MS / 60000).toFixed(0)}m`);

  const channels = loadChannels();
  if (channels.length === 0) {
    console.error("ERROR: Set TEAMS_CHAT_ID in .env or create channels.json");
    process.exit(1);
  }

  for (const ch of channels) {
    const prefix = ch.prefix ? ` (prefix: ${ch.prefix})` : "";
    const model = ch.defaultModel ? ` model=${ch.defaultModel}` : "";
    console.log(`Monitoring: ${ch.label}${prefix}${model}`);
  }

  loadBotIds();
  loadThreadsFromDisk();
  loadPollsFromDisk();

  setInterval(pollAllChannels, POLL_INTERVAL);
  setTimeout(pollAllChannels, 2000);
});
