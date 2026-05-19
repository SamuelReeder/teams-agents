const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const {
  extractFlags,
  buildHarnessArgs,
  prepareHarnessArgs,
  getProjectDirs,
} = require("../lib/agent-spawn");
const { HARNESS_CONFIG, MCP_CONFIG } = require("../lib/config");

const projectDirs = getProjectDirs();

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

describe("buildHarnessArgs", () => {
  const promptFlag = HARNESS_CONFIG.flags.prompt;
  const sessionFlag = HARNESS_CONFIG.flags.sessionId;
  const resumeFlag = HARNESS_CONFIG.flags.resume;

  it("includes session identifier for new threads", () => {
    const threadInfo = { sessionId: "session-new", isFollowUp: false };
    const args = buildHarnessArgs(threadInfo, "do work", {});

    assert.ok(args.includes("do work"), "prompt missing");
    if (promptFlag) {
      const promptIndex = args.lastIndexOf(promptFlag);
      assert.notEqual(promptIndex, -1);
      assert.equal(args[promptIndex + 1], "do work");
    }
    assert.ok(args.includes(threadInfo.sessionId), "session id missing");

    if (sessionFlag) {
      const index = args.indexOf(sessionFlag);
      assert.notEqual(index, -1);
      assert.equal(args[index + 1], threadInfo.sessionId);
    }

    if (HARNESS_CONFIG.skipPermissions && HARNESS_CONFIG.flags.skipPermissions) {
      assert.ok(args.includes(HARNESS_CONFIG.flags.skipPermissions));
    }

    const modelFlag = HARNESS_CONFIG.flags.model;
    if (HARNESS_CONFIG.defaultModel && modelFlag) {
      const modelIndex = args.lastIndexOf(modelFlag);
      assert.notEqual(modelIndex, -1);
      assert.equal(args[modelIndex + 1], HARNESS_CONFIG.defaultModel);
      assert.equal(threadInfo.model, HARNESS_CONFIG.defaultModel);
    } else {
      assert.strictEqual(threadInfo.model, undefined);
    }
  });

  it("uses resume flag for follow-up threads when available", () => {
    const threadInfo = { sessionId: "session-follow", isFollowUp: true };
    const args = buildHarnessArgs(threadInfo, "follow up", {});

    assert.ok(args.includes(threadInfo.sessionId), "session id missing");

    if (resumeFlag) {
      const index = args.indexOf(resumeFlag);
      assert.notEqual(index, -1);
      assert.equal(args[index + 1], threadInfo.sessionId);
    } else if (sessionFlag) {
      const sessionIndex = args.indexOf(sessionFlag);
      assert.equal(sessionIndex, -1);
    }
    const modelFlag = HARNESS_CONFIG.flags.model;
    if (HARNESS_CONFIG.defaultModel && modelFlag) {
      assert.equal(args.indexOf(modelFlag), -1);
    }
    assert.strictEqual(threadInfo.model, undefined);
  });
  it("reuses stored model for follow-up threads", () => {
    const modelFlag = HARNESS_CONFIG.flags.model;
    if (!modelFlag) return;

    const threadInfo = {
      sessionId: "session-follow-model",
      isFollowUp: true,
      model: "stored-model",
    };
    const args = buildHarnessArgs(threadInfo, "continue work", {});
    const index = args.lastIndexOf(modelFlag);
    assert.notEqual(index, -1);
    assert.equal(args[index + 1], "stored-model");
    assert.equal(threadInfo.model, "stored-model");
  });
  it("respects explicit model overrides", () => {
    const modelFlag = HARNESS_CONFIG.flags.model;
    if (!modelFlag) return;

    const threadInfo = { sessionId: "session-model", isFollowUp: false };
    const args = buildHarnessArgs(threadInfo, "custom model", { model: "custom-model" });

    const occurrences = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === modelFlag) occurrences.push(i);
    }

    assert.ok(occurrences.length >= 1);
    for (const index of occurrences) {
      assert.equal(args[index + 1], "custom-model");
    }

    if (HARNESS_CONFIG.defaultModel) {
      assert.equal(occurrences.length, 1);
    }
    assert.equal(threadInfo.model, "custom-model");
  });
});

describe("prepareHarnessArgs", () => {
  const promptFlag = HARNESS_CONFIG.flags.prompt;

  it("inserts workspace context arguments before the prompt", () => {
    const base = promptFlag ? [promptFlag, "test prompt"] : ["test prompt"];
    const snapshot = base.slice();

    const prepared = prepareHarnessArgs(base);

    assert.notStrictEqual(prepared, base);
    assert.deepEqual(base, snapshot);

    const promptIndex = promptFlag ? prepared.lastIndexOf(promptFlag) : prepared.lastIndexOf("test prompt");

    if (HARNESS_CONFIG.flags.mcpConfig && fs.existsSync(MCP_CONFIG)) {
      const mcpIndex = prepared.indexOf(HARNESS_CONFIG.flags.mcpConfig);
      if (mcpIndex !== -1) {
        assert(mcpIndex < promptIndex);
      }
    }

    if (HARNESS_CONFIG.flags.addDir && projectDirs.length > 0) {
      const addDirIndex = prepared.indexOf(HARNESS_CONFIG.flags.addDir);
      assert.notEqual(addDirIndex, -1);
      assert(addDirIndex < promptIndex);
    }
  });
});
