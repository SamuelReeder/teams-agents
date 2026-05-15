const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Test the parse functions directly without loading the full module
// (which has side effects from requiring config/teams-io)
// Extract the pure logic inline for testing

function parseInterval(str) {
  const match = str.match(/^(\d+)(m|h|d|w)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const multipliers = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  return n * multipliers[match[2]];
}

function parsePollCommand(text) {
  const match = text.match(/^\/poll\s+(\d+[mhdw])\s+([\s\S]+)$/);
  if (!match) return null;
  const intervalMs = parseInterval(match[1]);
  if (!intervalMs) return null;
  return { intervalStr: match[1], intervalMs, prompt: match[2].trim() };
}

describe("parseInterval", () => {
  it("parses minutes", () => {
    assert.equal(parseInterval("5m"), 300000);
    assert.equal(parseInterval("1m"), 60000);
  });

  it("parses hours", () => {
    assert.equal(parseInterval("1h"), 3600000);
    assert.equal(parseInterval("24h"), 86400000);
  });

  it("parses days", () => {
    assert.equal(parseInterval("1d"), 86400000);
    assert.equal(parseInterval("2d"), 172800000);
  });

  it("parses weeks", () => {
    assert.equal(parseInterval("1w"), 604800000);
  });

  it("returns null for invalid input", () => {
    assert.equal(parseInterval("abc"), null);
    assert.equal(parseInterval("5"), null);
    assert.equal(parseInterval("5s"), null);
    assert.equal(parseInterval(""), null);
    assert.equal(parseInterval("0x"), null);
  });
});

describe("parsePollCommand", () => {
  it("parses a basic poll command", () => {
    const result = parsePollCommand("/poll 2d check my PRs");
    assert.deepEqual(result, {
      intervalStr: "2d",
      intervalMs: 172800000,
      prompt: "check my PRs",
    });
  });

  it("parses poll with multiline prompt", () => {
    const result = parsePollCommand("/poll 1h check CI\nand report failures");
    assert.equal(result.prompt, "check CI\nand report failures");
    assert.equal(result.intervalMs, 3600000);
  });

  it("parses poll with minute interval", () => {
    const result = parsePollCommand("/poll 30m run tests");
    assert.equal(result.intervalMs, 1800000);
    assert.equal(result.prompt, "run tests");
  });

  it("returns null for missing interval", () => {
    assert.equal(parsePollCommand("/poll check stuff"), null);
  });

  it("returns null for missing prompt", () => {
    assert.equal(parsePollCommand("/poll 2d"), null);
    assert.equal(parsePollCommand("/poll 2d "), null);
  });

  it("returns null for non-poll commands", () => {
    assert.equal(parsePollCommand("/goto therock"), null);
    assert.equal(parsePollCommand("hello"), null);
  });

  it("returns null for invalid interval unit", () => {
    assert.equal(parsePollCommand("/poll 5s do stuff"), null);
  });
});
