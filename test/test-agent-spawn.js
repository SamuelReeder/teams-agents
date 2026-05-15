const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Mirror the extractFlags logic for testing
function extractFlags(message) {
  let remaining = message;
  const flags = {};

  while (true) {
    let match = remaining.match(/^--alola(?:\s+(\d{2}))?\s+/);
    if (match) {
      flags.alola = match[1] || "03";
      remaining = remaining.slice(match[0].length);
      continue;
    }

    match = remaining.match(/^--(\w[\w-]*)\s+(\S+)\s*/);
    if (match) {
      flags[match[1]] = match[2];
      remaining = remaining.slice(match[0].length);
      continue;
    }

    break;
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

  it("does not extract flags from middle of message", () => {
    const result = extractFlags("hello --model opus world");
    assert.deepEqual(result.flags, {});
    assert.equal(result.prompt, "hello --model opus world");
  });

  it("handles --alola with default node", () => {
    const result = extractFlags("--alola build hipDNN");
    assert.equal(result.flags.alola, "03");
    assert.equal(result.prompt, "build hipDNN");
  });

  it("handles --alola with specific node", () => {
    const result = extractFlags("--alola 04 build hipDNN");
    assert.equal(result.flags.alola, "04");
    assert.equal(result.prompt, "build hipDNN");
  });

  it("handles --alola with --model and --effort", () => {
    const result = extractFlags("--alola 04 --model opus --effort max run tests");
    assert.deepEqual(result.flags, {
      alola: "04",
      model: "opus",
      effort: "max",
    });
    assert.equal(result.prompt, "run tests");
  });

  it("handles --alola before other flags", () => {
    const result = extractFlags("--model haiku --alola check GPU");
    assert.equal(result.flags.model, "haiku");
    assert.equal(result.flags.alola, "03");
    assert.equal(result.prompt, "check GPU");
  });

  it("handles slash commands after flags", () => {
    const result = extractFlags("--alola /goto therock");
    assert.equal(result.flags.alola, "03");
    assert.equal(result.prompt, "/goto therock");
  });
});
