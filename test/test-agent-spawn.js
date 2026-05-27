const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const {
  extractFlags,
  buildHarnessArgs,
  prepareHarnessArgs,
  getProjectDirs,
  applyStickyOptions,
  normalizeBareModel,
} = require("../lib/agent-spawn");
const { HARNESS_CONFIG, MCP_CONFIG } = require("../lib/config");
const { buildSessionMetadata, parseAlolaTarget } = require("../lib/alola-session");

const projectDirs = getProjectDirs();

describe("extractFlags", () => {
  it("forwards arbitrary harness flags", () => {
    const result = extractFlags("--model opus hello world");
    assert.deepEqual(result.flags, {});
    assert.deepEqual(result.harnessArgs, ["--model", "opus"]);
    assert.equal(result.prompt, "hello world");
  });

  it("forwards multiple harness flags without interpreting them", () => {
    const result = extractFlags("--model claude-sonnet-4-6 --effort high --temperature=0.2 explain this");
    assert.deepEqual(result.flags, {});
    assert.deepEqual(result.harnessArgs, [
      "--model",
      "claude-sonnet-4-6",
      "--effort",
      "high",
      "--temperature=0.2",
    ]);
    assert.equal(result.prompt, "explain this");
  });

  it("handles no flags", () => {
    const result = extractFlags("just a normal message");
    assert.deepEqual(result.flags, {});
    assert.deepEqual(result.harnessArgs, []);
    assert.equal(result.prompt, "just a normal message");
  });

  it("does not extract flags from middle of message", () => {
    const result = extractFlags("hello --model opus world");
    assert.deepEqual(result.flags, {});
    assert.deepEqual(result.harnessArgs, []);
    assert.equal(result.prompt, "hello --model opus world");
  });

  it("handles --alola with default login target", () => {
    const result = extractFlags("--alola build hipDNN");
    assert.equal(result.flags.alola.mode, "login");
    assert.equal(result.flags.alola.loginNode, "03");
    assert.equal(result.flags.alola.asic, "gfx90a");
    assert.deepEqual(result.harnessArgs, []);
    assert.equal(result.prompt, "build hipDNN");
  });

  it("handles --alola with specific node", () => {
    const result = extractFlags("--alola 04 build hipDNN");
    assert.equal(result.flags.alola.mode, "login");
    assert.equal(result.flags.alola.loginNode, "04");
    assert.deepEqual(result.harnessArgs, []);
    assert.equal(result.prompt, "build hipDNN");
  });

  it("handles --alola with equals node syntax", () => {
    const result = extractFlags("--alola=04 build hipDNN");
    assert.equal(result.flags.alola.mode, "login");
    assert.equal(result.flags.alola.loginNode, "04");
    assert.deepEqual(result.harnessArgs, []);
    assert.equal(result.prompt, "build hipDNN");
  });

  it("reserves --alola while forwarding other flags", () => {
    const result = extractFlags("--alola 04 --model opus --effort max run tests");
    assert.equal(result.flags.alola.mode, "login");
    assert.equal(result.flags.alola.loginNode, "04");
    assert.deepEqual(result.harnessArgs, ["--model", "opus", "--effort", "max"]);
    assert.equal(result.prompt, "run tests");
  });

  it("handles harness flags before reserved flags", () => {
    const result = extractFlags("--model haiku --alola check GPU");
    assert.deepEqual(result.harnessArgs, ["--model", "haiku"]);
    assert.equal(result.flags.alola.mode, "login");
    assert.equal(result.flags.alola.loginNode, "03");
    assert.equal(result.prompt, "check GPU");
  });

  it("uses standalone -- as the end-of-flags delimiter", () => {
    const result = extractFlags("--verbose -- prompt starts here");
    assert.deepEqual(result.flags, {});
    assert.deepEqual(result.harnessArgs, ["--verbose"]);
    assert.equal(result.prompt, "prompt starts here");
  });

  it("handles slash commands after reserved flags", () => {
    const result = extractFlags("--alola /goto therock");
    assert.equal(result.flags.alola.mode, "login");
    assert.deepEqual(result.harnessArgs, []);
    assert.equal(result.prompt, "/goto therock");
  });

  it("handles ASIC and forced GPU Alola targets", () => {
    const gpu = extractFlags("--alola gfx942 run rocminfo");
    assert.equal(gpu.flags.alola.mode, "gpu");
    assert.equal(gpu.flags.alola.asic, "gfx942");
    assert.equal(gpu.flags.alola.constraint, "MARKHAM&GFX942");
    assert.equal(gpu.prompt, "run rocminfo");

    const forced = extractFlags("--alola gpu:gfx90a run tests");
    assert.equal(forced.flags.alola.mode, "gpu");
    assert.equal(forced.flags.alola.asic, "gfx90a");
  });
});

