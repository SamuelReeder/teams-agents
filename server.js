const express = require("express");
const { PORT, CHAT_ID, POLL_INTERVAL, WORKSPACE_DIR } = require("./lib/config");
const { sendToTeams, escapeHtml } = require("./lib/teams-io");
const { pollChannel, pollThreads, getThreads, loadThreadsFromDisk } = require("./lib/threads");
const { loadPollsFromDisk, getPolls } = require("./lib/polls");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  const threads = getThreads();
  const polls = getPolls();
  const threadList = Array.from(threads.values()).sort(
    (a, b) => b.startTime - a.startTime
  );

  const threadRows = threadList
    .map((t) => {
      const status = t.busy ? "🔄 Working" : "💤 Idle";
      const age = `${((Date.now() - t.startTime) / 60000).toFixed(0)}m`;
      return `<tr>
        <td>${t.rootMessageId}</td>
        <td>${status}</td>
        <td>${escapeHtml(t.from)}</td>
        <td>${t.sessionId.slice(0, 8)}...</td>
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
    ${threads.size} active threads |
    ${polls.size} active polls |
    Workspace: <code>${WORKSPACE_DIR}</code>
  </p>

  <h2>Active Threads</h2>
  <table>
    <tr><th>Thread</th><th>Status</th><th>From</th><th>Session</th><th>Age</th></tr>
    ${threadRows || "<tr><td colspan=5>No active threads</td></tr>"}
  </table>

  <h2>Active Polls</h2>
  <table>
    <tr><th>ID</th><th>Status</th><th>Interval</th><th>Prompt</th><th>Last Run</th></tr>
    ${pollRows || "<tr><td colspan=5>No active polls</td></tr>"}
  </table>

  <h2>Commands</h2>
  <p><code>/poll &lt;interval&gt; &lt;prompt&gt;</code> — start a recurring poll (e.g., <code>/poll 2d check my open PRs</code>). Expires after 20 runs.</p>
  <p><code>/poll-restart &lt;id&gt;</code> — restart an expired or cancelled poll</p>
  <p><code>/poll-cancel &lt;id&gt;</code> — cancel a poll</p>
  <p><code>/polls</code> — list active polls</p>
  <p><code>--&lt;flag&gt; [value]</code> — prefix harness flags; <code>--alola</code> is reserved for routing</p>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Teams agents server on http://localhost:${PORT}`);
  console.log(`Workspace: ${WORKSPACE_DIR}`);
  console.log(`Monitoring: ${CHAT_ID}`);
  console.log(`Poll interval: ${POLL_INTERVAL}ms`);

  if (!CHAT_ID) {
    console.error("ERROR: Set TEAMS_CHAT_ID in .env");
    process.exit(1);
  }

  loadThreadsFromDisk();
  loadPollsFromDisk();

  setInterval(pollChannel, POLL_INTERVAL);
  setInterval(pollThreads, POLL_INTERVAL + 1000);
  setTimeout(pollChannel, 2000);
});
