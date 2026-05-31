const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  MAX_CONCURRENT_AGENTS,
  ROOT_DIR,
  STATE_DIR,
  THREAD_TTL_MS,
  AGENT_PREFIX,
  ALOLA_SESSION_BIN,
  loadChannels,
  resolveWorkspace,
  workspaceFromPersisted,
  attachWorkspace,
  channelMaxConcurrentAgents,
  channelDefaultModel,
  channelAlolaDefaultModel,
} = require("../config/env");
const { sendToTeams, stripHtml, escapeHtml, isBotMessage, isAgentResponse, fetchMessages, AI_PREFIX } = require("./io");
const { spawnAgent, finalizeSession, existingThreadSessionDir } = require("../agents/spawn");
const { coerceAlolaMetadata } = require("../alola/session");
const { createPoll, cancelPoll, restartPoll, getPollForResultThread, getPollsForChat, hasPollResultThread } = require("../polls/polls");

const THREADS_FILE = path.join(STATE_DIR || ROOT_DIR, "threads.json");

const threads = new Map();
const processedMessageIds = new Set();
const channelState = new Map();

function threadKey(chatId, rootMessageId) {
  return `${chatId || "default"}::${rootMessageId}`;
}

function processedMessageKey(chatId, messageId) {
  return `${chatId || "default"}::${messageId}`;
}

function getChannelConfig(chatId) {
  try {
    const channels = loadChannels();
    return channels.find((ch) => ch.chatId === chatId) || null;
  } catch (err) {
    if (/Channel config file does not exist/.test(err.message)) return null;
    throw err;
  }
}

function fallbackChannel(chatId) {
  return getChannelConfig(chatId) || {
    chatId: chatId || null,
    label: chatId || "Default",
    prefix: AGENT_PREFIX,
    defaultModel: null,
    alolaDefaultModel: null,
    workspace: null,
    maxConcurrentAgents: null,
  };
}

function workspaceForChannel(channel) {
  if (channel?.resolvedWorkspace) return channel.resolvedWorkspace;
  const workspace = resolveWorkspace(channel || null);
  if (channel) channel.resolvedWorkspace = workspace;
  return workspace;
}

function workspaceForPersistedThread(record, chatId) {
  if (record.workspaceDir) return workspaceFromPersisted(record.workspaceId, record.workspaceDir, record.workspaceSource || "persisted");
  return resolveWorkspace(fallbackChannel(chatId));
}

function applyChannelDefaults(threadInfo, channel) {
  const ch = channel || fallbackChannel(threadInfo.chatId);
  if (!threadInfo.defaultModel) threadInfo.defaultModel = channelDefaultModel(ch);
  if (!threadInfo.alolaDefaultModel) threadInfo.alolaDefaultModel = channelAlolaDefaultModel(ch);
  if (!threadInfo.maxConcurrentAgents) threadInfo.maxConcurrentAgents = channelMaxConcurrentAgents(ch);
  if (!threadInfo.workspaceDir) attachWorkspace(threadInfo, workspaceForChannel(ch));
  return threadInfo;
}

function saveThreadsToDisk() {
  const data = [];
  for (const [key, t] of threads) {
    if (!t.workspaceDir) applyChannelDefaults(t, fallbackChannel(t.chatId));
    const alola = coerceAlolaMetadata(t.alola, t);
    data.push({
      mapKey: key !== t.rootMessageId ? key : undefined,
      rootMessageId: t.rootMessageId,
      chatId: t.chatId || null,
      workspaceId: t.workspaceId || null,
      workspaceDir: t.workspaceDir || null,
      workspaceSource: t.workspaceSource || null,
      sessionId: t.sessionId,
      harnessSessionId: t.harnessSessionId || null,
      from: t.from,
      startTime: t.startTime instanceof Date ? t.startTime.toISOString() : t.startTime,
      lastSeen: t.lastSeen || null,
      lastHandledId: t.lastHandledId || null,
      model: t.model || null,
      defaultModel: t.defaultModel || null,
      alolaDefaultModel: t.alolaDefaultModel || null,
      maxConcurrentAgents: t.maxConcurrentAgents || null,
      alola: alola || null,
    });
  }
  fs.writeFileSync(THREADS_FILE, JSON.stringify(data, null, 2));
}