describe("buildHarnessArgs", () => {
  const promptFlag = HARNESS_CONFIG.flags.prompt;
  const sessionFlag = HARNESS_CONFIG.flags.sessionId;
  const resumeFlag = HARNESS_CONFIG.flags.resume;

  it("includes session identifier for new threads", () => {
    const threadInfo = { sessionId: "session-new", isFollowUp: false, rootMessageId: "msg-123" };
    const args = buildHarnessArgs(threadInfo, "do work", []);

    assert.ok(args.includes("do work"), "prompt missing");
    if (promptFlag) {
      const promptIndex = args.lastIndexOf(promptFlag);
      assert.notEqual(promptIndex, -1);
      assert.equal(args[promptIndex + 1], "do work");
    }

    if (sessionFlag) {
      assert.ok(args.includes(threadInfo.sessionId), "session id missing");
      const index = args.indexOf(sessionFlag);
      assert.notEqual(index, -1);
      assert.equal(args[index + 1], threadInfo.sessionId);
    }

    if (HARNESS_CONFIG.skipPermissions && HARNESS_CONFIG.flags.skipPermissions) {
      assert.ok(args.includes(HARNESS_CONFIG.flags.skipPermissions));
    }

    if (HARNESS_CONFIG.defaultModel && HARNESS_CONFIG.flags.model) {
      const modelIndex = args.lastIndexOf(HARNESS_CONFIG.flags.model);
      assert.notEqual(modelIndex, -1);
      assert.equal(args[modelIndex + 1], HARNESS_CONFIG.defaultModel);
    }
  });

  it("uses resume flag for follow-up threads when available", () => {
    const threadInfo = { sessionId: "session-follow", harnessSessionId: "harness-abc", isFollowUp: true, rootMessageId: "msg-456" };
    const args = buildHarnessArgs(threadInfo, "follow up", []);

    if (resumeFlag) {
      assert.ok(args.includes(threadInfo.harnessSessionId), "harness session id missing");
      const index = args.indexOf(resumeFlag);
      assert.notEqual(index, -1);
      assert.equal(args[index + 1], threadInfo.harnessSessionId);
    }
  });

  it("follow-up without session includes system prompt", () => {
    const threadInfo = { sessionId: "session-nosid", harnessSessionId: null, isFollowUp: true, rootMessageId: "msg-789" };
    const args = buildHarnessArgs(threadInfo, "retry this", []);

    if (resumeFlag) {
      assert.equal(args.indexOf(resumeFlag), -1, "should not use --resume without session id");
    }
    if (HARNESS_CONFIG.appendSystemPrompt && HARNESS_CONFIG.flags.appendSystemPrompt) {
      assert.ok(
        args.includes(HARNESS_CONFIG.flags.appendSystemPrompt),
        "system prompt should be included when no session to resume"
      );
    }
  });

  it("passes arbitrary harness args before the prompt", () => {
    const threadInfo = { sessionId: "session-flags", isFollowUp: false };
    const args = buildHarnessArgs(threadInfo, "custom prompt", [
      "--model",
      "custom-model",
      "--effort",
      "max",
    ]);

    const modelIndex = args.indexOf("--model");
    const effortIndex = args.indexOf("--effort");
    const promptIndex = promptFlag ? args.lastIndexOf(promptFlag) : args.lastIndexOf("custom prompt");

    assert.notEqual(modelIndex, -1);
    assert.equal(args[modelIndex + 1], "custom-model");
    assert.notEqual(effortIndex, -1);
    assert.equal(args[effortIndex + 1], "max");
    assert(modelIndex < promptIndex);
    assert(effortIndex < promptIndex);
  });

  it("adds Alola routing context to build/test prompts", () => {
    const threadInfo = { sessionId: "session-build", isFollowUp: false, rootMessageId: "msg-build" };
    const args = buildHarnessArgs(threadInfo, "build and test hipDNN", []);
    const promptIndex = promptFlag ? args.lastIndexOf(promptFlag) : args.length - 1;
    const prompt = args[promptIndex + (promptFlag ? 1 : 0)];
    assert.ok(prompt.includes("[Execution routing]"));
    assert.ok(prompt.includes("workspace/scripts/alola-session run"));
  });

  it("leaves ordinary prompts as local HPE work", () => {
    const threadInfo = { sessionId: "session-ordinary", isFollowUp: false, rootMessageId: "msg-ordinary" };
    const args = buildHarnessArgs(threadInfo, "explain descriptor lifting", []);
    const promptIndex = promptFlag ? args.lastIndexOf(promptFlag) : args.length - 1;
    const prompt = args[promptIndex + (promptFlag ? 1 : 0)];
    assert.equal(prompt, "explain descriptor lifting");
  });

  it("adds explicit Alola target context without forwarding --alola", () => {
    const threadInfo = {
      sessionId: "session-target",
      isFollowUp: false,
      rootMessageId: "msg-target",
      alola: buildSessionMetadata({ rootMessageId: "msg-target", sessionId: "session-target" }, parseAlolaTarget(["gfx942"])),
    };
    const args = buildHarnessArgs(threadInfo, "run rocminfo", []);
    const promptIndex = promptFlag ? args.lastIndexOf(promptFlag) : args.length - 1;
    const prompt = args[promptIndex + (promptFlag ? 1 : 0)];
    assert.ok(prompt.includes("Alola GPU gfx942"));
    assert.equal(args.includes("--alola"), false);
  });
});

