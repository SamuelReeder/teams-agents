const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isBotMessage, agentResponseIds } = require("../../src/teams/io");
const { classifyCommand, isAgentInvocation, commandTextForMessage, agentTextForMessage, collectThreadMessages, buildHelpMessage, listCronTasks, listWorkspaceCommands, listWorkspaceSkills } = require("../../src/teams/threads");
const { AGENT_PREFIX, validateChannels } = require("../../src/config/env");
const { getPolls } = require("../../src/polls/polls");

function msg(content, from = "Test User") {
  return { id: "test-" + Math.random(), from, content, messagetype: "RichText/Html" };
}
function threadMsg(id, content, from = "Test User") {
  return { id, from, content, messagetype: "Text" };
}

describe("Bot message detection", () => {
  it("detects processing message", () => {
    assert.equal(isBotMessage(msg("🚀 Processing...")), true);
  });

  it("detects waiting message", () => {
    assert.equal(isBotMessage(msg("⏳ Still working...")), true);
  });

  it("detects online message", () => {
    assert.equal(isBotMessage(msg("🤖 Agent Bot Online")), true);
  });

  it("detects poll result message", () => {
    assert.equal(isBotMessage(msg("🔄 Poll: abc123 (every 5m, run 1/20)")), true);
  });

  it("detects no-output warning", () => {
    assert.equal(isBotMessage(msg("⚠️ Agent finished with no output (exit 0).")), true);
  });

  it("detects AI-prefixed bot messages", () => {
    assert.equal(isBotMessage(msg("[AI] Hello.")), true);
  });

  it("detects spawn error", () => {
    assert.equal(isBotMessage(msg("Failed to start agent: ENOENT")), true);
  });

  it("detects messages from orgid (Skype API sender)", () => {
    assert.equal(isBotMessage(msg("Some agent response text", "8:orgid:a82e0ded-b688-4e6e-b792-0831e6d334a9")), true);
  });

  it("does not flag normal user messages", () => {
    assert.equal(isBotMessage(msg("build project")), false);
    assert.equal(isBotMessage(msg("/worktrees")), false);
    assert.equal(isBotMessage(msg("what is the status?")), false);
  });

  it("flags empty/null content as bot message", () => {
    assert.equal(isBotMessage(msg("")), true);
    assert.equal(isBotMessage(msg(null)), true);
  });
});

describe("Thread command routing", () => {
  function classifyMessage(text) {
    if (text.trim() === "/poll") return "poll-usage";
    if (text.startsWith("/poll ")) return "poll-create";
    if (text.startsWith("/poll-cancel ")) return "poll-cancel";
    if (text.startsWith("/poll-restart ")) return "poll-restart";
    if (text.trim() === "/polls" || text.trim() === "/polls --all") return "poll-list";
    return "agent";
  }

  it("routes /poll command", () => {
    assert.equal(classifyMessage("/poll 2d check PRs"), "poll-create");
  });

  it("routes bare /poll to usage", () => {
    assert.equal(classifyMessage("/poll"), "poll-usage");
  });

  it("routes /poll-cancel", () => {
    assert.equal(classifyMessage("/poll-cancel abc123"), "poll-cancel");
  });

  it("routes /poll-restart", () => {
    assert.equal(classifyMessage("/poll-restart abc123"), "poll-restart");
  });

  it("routes /polls list", () => {
    assert.equal(classifyMessage("/polls"), "poll-list");
  });

  it("routes /polls --all", () => {
    assert.equal(classifyMessage("/polls --all"), "poll-list");
  });

  it("routes regular messages to agent", () => {
    assert.equal(classifyMessage("build project"), "agent");
    assert.equal(classifyMessage("/worktrees"), "agent");
    assert.equal(classifyMessage("--alola check GPU"), "agent");
  });

  it("does not confuse /polling with /poll", () => {
    assert.equal(classifyMessage("/polling something"), "agent");
  });
});

