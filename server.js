const express = require("express");
const { PORT, CHAT_ID, POLL_INTERVAL, WORKSPACE_DIR } = require("./lib/config");
const { sendToTeams, escapeHtml } = require("./lib/teams-io");
const { pollChannel, pollThreads, getThreads } = require("./lib/threads");
const { buildRoutingContext } = require("./lib/agent-spawn");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  const threads = getThreads();
  const threadList = Array.from(threads.values()).sort(
    (a, b) => b.startTime - a.startTime
  );

  const rows = threadList
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
    pre { font-size: 12px; white-space: pre-wrap; max-height: 300px; overflow: auto; }
  </style>
</head>
<body>
  <h1>Teams Agents Dashboard</h1>
  <p class="info">
    Polling every ${POLL_INTERVAL / 1000}s |
    ${threads.size} active threads |
    Workspace: <code>${WORKSPACE_DIR}</code>
  </p>

  <h2>Active Threads</h2>
  <table>
    <tr><th>Thread</th><th>Status</th><th>From</th><th>Session</th><th>Age</th></tr>
    ${rows || "<tr><td colspan=5>No active threads</td></tr>"}
  </table>

  <h2>How to Use</h2>
  <p>Post a message in the monitored Teams channel. Each message starts a new agent thread.</p>
  <p>Reply in the thread to continue the conversation with the same agent session.</p>
  <p>The agent auto-discovers all workspace commands, skills, and agents from <code>${WORKSPACE_DIR}</code>.</p>
  <p>Native commands like <code>/goto</code>, <code>/orchestrate</code>, <code>/review-pr</code> work directly.</p>
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

  sendToTeams(
    `🤖 <b>Agent Bot Online</b><br><br>` +
      `Post a message to start a new agent session. Reply in the thread to continue.<br>` +
      `All workspace commands (<code>/goto</code>, <code>/orchestrate</code>, etc.) and agents are available.`
  );

  setInterval(pollChannel, POLL_INTERVAL);
  setInterval(pollThreads, POLL_INTERVAL + 1000);
  setTimeout(pollChannel, 2000);
});