describe("normalizeBareModel", () => {
  it("prefixes bare gpt model with openai/", () => {
    assert.equal(normalizeBareModel("gpt-5.5"), "openai/gpt-5.5");
  });

  it("prefixes bare claude model with anthropic/", () => {
    assert.equal(normalizeBareModel("claude-haiku-4-5"), "anthropic/claude-haiku-4-5");
  });

  it("leaves provider-prefixed models alone", () => {
    assert.equal(normalizeBareModel("openai/gpt-5.5"), "openai/gpt-5.5");
    assert.equal(normalizeBareModel("anthropic/claude-haiku-4-5"), "anthropic/claude-haiku-4-5");
  });

  it("leaves unknown bare models alone", () => {
    assert.equal(normalizeBareModel("mystery-model"), "mystery-model");
  });
});

describe("applyStickyOptions", () => {
  const modelFlag = HARNESS_CONFIG.flags.model || "--model";

  it("records explicit model on threadInfo and normalizes it", () => {
    const threadInfo = {};
    const args = applyStickyOptions(threadInfo, [modelFlag, "gpt-5.5"]);
    assert.equal(threadInfo.model, "openai/gpt-5.5");
    assert.deepEqual(args, [modelFlag, "openai/gpt-5.5"]);
  });

  it("reuses sticky model when no explicit model in args", () => {
    const threadInfo = { model: "openai/gpt-5.5" };
    const args = applyStickyOptions(threadInfo, []);
    assert.deepEqual(args, [modelFlag, "openai/gpt-5.5"]);
  });

  it("explicit model overrides sticky model and updates it", () => {
    const threadInfo = { model: "openai/gpt-5.5" };
    const args = applyStickyOptions(threadInfo, [modelFlag, "anthropic/claude-haiku-4-5"]);
    assert.equal(threadInfo.model, "anthropic/claude-haiku-4-5");
    assert.deepEqual(args, [modelFlag, "anthropic/claude-haiku-4-5"]);
  });

  it("no model anywhere returns args unchanged", () => {
    const threadInfo = {};
    const args = applyStickyOptions(threadInfo, ["--thinking", "high"]);
    assert.deepEqual(args, ["--thinking", "high"]);
    assert.equal(threadInfo.model, undefined);
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