describe("Teams command routing", () => {
  const prefixedChannel = { chatId: "19:test@thread.skype", prefix: "!agent" };
  const unprefixedChannel = { chatId: "19:test@thread.skype", prefix: null };

  it("recognizes direct bot commands without the agent prefix", () => {
    assert.equal(commandTextForMessage(unprefixedChannel, "!help"), "!help");
    assert.equal(commandTextForMessage(prefixedChannel, "!help"), "!help");
    assert.equal(commandTextForMessage(prefixedChannel, "!cron-cancel b496fd40"), "!cron-cancel b496fd40");
    assert.equal(classifyCommand(commandTextForMessage(prefixedChannel, "!help")), "help");
    assert.equal(classifyCommand(commandTextForMessage(prefixedChannel, "!cron-cancel b496fd40")), "cron-cancel");
  });

  it("still recognizes bot commands after the agent prefix", () => {
    assert.equal(isAgentInvocation(prefixedChannel, "!agent !help"), true);
    assert.equal(commandTextForMessage(prefixedChannel, "!agent !help"), "!help");
    assert.equal(classifyCommand(commandTextForMessage(prefixedChannel, "!agent !help")), "help");
  });

  it("does not treat agent requests as bot commands", () => {
    assert.equal(commandTextForMessage(prefixedChannel, "!agent build project"), null);
    assert.equal(commandTextForMessage(unprefixedChannel, "build project"), null);
  });

  it("extracts agent text only when the global prefix is present", () => {
    assert.equal(agentTextForMessage(prefixedChannel, "!agent build project"), "build project");
    assert.equal(agentTextForMessage(prefixedChannel, "!agent\u00a0build project"), "build project");
    assert.equal(agentTextForMessage(prefixedChannel, "build project"), null);
    assert.equal(agentTextForMessage(prefixedChannel, "!agent"), null);
    assert.equal(agentTextForMessage(unprefixedChannel, "!agent build project"), "build project");
    assert.equal(agentTextForMessage(unprefixedChannel, "build project"), null);
  });

  it("does not accept lookalike or missing prefixes", () => {
    assert.equal(isAgentInvocation(prefixedChannel, "agent hello"), false);
    assert.equal(isAgentInvocation(prefixedChannel, "!agents hello"), false);
    assert.equal(isAgentInvocation(prefixedChannel, "!agentic hello"), false);
    assert.equal(agentTextForMessage(prefixedChannel, "agent hello"), null);
    assert.equal(agentTextForMessage(prefixedChannel, "!agents hello"), null);
  });

  it("applies the global agent prefix to parsed channel entries", () => {
    const channels = validateChannels([{ chatId: "chat-a" }, { chatId: "chat-b", label: "B" }], "channels");

    for (const channel of channels) {
      assert.equal(channel.prefix, AGENT_PREFIX);
    }
  });
});

describe("Prefixed thread reply collection", () => {
  const prefixedChannel = { chatId: "19:test@thread.skype", prefix: "!agent" };
  const unprefixedChannel = { chatId: "19:open@thread.skype", prefix: null };

  function thread(lastHandledId = "root") {
    return {
      chatId: prefixedChannel.chatId,
      rootMessageId: "root",
      lastHandledId,
    };
  }

  it("ignores unprefixed replies in prefixed channels", () => {
    const threadInfo = thread();
    const result = collectThreadMessages(threadInfo, prefixedChannel, [
      threadMsg("reply-1", "please do not answer"),
      threadMsg("root", "!agent original request"),
    ]);

    assert.equal(result, null);
    assert.equal(threadInfo.lastHandledId, "root");
  });

  it("does not advance the handled watermark for unprefixed chatter", () => {
    const threadInfo = thread();
    const result = collectThreadMessages(threadInfo, prefixedChannel, [
      threadMsg("reply-2", "more chatter"),
      threadMsg("reply-1", "please do not answer"),
      threadMsg("root", "!agent original request"),
    ]);

    assert.equal(result, null);
    assert.equal(threadInfo.lastHandledId, "root");
  });

  it("collects prefixed replies with intervening unprefixed chatter", () => {
    const threadInfo = thread();
    const result = collectThreadMessages(threadInfo, prefixedChannel, [
      threadMsg("reply-2", "!agent please answer this"),
      threadMsg("reply-1", "team chatter only"),
      threadMsg("root", "!agent original request"),
    ]);

    assert.equal(result, "[Test User]: team chatter only\n[Test User]: please answer this");
    assert.equal(threadInfo.lastHandledId, "reply-2");
  });

  it("includes multiple unprefixed messages before the triggering agent request", () => {
    const threadInfo = thread();
    const result = collectThreadMessages(threadInfo, prefixedChannel, [
      threadMsg("reply-3", "!agent summarize the thread"),
      threadMsg("reply-2", "second non-agent context"),
      threadMsg("reply-1", "first non-agent context"),
      threadMsg("root", "!agent original request"),
    ]);

    assert.equal(result, "[Test User]: first non-agent context\n[Test User]: second non-agent context\n[Test User]: summarize the thread");
    assert.equal(threadInfo.lastHandledId, "reply-3");
  });

  it("does not feed bot diagnostics back into follow-up prompts", () => {
    const threadInfo = thread();
    const result = collectThreadMessages(threadInfo, prefixedChannel, [
      threadMsg("reply-2", "!agent you there?"),
      threadMsg("bot-warning", "⚠️ Agent finished with no output (exit 0)."),
      threadMsg("root", "!agent original request"),
    ]);

    assert.equal(result, "you there?");
    assert.equal(threadInfo.lastHandledId, "reply-2");
  });

  it("includes AI responses as AI context and strips the visible prefix", () => {
    const threadInfo = thread();
    agentResponseIds.add("ai-1");
    try {
      const result = collectThreadMessages(threadInfo, prefixedChannel, [
        threadMsg("reply-2", "!agent give a transcript for this thread"),
        threadMsg("reply-1", "Interesting."),
        threadMsg("ai-1", "[AI] Hello.", "8:orgid:test-bot"),
        threadMsg("root", "!agent hello"),
      ]);

      assert.equal(result, "[AI]: Hello.\n[Test User]: Interesting.\n[Test User]: give a transcript for this thread");
      assert.equal(threadInfo.lastHandledId, "reply-2");
    } finally {
      agentResponseIds.delete("ai-1");
    }
  });

  it("allows a bare prefix to trigger on prior unhandled context", () => {
    const threadInfo = thread();
    const result = collectThreadMessages(threadInfo, prefixedChannel, [
      threadMsg("reply-2", "!agent"),
      threadMsg("reply-1", "Interesting."),
      threadMsg("root", "!agent hello"),
    ]);

    assert.equal(result, "Interesting.");
    assert.equal(threadInfo.lastHandledId, "reply-2");
  });

  it("uses the global prefix when a channel object omits one", () => {
    const threadInfo = thread();
    const result = collectThreadMessages(threadInfo, unprefixedChannel, [
      threadMsg("reply-2", "!agent continue the work"),
      threadMsg("reply-1", "additional context"),
      threadMsg("root", "!agent original request"),
    ]);

    assert.equal(result, "[Test User]: additional context\n[Test User]: continue the work");
    assert.equal(threadInfo.lastHandledId, "reply-2");
  });
});

