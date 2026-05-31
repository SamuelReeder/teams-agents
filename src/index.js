const express = require("express");
const {
  PORT,
  POLL_INTERVAL,
  HARNESS_BIN,
  HARNESS_CONFIG,
  AGENT_TIMEOUT_MS,
  MAX_CONCURRENT_AGENTS,
  loadChannels,
  resolveWorkspace,
  channelMaxConcurrentAgents,
  ALOLA_CONFIG,
  redactSecrets,
} = require("./config/env");
const { escapeHtml, loadBotIds } = require("./teams/io");
const { pollAllChannels, getThreads, loadThreadsFromDisk } = require("./teams/threads");
const { loadPollsFromDisk, getPolls } = require("./polls/polls");
const { coerceAlolaMetadata, describeAlolaTarget } = require("./alola/session");

const app = express();
app.use(express.json());

function channelWorkspace(channel) {
  try {
    return channel.resolvedWorkspace || resolveWorkspace(channel);
  } catch (err) {
    return { id: "invalid", dir: err.message, source: "error" };
  }
}

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
        <td>${escapeHtml(t.rootMessageId)}</td>
        <td>${status}</td>
        <td>${escapeHtml(t.from || "?")}</td>
        <td>${escapeHtml(t.sessionId || "").slice(0, 8)}...</td>
        <td><code>${escapeHtml(t.workspaceDir || "?")}</code></td>
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
        <td>${escapeHtml(p.id)}</td>
        <td>${status}</td>
        <td>every ${escapeHtml(p.intervalStr)}</td>
        <td><code>${escapeHtml(p.workspaceDir || "?")}</code></td>
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
    ${polls.size} active polls
  </p>

  <h2>Channels</h2>
  <table>
    <tr><th>Label</th><th>Prefix</th><th>Max Agents</th><th>Workspace</th><th>Chat ID</th></tr>
    ${channels.map((ch) => {
      const ws = channelWorkspace(ch);
      return `<tr><td>${escapeHtml(ch.label)}</td><td>${ch.prefix ? `<code>${escapeHtml(ch.prefix)}</code>` : "(none)"}</td><td>${channelMaxConcurrentAgents(ch)}</td><td><code>${escapeHtml(ws.dir)}</code></td><td><code>${escapeHtml(ch.chatId).slice(0, 40)}...</code></td></tr>`;
    }).join("\n")}
  </table>

  <h2>Active Threads</h2>
  <table>
    <tr><th>Channel</th><th>Thread</th><th>Status</th><th>From</th><th>Session</th><th>Workspace</th><th>Alola target</th><th>Age</th></tr>
    ${threadRows || "<tr><td colspan=8>No active threads</td></tr>"}
  </table>

  <h2>Active Polls</h2>
  <table>
    <tr><th>Channel</th><th>ID</th><th>Status</th><th>Interval</th><th>Workspace</th><th>Prompt</th><th>Last Run</th></tr>
    ${pollRows || "<tr><td colspan=7>No active polls</td></tr>"}
  </table>

  <h2>Commands</h2>
  <p><code>!help</code> — show usage info</p>
  <p><code>!cron &lt;interval&gt; &lt;prompt&gt;</code> — start a recurring task (e.g. <code>!cron 2d check my open PRs</code>). Expires after 20 runs.</p>
  <p><code>!cron-restart &lt;id&gt;</code> — restart an expired or cancelled task</p>
  <p><code>!cron-cancel &lt;id&gt;</code> — cancel a task</p>
  <p><code>!crons</code> — list active recurring tasks</p>
  <p><code>--alola</code> keeps the harness local while selecting a durable Alola session target. Default: login ${ALOLA_CONFIG.defaultLoginNode}/${ALOLA_CONFIG.defaultAsic}; GPU target example: <code>--alola gfx942</code>.</p>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Teams agents server on http://localhost:${PORT}`);
  console.log(`Harness: ${redactSecrets(HARNESS_BIN)}`);
  console.log(`Default model: ${HARNESS_CONFIG.defaultModel || "(none)"}`);
  console.log(`Alola default model: ${HARNESS_CONFIG.alolaDefaultModel || "(none)"}`);
  console.log(`Poll interval: ${POLL_INTERVAL}ms | Max concurrent agents: ${MAX_CONCURRENT_AGENTS} | Agent timeout: ${(AGENT_TIMEOUT_MS / 60000).toFixed(0)}m`);

  const channels = loadChannels();
  if (channels.length === 0) {
    console.error("ERROR: Set TEAMS_CHAT_ID in .env or create config/channels.json");
    process.exit(1);
  }

  try {
    for (const ch of channels) {
      ch.resolvedWorkspace = resolveWorkspace(ch);
      const prefix = ch.prefix ? ` (prefix: ${ch.prefix})` : "";
      const model = ch.defaultModel ? ` model=${ch.defaultModel}` : "";
      const concurrency = ch.maxConcurrentAgents ? ` maxAgents=${ch.maxConcurrentAgents}` : "";
      console.log(`Monitoring: ${ch.label}${prefix}${model}${concurrency} workspace=${redactSecrets(ch.resolvedWorkspace.dir)}`);
    }
  } catch (err) {
    console.error(`ERROR: ${redactSecrets(err.message)}`);
    process.exit(1);
  }

  loadBotIds();
  loadThreadsFromDisk();
  loadPollsFromDisk();

  setInterval(pollAllChannels, POLL_INTERVAL);
  setTimeout(pollAllChannels, 2000);
});
