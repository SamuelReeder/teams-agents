const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { isBotMessage } = require("../lib/teams-io");
const { classifyCommand, isAgentInvocation, commandTextForMessage, buildHelpMessage, listCronTasks, listWorkspaceCommands, listWorkspaceSkills } = require("../lib/threads");
const { getPolls } = require("../lib/polls");

function msg(content, from = "Reeder, Samuel") {
  return { id: "test-" + Math.random(), from, content, messagetype: "RichText/Html" };
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

  it("detects spawn error", () => {
    assert.equal(isBotMessage(msg("Failed to start agent: ENOENT")), true);
  });

  it("detects messages from orgid (Skype API sender)", () => {
    assert.equal(isBotMessage(msg("Some agent response text", "8:orgid:a82e0ded-b688-4e6e-b792-0831e6d334a9")), true);
  });

  it("does not flag normal user messages", () => {
    assert.equal(isBotMessage(msg("build hipDNN")), false);
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
    assert.equal(classifyMessage("build hipDNN"), "agent");
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

  it("recognizes bot commands in unprefixed channels", () => {
    assert.equal(commandTextForMessage(unprefixedChannel, "!help"), "!help");
    assert.equal(classifyCommand(commandTextForMessage(unprefixedChannel, "!help")), "help");
  });

  it("recognizes bare bot commands in prefixed channels", () => {
    assert.equal(commandTextForMessage(prefixedChannel, "!help"), "!help");
    assert.equal(classifyCommand(commandTextForMessage(prefixedChannel, "!help")), "help");
  });

  it("recognizes bot commands after the agent prefix", () => {
    assert.equal(isAgentInvocation(prefixedChannel, "!agent !help"), true);
    assert.equal(commandTextForMessage(prefixedChannel, "!agent !help"), "!help");
    assert.equal(classifyCommand(commandTextForMessage(prefixedChannel, "!agent !help")), "help");
  });

  it("does not treat agent requests as bot commands", () => {
    assert.equal(commandTextForMessage(prefixedChannel, "!agent build hipDNN"), null);
    assert.equal(commandTextForMessage(unprefixedChannel, "build hipDNN"), null);
  });
});

describe("Teams help content", () => {
  it("lists current workspace commands and skills", () => {
    const commandNames = listWorkspaceCommands().map((entry) => entry.name);
    const skillNames = listWorkspaceSkills().map((entry) => entry.name);
    const help = buildHelpMessage({ chatId: "19:test@thread.skype", prefix: "!agent" });

    assert.deepEqual(commandNames, ["orchestrate", "review-pr", "squash-prep", "worktrees"]);
    assert.ok(skillNames.includes("pr-summary"), "pr-summary skill is retained");
    assert.ok(skillNames.includes("hipdnn-superbuild-test"), "skills are listed from manifests");

    for (const removed of ["/descriptor", "/goto", "/prep-pr", "/create-pr", "/wip", "/task", "/status"]) {
      assert.equal(help.includes(`<code>${removed}`), false, `${removed} must not be in help`);
    }

    assert.ok(help.includes("<b>Skills</b>"), "help has a skills section");
    assert.ok(help.includes("<code>pr-summary</code>"), "help includes pr-summary skill");
    assert.ok(help.includes("<code>/worktrees</code>"), "help includes retained commands");
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