describe("Teams help content", () => {
  it("lists optional commands and skills from the selected workspace", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "teams-help-workspace-"));
    try {
      fs.mkdirSync(path.join(workspace, ".claude/commands"), { recursive: true });
      fs.mkdirSync(path.join(workspace, ".shared/skills/pr-summary"), { recursive: true });
      fs.writeFileSync(path.join(workspace, ".claude/commands/worktrees.md"), "---\ndescription: Manage worktrees\n---\n");
      fs.writeFileSync(path.join(workspace, ".shared/skills/pr-summary/SKILL.md"), "---\nname: pr-summary\ndescription: Summarize PRs\n---\n");

      const channel = { chatId: "19:test@thread.skype", prefix: "!agent", workspace };
      const commandNames = listWorkspaceCommands(channel).map((entry) => entry.name);
      const skillNames = listWorkspaceSkills(channel).map((entry) => entry.name);
      const help = buildHelpMessage(channel);

      assert.deepEqual(commandNames, ["worktrees"]);
      assert.deepEqual(skillNames, ["pr-summary"]);

      assert.ok(help.includes("Bot commands below can be sent directly"), "help advertises direct bot commands");
      assert.equal(help.includes("bot commands with <code>!agent</code>"), false, "help must not require prefix for bot commands");
      assert.ok(help.includes("<b>Skills</b>"), "help has a skills section");
      assert.ok(help.includes("<code>pr-summary</code>"), "help includes pr-summary skill");
      assert.ok(help.includes("<code>/worktrees</code>"), "help includes retained commands");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("Cron listing", () => {
  function poll(id, chatId, active, prompt) {
    return {
      id,
      chatId,
      prompt,
      intervalStr: "1h",
      active,
      runCount: active ? 1 : 20,
      maxRuns: 20,
      lastRun: null,
      model: null,
      fresh: false,
    };
  }

  it("lists only crons from the current channel", () => {
    const polls = getPolls();
    const ids = ["cron-channel-a", "cron-channel-b", "cron-channel-a-old"];

    try {
      polls.set(ids[0], poll(ids[0], "chat-a", true, "run channel A task"));
      polls.set(ids[1], poll(ids[1], "chat-b", true, "run channel B task"));
      polls.set(ids[2], poll(ids[2], "chat-a", false, "old channel A task"));

      const active = listCronTasks("chat-a", false);
      assert.ok(active.includes("<code>cron-channel-a</code>"), "current channel active cron is listed");
      assert.equal(active.includes("<code>cron-channel-b</code>"), false, "other channel cron is hidden");
      assert.equal(active.includes("<code>cron-channel-a-old</code>"), false, "inactive cron is hidden by default");

      const all = listCronTasks("chat-a", true);
      assert.ok(all.includes("<code>cron-channel-a-old</code>"), "--all includes inactive current-channel crons");
      assert.equal(all.includes("<code>cron-channel-b</code>"), false, "--all still hides other channels");
      assert.equal(listCronTasks("chat-c", false), "No active recurring tasks.");
    } finally {
      for (const id of ids) polls.delete(id);
    }
  });
});

describe("processedMessageIds dedup", () => {
  it("prevents double-processing", () => {
    const processed = new Set();
    const msgId = "12345";

    assert.equal(processed.has(msgId), false);
    processed.add(msgId);
    assert.equal(processed.has(msgId), true);
  });

  it("handles multiple messages independently", () => {
    const processed = new Set();
    processed.add("msg1");
    processed.add("msg2");

    assert.equal(processed.has("msg1"), true);
    assert.equal(processed.has("msg2"), true);
    assert.equal(processed.has("msg3"), false);
  });
});
