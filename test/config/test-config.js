const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  HARNESS_CONFIG,
  channelMaxConcurrentAgents,
  resolveWorkspace,
  validateChannels,
  loadChannels,
} = require("../../src/config/env");
const { buildHarnessArgs } = require("../../src/agents/spawn");

const tempRoots = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teams-bot-config-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length) {
    fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("workspace resolution", () => {
  it("uses explicit channel workspace before env and repo defaults", () => {
    const root = tempDir();
    const home = mkdirp(path.join(root, "home"));
    const explicit = mkdirp(path.join(root, "workspace-a"));
    const envWorkspace = mkdirp(path.join(root, "workspace-b"));
    mkdirp(path.join(root, "workspace"));

    const resolved = resolveWorkspace(
      { chatId: "chat-a", label: "A", workspace: explicit },
      { rootDir: root, home, env: { HOME: home, APP_WORKSPACE_DIR: envWorkspace } }
    );

    assert.equal(resolved.dir, explicit);
    assert.equal(resolved.source, "channel");
  });

  it("uses APP_WORKSPACE_DIR when the channel omits workspace", () => {
    const root = tempDir();
    const home = mkdirp(path.join(root, "home"));
    const envWorkspace = mkdirp(path.join(root, "env-workspace"));
    mkdirp(path.join(root, "workspace"));

    const resolved = resolveWorkspace(
      { chatId: "chat-a", label: "A", workspace: null },
      { rootDir: root, home, env: { HOME: home, APP_WORKSPACE_DIR: envWorkspace } }
    );

    assert.equal(resolved.dir, envWorkspace);
    assert.equal(resolved.source, "env");
  });

  it("uses bundled repo workspace when present and no explicit workspace is configured", () => {
    const root = tempDir();
    const home = mkdirp(path.join(root, "home"));
    const bundled = mkdirp(path.join(root, "workspace"));

    const resolved = resolveWorkspace(null, { rootDir: root, home, env: { HOME: home } });

    assert.equal(resolved.dir, bundled);
    assert.equal(resolved.source, "repo");
  });

  it("falls back to HOME when the bundled workspace is absent", () => {
    const root = tempDir();
    const home = mkdirp(path.join(root, "home"));

    const resolved = resolveWorkspace(null, { rootDir: root, home, env: { HOME: home } });

    assert.equal(resolved.dir, home);
    assert.equal(resolved.source, "home");
  });

  it("fails explicit invalid workspace paths with an actionable error", () => {
    const root = tempDir();
    const home = mkdirp(path.join(root, "home"));
    const missing = path.join(root, "missing-workspace");

    assert.throws(
      () => resolveWorkspace({ chatId: "chat-a", label: "Alpha", workspace: missing }, { rootDir: root, home, env: { HOME: home } }),
      /Configured workspace for Alpha is not a readable directory/
    );
  });
});

describe("channel validation", () => {
  it("accepts per-channel workspace, model, Alola model, and concurrency", () => {
    const channels = validateChannels([
      {
        chatId: "chat-a",
        label: "Alpha",
        workspace: "/tmp/workspace-a",
        defaultModel: "openai/gpt-5.5",
        alolaDefaultModel: "anthropic/claude-haiku-4-5",
        maxConcurrentAgents: 2,
      },
    ], "test-channels.json");

    assert.equal(channels[0].workspace, "/tmp/workspace-a");
    assert.equal(channels[0].defaultModel, "openai/gpt-5.5");
    assert.equal(channels[0].alolaDefaultModel, "anthropic/claude-haiku-4-5");
    assert.equal(channelMaxConcurrentAgents(channels[0]), 2);
  });

  it("rejects missing chatId, duplicate chat IDs, bad workspace types, and bad concurrency", () => {
    assert.throws(() => validateChannels([{}], "channels"), /missing required string chatId/);
    assert.throws(() => validateChannels([{ chatId: "a" }, { chatId: "a" }], "channels"), /duplicate chatId a/);
    assert.throws(() => validateChannels([{ chatId: "a", workspace: 42 }], "channels"), /field workspace must be a string/);
    assert.throws(() => validateChannels([{ chatId: "a", maxConcurrentAgents: 0 }], "channels"), /maxConcurrentAgents must be a positive integer/);
  });

  it("rejects malformed channel file JSON instead of silently swallowing it", () => {
    const root = tempDir();
    const file = path.join(root, "channels.json");
    fs.writeFileSync(file, "[{ bad json");

    assert.throws(
      () => loadChannels({ reload: true, env: { APP_CHANNELS_FILE: file } }),
      /Failed to parse/
    );
  });
});

describe("per-channel harness defaults", () => {
  const promptFlag = HARNESS_CONFIG.flags.prompt;
  const modelFlag = HARNESS_CONFIG.flags.model || "--model";

  function promptFromArgs(args) {
    const promptIndex = promptFlag ? args.lastIndexOf(promptFlag) : args.length - 1;
    return args[promptIndex + (promptFlag ? 1 : 0)];
  }

  it("applies channel defaultModel when no explicit model is supplied", () => {
    const threadInfo = {
      sessionId: "session-default",
      rootMessageId: "root-default",
      isFollowUp: false,
      defaultModel: "openai/gpt-5.5",
    };

    const args = buildHarnessArgs(threadInfo, "explain this", []);
    const modelIndex = args.indexOf(modelFlag);

    assert.notEqual(modelIndex, -1);
    assert.equal(args[modelIndex + 1], "openai/gpt-5.5");
    assert.equal(promptFromArgs(args), "explain this");
  });

  it("applies channel alolaDefaultModel to inferred Alola prompts", () => {
    const threadInfo = {
      sessionId: "session-alola-default",
      rootMessageId: "root-alola-default",
      isFollowUp: false,
      defaultModel: "openai/gpt-5.5",
      alolaDefaultModel: "anthropic/claude-haiku-4-5",
    };

    const args = buildHarnessArgs(threadInfo, "build and test hipDNN", []);
    const modelIndex = args.indexOf(modelFlag);

    assert.notEqual(modelIndex, -1);
    assert.equal(args[modelIndex + 1], "anthropic/claude-haiku-4-5");
  });

  it("keeps explicit --model ahead of channel defaults", () => {
    const threadInfo = {
      sessionId: "session-explicit",
      rootMessageId: "root-explicit",
      isFollowUp: false,
      defaultModel: "openai/gpt-5.5",
    };

    const args = buildHarnessArgs(threadInfo, "explain this", [modelFlag, "custom-model"]);
    const modelIndex = args.indexOf(modelFlag);

    assert.equal(args[modelIndex + 1], "custom-model");
  });
});