function loadThreadsFromDisk() {
  if (!fs.existsSync(THREADS_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(THREADS_FILE, "utf8"));
    const now = Date.now();
    let restored = 0;
    for (const t of data) {
      const age = now - new Date(t.startTime).getTime();
      if (age > THREAD_TTL_MS) continue;

      const chatId = t.chatId || null;
      const channel = fallbackChannel(chatId);
      const workspace = workspaceForPersistedThread(t, chatId);
      let harnessSessionId = t.harnessSessionId;
      if (!harnessSessionId) {
        try {
          harnessSessionId = finalizeSession(existingThreadSessionDir(t.rootMessageId, workspace)) || null;
        } catch {}
      }

      const mapKey = t.mapKey || threadKey(chatId, t.rootMessageId);
      const restoredThread = attachWorkspace({
        rootMessageId: t.rootMessageId,
        chatId,
        sessionId: t.sessionId,
        harnessSessionId,
        from: t.from,
        startTime: new Date(t.startTime),
        isFollowUp: true,
        busy: false,
        lastSeen: t.lastSeen || t.rootMessageId,
        lastHandledId: t.lastHandledId || t.lastSeen || null,
        childPid: null,
        model: t.model || undefined,
        defaultModel: t.defaultModel || channelDefaultModel(channel),
        alolaDefaultModel: t.alolaDefaultModel || channelAlolaDefaultModel(channel),
        maxConcurrentAgents: t.maxConcurrentAgents || channelMaxConcurrentAgents(channel),
        alola: undefined,
      }, workspace);
      restoredThread.alola = coerceAlolaMetadata(t.alola, restoredThread) || undefined;
      threads.set(mapKey, restoredThread);

      processedMessageIds.add(processedMessageKey(restoredThread.chatId, restoredThread.rootMessageId));
      restored++;
    }
    console.log(`[Threads] Restored ${restored} threads from disk`);
  } catch (err) {
    console.error("[Threads] Failed to load threads:", err.message);
  }
}

function classifyCommand(text) {
  const trimmed = text.trim();
  if (trimmed === "!help") return "help";
  if (trimmed === "!models" || text.startsWith("!models ")) return "models";
  if (trimmed === "!cron") return "cron-usage";
  if (text.startsWith("!cron ")) return "cron-create";
  if (text.startsWith("!cron-cancel ")) return "cron-cancel";
  if (text.startsWith("!cron-restart ")) return "cron-restart";
  if (trimmed === "!crons" || trimmed === "!crons --all") return "cron-list";
  return null;
}

function frontmatterField(content, field) {
  const match = content.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  if (!match) return null;

  const value = match[1].trim();
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "\"" || first === "'") && last === first) {
    return value.slice(1, -1);
  }
  return value;
}

function resolveWorkspaceInput(input) {
  if (input?.dir) return input;
  if (input?.chatId || input?.workspace !== undefined) return workspaceForChannel(input);
  return resolveWorkspace();
}

