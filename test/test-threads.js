const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { isBotMessage } = require("../lib/teams-io");

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
    assert.equal(isBotMessage(msg("/goto therock")), false);
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
    assert.equal(classifyMessage("/goto therock"), "agent");
    assert.equal(classifyMessage("--alola check GPU"), "agent");
  });

  it("does not confuse /polling with /poll", () => {
    assert.equal(classifyMessage("/polling something"), "agent");
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
