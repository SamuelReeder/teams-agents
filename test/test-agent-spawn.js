const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Extract the pure function for testing without side effects
function extractFlags(message) {
  let remaining = message;
  const flags = {};

  const flagPattern = /^--(\w[\w-]*)\s+(\S+)\s*/;
  let match;
  while ((match = remaining.match(flagPattern))) {
    flags[match[1]] = match[2];
    remaining = remaining.slice(match[0].length);
  }

  return { flags, prompt: remaining };
}

describe("extractFlags", () => {
  it("extracts --model flag", () => {
    const result = extractFlags("--model opus hello world");
    assert.deepEqual(result.flags, { model: "opus" });
    assert.equal(result.prompt, "hello world");
  });

  it("extracts --effort flag", () => {
    const result = extractFlags("--effort max do something");
    assert.deepEqual(result.flags, { effort: "max" });
    assert.equal(result.prompt, "do something");
  });

  it("extracts both flags", () => {
    const result = extractFlags("--model claude-sonnet-4-6 --effort high explain this");
    assert.deepEqual(result.flags, {
      model: "claude-sonnet-4-6",
      effort: "high",
    });
    assert.equal(result.prompt, "explain this");
  });

  it("handles no flags", () => {
    const result = extractFlags("just a normal message");
    assert.deepEqual(result.flags, {});
    assert.equal(result.prompt, "just a normal message");
  });

  it("handles flags with no prompt", () => {
    const result = extractFlags("--model opus ");
    assert.deepEqual(result.flags, { model: "opus" });
    assert.equal(result.prompt, "");
  });

  it("does not extract flags from middle of message", () => {
    const result = extractFlags("hello --model opus world");
    assert.deepEqual(result.flags, {});
    assert.equal(result.prompt, "hello --model opus world");
  });

  it("handles exact model IDs", () => {
    const result = extractFlags("--model claude-opus-4-7 what is this");
    assert.equal(result.flags.model, "claude-opus-4-7");
  });

  it("handles haiku model alias", () => {
    const result = extractFlags("--model haiku quick question");
    assert.equal(result.flags.model, "haiku");
    assert.equal(result.prompt, "quick question");
  });

  it("handles slash commands after flags", () => {
    const result = extractFlags("--model opus /goto therock");
    assert.equal(result.flags.model, "opus");
    assert.equal(result.prompt, "/goto therock");
  });

  it("handles unknown flags (passed through)", () => {
    const result = extractFlags("--custom-flag value do thing");
    assert.deepEqual(result.flags, { "custom-flag": "value" });
    assert.equal(result.prompt, "do thing");
  });
});