function listWorkspaceCommands(input = null) {
  try {
    const workspace = resolveWorkspaceInput(input);
    const commandsDir = path.join(workspace.dir, ".claude/commands");
    return fs.readdirSync(commandsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => {
        const name = entry.name.slice(0, -3);
        const content = fs.readFileSync(path.join(commandsDir, entry.name), "utf8");
        return {
          name,
          description: frontmatterField(content, "description") || "Workspace command",
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function listWorkspaceSkills(input = null) {
  try {
    const workspace = resolveWorkspaceInput(input);
    const skillsDir = path.join(workspace.dir, ".shared/skills");
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const content = fs.readFileSync(path.join(skillsDir, entry.name, "SKILL.md"), "utf8");
        return {
          name: frontmatterField(content, "name") || entry.name,
          description: frontmatterField(content, "description") || "Workspace skill",
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function helpEntriesHtml(entries, codePrefix = "") {
  if (entries.length === 0) return "None configured.<br>";
  return entries
    .map((entry) => `<code>${codePrefix}${escapeHtml(entry.name)}</code> — ${escapeHtml(entry.description)}`)
    .join("<br>") + "<br>";
}

function buildHelpMessage(channel) {
  const prefix = channelPrefix(channel);
  const workspace = (() => {
    try { return workspaceForChannel(channel); } catch { return null; }
  })();
  const prefixNote = prefix
    ? `Prefix agent requests and thread replies with <code>${escapeHtml(prefix)}</code>. Bot commands below can be sent directly.<br><br>`
    : `Post a message to start a new agent session. Reply in a thread to continue the conversation. Bot commands below can be sent directly.<br><br>`;
  const examplePrefix = prefix ? `${prefix} ` : "";
  const workspaceLine = workspace
    ? `<b>Workspace</b>: <code>${escapeHtml(workspace.dir)}</code><br><br>`
    : "";

  return `<b>Teams Agents</b><br><br>` +
    prefixNote +
    workspaceLine +
    `<b>Flags</b> (prefix your message):<br>` +
    `<code>--alola</code> — keep the agent on the controller host, target the default Alola login session (node ${escapeHtml(require("../config/env").ALOLA_CONFIG.defaultLoginNode)}, ${escapeHtml(require("../config/env").ALOLA_CONFIG.defaultAsic)})<br>` +
    `<code>--alola 04</code>, <code>--alola gfx942</code>, <code>--alola 03 gfx950</code>, <code>--alola gpu:gfx90a</code> — select login node or non-exclusive GPU allocation<br>` +
    `<code>--&lt;flag&gt; [value]</code> — forwarded verbatim to the harness before the prompt<br>` +
    `<code>--</code> — end harness flags, useful before prompts that start with dashes<br><br>` +
    `<b>Execution</b>: agents run locally in the selected workspace. ROCm builds/tests/benchmarks, CMake/Ninja/ctest, provider verification, hipcc, rocminfo, and GPU work should use durable Alola sessions through <code>${escapeHtml(ALOLA_SESSION_BIN)}</code>.<br><br>` +
    `<b>Commands</b>:<br>` +
    `<code>!help</code> — this message<br>` +
    `<code>!models [filter]</code> — list available models (e.g. <code>!models haiku</code>)<br>` +
    `<code>!cron &lt;interval&gt; [--fresh] &lt;prompt&gt;</code> — recurring agent (e.g. <code>!cron 2d check my PRs</code>; <code>--fresh</code> = no session memory between runs)<br>` +
    `<code>!cron-cancel &lt;id&gt;</code> — cancel a recurring task<br>` +
    `<code>!cron-restart &lt;id&gt;</code> — restart an expired recurring task<br>` +
    `<code>!crons</code> — list this channel's active recurring tasks (<code>!crons --all</code> includes cancelled/expired)<br><br>` +
    `<b>Workspace commands</b> (passed to the harness):<br>` +
    helpEntriesHtml(listWorkspaceCommands(workspace || channel), "/") +
    `<br><b>Skills</b> (ask for them by name):<br>` +
    helpEntriesHtml(listWorkspaceSkills(workspace || channel)) +
    `<br><b>Examples</b>:<br>` +
    `<code>${escapeHtml(examplePrefix)}Build hipDNN in the relevant worktree</code> — agent uses the default Alola login session for build work<br>` +
    `<code>${escapeHtml(examplePrefix)}--alola gfx942 run rocminfo and verify the MI300 path</code><br>` +
    `<code>${escapeHtml(examplePrefix)}--model opus explain the hipDNN provider architecture</code><br>` +
    `<code>!cron 1d check CI status on my open PRs</code>`;
}

function listCronTasks(chatId, showAll) {
  const list = getPollsForChat(chatId, showAll);
  if (list.length === 0) return showAll ? "No recurring tasks." : "No active recurring tasks.";

  const lines = list.map((p) => {
    const lastRun = p.lastRun ? new Date(p.lastRun).toLocaleString() : "never";
    const status = p.active ? "▶️" : "⏹️";
    const model = p.model ? ` [${p.model}]` : "";
    const fresh = p.fresh ? " (fresh)" : "";
    return `${status} <code>${p.id}</code>: every ${p.intervalStr}${model}${fresh} — ${p.prompt.slice(0, 60)} (${p.runCount}/${p.maxRuns}, last: ${lastRun})`;
  });
  return lines.join("<br>");
}

function handleCommand(channel, text, from, replyToId) {
  const chatId = channel.chatId;
  const kind = classifyCommand(text);
  if (!kind) return false;

  if (kind === "help") {
    sendToTeams(chatId, buildHelpMessage(channel), replyToId);
    return true;
  }

  if (kind === "models") {
    const { execSync } = require("child_process");
    const { HARNESS_BIN } = require("../config/env");
    const search = text.trim() === "!models" ? "" : text.slice("!models ".length).trim();
    try {
      const out = execSync(`${HARNESS_BIN} --list-models=${search}`, {
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
      }).toString();
      const lines = out.split("\n").filter((l) => l.trim()).slice(0, 80);
      const filterNote = search ? ` (filter: <code>${search}</code>)` : "";
      sendToTeams(chatId,
        `<b>Available models${filterNote}</b><br><pre>${lines.join("\n")}</pre>`,
        replyToId
      );
    } catch (err) {
      sendToTeams(chatId, `Failed to list models: ${err.message}`, replyToId);
    }
    return true;
  }

  if (kind === "cron-usage") {
    sendToTeams(chatId,
      `Usage: <code>!cron &lt;interval&gt; &lt;prompt&gt;</code><br>` +
        `Example: <code>!cron 2d check my open PRs</code><br>` +
        `Intervals: <code>Nm</code> (minutes), <code>Nh</code> (hours), <code>Nd</code> (days), <code>Nw</code> (weeks)`,
      replyToId
    );
    return true;
  }

  if (kind === "cron-create") {
    createPoll(channel, "/poll " + text.slice("!cron ".length), from, replyToId);
    return true;
  }

  if (kind === "cron-cancel") {
    const cancelled = cancelPoll("/poll-cancel " + text.slice("!cron-cancel ".length), chatId);
    sendToTeams(chatId, cancelled ? "✅ Cancelled." : "❌ Not found.", replyToId);
    return true;
  }

  if (kind === "cron-restart") {
    const restarted = restartPoll("/poll-restart " + text.slice("!cron-restart ".length), replyToId, chatId);
    if (!restarted) sendToTeams(chatId, "❌ Not found.", replyToId);
    return true;
  }

  if (kind === "cron-list") {
    const showAll = text.trim() === "!crons --all";
    sendToTeams(chatId, listCronTasks(chatId, showAll), replyToId);
    return true;
  }

  return false;
}

function channelPrefix(channel) {
  return (channel && channel.prefix) || AGENT_PREFIX;
}

function isAgentInvocation(channel, text) {
  return stripPrefix(text, channelPrefix(channel)) !== null;
}

function commandTextForMessage(channel, text) {
  if (!text.startsWith("!")) return null;
  if (classifyCommand(text)) return text;

  const stripped = stripPrefix(text, channelPrefix(channel));
  return stripped && stripped.startsWith("!") && classifyCommand(stripped) ? stripped : null;
}

function handleNewThread(channel, text, from, messageId) {
  const chatId = channel.chatId;
  if (!text || !messageId) return;

  processedMessageIds.add(processedMessageKey(chatId, messageId));
  const workspace = workspaceForChannel(channel);
  const threadInfo = attachWorkspace({
    rootMessageId: messageId,
    chatId,
    sessionId: randomUUID(),
    from,
    startTime: new Date(),
    isFollowUp: false,
    busy: true,
    lastSeen: messageId,
    lastHandledId: messageId,
    childPid: null,
    defaultModel: channelDefaultModel(channel),
    alolaDefaultModel: channelAlolaDefaultModel(channel),
    maxConcurrentAgents: channelMaxConcurrentAgents(channel),
  }, workspace);

  threads.set(threadKey(chatId, messageId), threadInfo);
  saveThreadsToDisk();
  console.log(`[Thread ${messageId}] New session ${threadInfo.sessionId.slice(0, 8)}... from ${from} workspace=${workspace.id}`);

  sendToTeams(chatId, `${AI_PREFIX} 🚀 Processing...`, messageId);
  spawnAgent(threadInfo, text, messageId, threadInfo.maxConcurrentAgents || MAX_CONCURRENT_AGENTS);
}

function stripAiPrefix(text) {
  return text.replace(/^\[AI\](?:\s+\d+\/\d+)?\s*/i, "").trim();
}

function threadContextTextForMessage(channel, text) {
  const stripped = stripPrefix(text, channelPrefix(channel));
  return stripped === null ? text : stripped;
}

function collectThreadMessages(threadInfo, channel, messages) {
  if (messages.length === 0) return null;

  const chronological = messages.slice().reverse();

  let startAfter = -1;
  if (threadInfo.lastHandledId) {
    for (let i = chronological.length - 1; i >= 0; i--) {
      if (chronological[i].id === threadInfo.lastHandledId) {
        startAfter = i;
        break;
      }
    }
  }
  if (startAfter === -1) {
    for (let i = chronological.length - 1; i >= 0; i--) {
      if (isAgentResponse(chronological[i])) {
        startAfter = i;
        break;
      }
    }
  }

  const collected = [];
  let hasAgentInvocation = false;
  let lastHandledId = null;
  for (let i = startAfter + 1; i < chronological.length; i++) {
    const msg = chronological[i];
    if (msg.messagetype !== "RichText/Html" && msg.messagetype !== "Text") continue;
    const text = stripHtml(msg.content);
    if (!text) continue;

    if (isAgentResponse(msg)) {
      const aiText = stripAiPrefix(text);
      if (aiText) {
        collected.push({ id: msg.id, text: aiText, from: "AI" });
        lastHandledId = msg.id;
      }
      continue;
    }
    if (isBotMessage(msg)) continue;

    const invokesAgent = isAgentInvocation(channel, text);
    const processedText = threadContextTextForMessage(channel, text);
    if (invokesAgent) {
      hasAgentInvocation = true;
      lastHandledId = msg.id;
    }
    if (!processedText) continue;

    collected.push({ id: msg.id, text: processedText, from: msg.from || "User" });
    lastHandledId = msg.id;
  }

  if (!hasAgentInvocation || collected.length === 0) return null;

  threadInfo.lastHandledId = lastHandledId || collected[collected.length - 1].id;

  if (collected.length === 1) return collected[0].text;
  return collected.map((m) => `[${m.from}]: ${m.text}`).join("\n");
}

function gatherThreadMessages(threadInfo) {
  if (!threadInfo.chatId) return null;
  const channel = fallbackChannel(threadInfo.chatId);
  applyChannelDefaults(threadInfo, channel);
  const rootId = threadInfo.rootMessageId;
  const threadConvId = `${threadInfo.chatId};messageid=${rootId}`;
  const messages = fetchMessages(threadConvId, 50);
  return collectThreadMessages(threadInfo, channel, messages);
}

function handleThreadReply(threadInfo) {
  const channel = fallbackChannel(threadInfo.chatId);
  applyChannelDefaults(threadInfo, channel);
  if (threadInfo.busy) {
    threadInfo.hasPending = true;
    sendToTeams(threadInfo.chatId, `${AI_PREFIX} 🚀 Processing... (queued after current run)`, threadInfo.rootMessageId);
    return;
  }

  const text = gatherThreadMessages(threadInfo);
  if (!text) return;

  threadInfo.isFollowUp = true;
  threadInfo.busy = true;
  threadInfo.hasPending = false;

  sendToTeams(threadInfo.chatId, `${AI_PREFIX} 🚀 Processing...`, threadInfo.rootMessageId);
  console.log(`[Thread ${threadInfo.rootMessageId}] Follow-up: "${text.slice(0, 80)}"`);
  spawnAgent(threadInfo, text, threadInfo.rootMessageId, threadInfo.maxConcurrentAgents || channelMaxConcurrentAgents(channel));
}

function handlePollResultReply(poll, from, messageId, rootMessageId) {
  const chatId = poll.chatId || null;
  const key = threadKey(chatId, rootMessageId);
  processedMessageIds.add(processedMessageKey(chatId, messageId));

  if (!threads.has(key)) {
    const workspace = poll.workspaceDir
      ? workspaceFromPersisted(poll.workspaceId, poll.workspaceDir, poll.workspaceSource || "poll")
      : resolveWorkspace(fallbackChannel(chatId));
    threads.set(key, attachWorkspace({
      rootMessageId,
      chatId,
      sessionId: poll.sessionId,
      harnessSessionId: poll.harnessSessionId || null,
      from,
      startTime: new Date(),
      isFollowUp: true,
      busy: false,
      lastSeen: messageId,
      childPid: null,
      model: poll.model || undefined,
      defaultModel: poll.defaultModel || undefined,
      alolaDefaultModel: poll.alolaDefaultModel || undefined,
      maxConcurrentAgents: poll.maxConcurrentAgents || undefined,
    }, workspace));
    saveThreadsToDisk();
  }

  handleThreadReply(threads.get(key));
}

function stripPrefix(text, prefix) {
  if (!prefix) return text;
  if (text === prefix) return "";
  if (!text.startsWith(prefix)) return null;
  const next = text[prefix.length];
  if (!next || !/\s/u.test(next)) return null;
  return text.slice(prefix.length + 1).trimStart();
}
function agentTextForMessage(channel, text) {
  const stripped = stripPrefix(text, channelPrefix(channel));
  return stripped ? stripped : null;
}

function pollSingleChannel(channel) {
  const { chatId } = channel;
  try {
    workspaceForChannel(channel);
  } catch (err) {
    console.error(`[Poll] Channel ${channel.label || chatId} disabled: ${err.message}`);
    return;
  }
  const messages = fetchMessages(chatId, 10);
  if (messages.length === 0) return;

  if (!channelState.has(chatId)) {
    channelState.set(chatId, { id: messages[0].id, time: messages[0].time });
    messages.forEach((m) => processedMessageIds.add(processedMessageKey(chatId, m.id)));
    console.log(`[Poll] Initial sync ${channel.label} — latest: ${messages[0].id}`);
    return;
  }

  const state = channelState.get(chatId);
  const newMessages = [];
  for (const msg of messages) {
    if (msg.id === state.id) break;
    if (msg.time && state.time && msg.time <= state.time) break;
    newMessages.push(msg);
  }

  if (newMessages.length > 0) {
    state.id = newMessages[0].id;
    state.time = newMessages[0].time;

    for (const msg of newMessages.reverse()) {
      if (processedMessageIds.has(processedMessageKey(chatId, msg.id))) continue;
      if (msg.messagetype !== "RichText/Html" && msg.messagetype !== "Text") continue;
      if (isBotMessage(msg)) {
        processedMessageIds.add(processedMessageKey(chatId, msg.id));
        continue;
      }

      const text = stripHtml(msg.content);
      if (!text) continue;

      processedMessageIds.add(processedMessageKey(chatId, msg.id));
      const from = msg.from || "unknown";
      const rootId = msg.rootMessageId || msg.id;
      const isReply = rootId !== msg.id;
      const replyTarget = isReply ? rootId : msg.id;
      const key = threadKey(chatId, rootId);

      const commandText = commandTextForMessage(channel, text);
      if (commandText && handleCommand(channel, commandText, from, replyTarget)) {
        console.log(`[Poll] Handled command "${commandText.slice(0, 40)}" in ${channel.label}`);
        continue;
      }

      const agentText = agentTextForMessage(channel, text);
      const agentInvoked = isAgentInvocation(channel, text);

      if (isReply && hasPollResultThread(rootId, chatId)) {
        if (!agentInvoked) {
          console.log(`[Poll] Ignoring poll-result reply in ${channel.label} without ${channel.prefix} prefix`);
          continue;
        }
        const poll = getPollForResultThread(rootId, chatId);
        if (poll) {
          console.log(`[Poll] Routing to poll result thread ${rootId}: "${text.slice(0, 60)}"`);
          handlePollResultReply(poll, from, msg.id, rootId);
          continue;
        }
      }

      if (isReply && threads.has(key)) {
        if (!agentInvoked) {
          console.log(`[Poll] Ignoring reply to thread ${rootId} in ${channel.label} without ${channel.prefix} prefix`);
          continue;
        }
        const threadInfo = threads.get(key);
        applyChannelDefaults(threadInfo, channel);
        console.log(`[Poll] Routing reply to thread ${rootId}: "${text.slice(0, 60)}"`);
        threadInfo.lastSeen = msg.id;
        handleThreadReply(threadInfo);
        continue;
      }

      if (isReply) {
        if (!agentInvoked) continue;
        if (!threads.has(key)) {
          const threadInfo = attachWorkspace({
            rootMessageId: rootId,
            chatId,
            sessionId: randomUUID(),
            from,
            startTime: new Date(),
            isFollowUp: false,
            busy: false,
            lastSeen: msg.id,
            lastHandledId: null,
            childPid: null,
            defaultModel: channelDefaultModel(channel),
            alolaDefaultModel: channelAlolaDefaultModel(channel),
            maxConcurrentAgents: channelMaxConcurrentAgents(channel),
          }, workspaceForChannel(channel));
          threads.set(key, threadInfo);
          saveThreadsToDisk();
          console.log(`[Thread ${rootId}] Adopted untracked thread for ${channel.label} reply`);
        }
        const threadInfo = threads.get(key);
        threadInfo.lastSeen = msg.id;
        handleThreadReply(threadInfo);
        continue;
      }

      if (!agentInvoked || !agentText) continue;
      console.log(`[Poll] New thread from ${from} in ${channel.label} (id=${msg.id}): "${agentText.slice(0, 60)}"`);
      handleNewThread(channel, agentText, from, msg.id);
    }
  }
}

function pollAllChannels() {
  expireOldThreads();
  const channels = loadChannels();
  for (const channel of channels) {
    pollSingleChannel(channel);
  }
}

function expireOldThreads() {
  for (const [rootId, threadInfo] of threads) {
    if (Date.now() - threadInfo.startTime > THREAD_TTL_MS) {
      threads.delete(rootId);
    }
  }
}

function getThreads() {
  return threads;
}

module.exports = {
  pollAllChannels,
  pollSingleChannel,
  getThreads,
  threadKey,
  processedMessageKey,
  saveThreadsToDisk,
  loadThreadsFromDisk,
  gatherThreadMessages,
  collectThreadMessages,
  classifyCommand,
  isAgentInvocation,
  commandTextForMessage,
  agentTextForMessage,
  buildHelpMessage,
  listCronTasks,
  listWorkspaceCommands,
  listWorkspaceSkills,
  getChannelConfig,
};
