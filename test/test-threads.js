const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("Bot message detection", () => {
  function isBotMessageByContent(text) {
    if (!text) return true;
    if (text.startsWith("🚀") || text.startsWith("⏳") || text.startsWith("🤖")) return true;
    if (text.startsWith("Failed to start agent")) return true;
    return false;
  }

  it("detects processing message", () => {
    assert.equal(isBotMessageByContent("🚀 Processing..."), true);
  });

  it("detects waiting message", () => {
    assert.equal(isBotMessageByContent("⏳ Still working..."), true);
  });

  it("detects online message", () => {
    assert.equal(isBotMessageByContent("🤖 Agent Bot Online"), true);
  });

  it("detects spawn error", () => {
    assert.equal(isBotMessageByContent("Failed to start agent: ENOENT"), true);
  });

  it("does not flag normal messages", () => {
    assert.equal(isBotMessageByContent("build hipDNN"), false);
    assert.equal(isBotMessageByContent("/goto therock"), false);
    assert.equal(isBotMessageByContent("what is the status?"), false);
  });

  it("flags empty/null as bot message", () => {
    assert.equal(isBotMessageByContent(""), true);
    assert.equal(isBotMessageByContent(null), true);
  });
});

describe("Thread command routing", () => {
  function classifyMessage(text) {
    if (text.startsWith("/poll ")) return "poll-create";
    if (text.startsWith("/poll-cancel ")) return "poll-cancel";
    if (text.startsWith("/poll-restart ")) return "poll-restart";
    if (text.trim() === "/polls") return "poll-list";
    return "agent";
  }

  it("routes /poll command", () => {
    assert.equal(classifyMessage("/poll 2d check PRs"), "poll-create");
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
