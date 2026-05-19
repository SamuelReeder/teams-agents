const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  extractFlags,
  buildAlolaExtraArgs,
  buildAlolaRemoteCommand,
} = require("../lib/agent-spawn");
const { HARNESS_CONFIG } = require("../lib/config");

function alolaContainerName(sessionId) {
  return `claude-${sessionId.slice(0, 8)}`;
}

describe("Alola container naming", () => {
  it("generates consistent name from session ID", () => {
    assert.equal(alolaContainerName("abcdef12-3456-7890-abcd-ef1234567890"), "claude-abcdef12");
  });

  it("generates different names for different sessions", () => {
    const a = alolaContainerName("aaaaaaaa-1111-2222-3333-444444444444");
    const b = alolaContainerName("bbbbbbbb-1111-2222-3333-444444444444");
    assert.notEqual(a, b);
  });
});

describe("Alola flag extraction", () => {
  it("--alola defaults to node 03", () => {
    const { flags } = extractFlags("--alola build something");
    assert.equal(flags.alola, "03");
  });

  it("--alola with node number", () => {
    const { flags } = extractFlags("--alola 04 build something");
    assert.equal(flags.alola, "04");
  });

  it("--alola combined with --model and --effort", () => {
    const { flags, prompt } = extractFlags("--alola 04 --model opus --effort max do work");
    assert.equal(flags.alola, "04");
    assert.equal(flags.model, "opus");
    assert.equal(flags.effort, "max");
    assert.equal(prompt, "do work");
  });

  it("--alola does not capture 3-digit numbers as node", () => {
    const { flags, prompt } = extractFlags("--alola check 123 things");
    assert.equal(flags.alola, "03");
    assert.equal(prompt, "check 123 things");
  });

  it("--alola preserves slash commands in prompt", () => {
    const { flags, prompt } = extractFlags("--alola /goto therock");
    assert.equal(flags.alola, "03");
    assert.equal(prompt, "/goto therock");
  });
});

describe("Alola follow-up routing", () => {
  it("follow-up prepends --alola with saved node", () => {
    const threadAlola = { node: "04", containerName: "claude-abc12345" };
    const message = "now run the tests";
    const reconstituted = `--alola ${threadAlola.node} ${message}`;
    const { flags, prompt } = extractFlags(reconstituted);
    assert.equal(flags.alola, "04");
    assert.equal(prompt, "now run the tests");
  });

  it("follow-up with no flags still routes correctly", () => {
    const threadAlola = { node: "03", containerName: "claude-def67890" };
    const message = "what was the output?";
    const reconstituted = `--alola ${threadAlola.node} ${message}`;
    const { flags, prompt } = extractFlags(reconstituted);
    assert.equal(flags.alola, "03");
    assert.equal(prompt, "what was the output?");
  });
});

describe("Alola remote command construction", () => {
  it("uses configured harness flags for extra args", () => {
    const threadInfo = { isFollowUp: true };
    const flags = { model: "opus", effort: "max" };
    const extraArgs = buildAlolaExtraArgs(threadInfo, flags);

    assert.ok(extraArgs.includes("--resume"));

    if (HARNESS_CONFIG.flags.model) {
      const modelIndex = extraArgs.indexOf(HARNESS_CONFIG.flags.model);
      assert.notEqual(modelIndex, -1);
      assert.equal(extraArgs[modelIndex + 1], "opus");
    }

    if (HARNESS_CONFIG.flags.effort) {
      const effortIndex = extraArgs.indexOf(HARNESS_CONFIG.flags.effort);
      assert.notEqual(effortIndex, -1);
      assert.equal(extraArgs[effortIndex + 1], "max");
    }
  });

  it("quotes remote command arguments", () => {
    const remoteCmd = buildAlolaRemoteCommand("claude-abc12345", "abc12345", [
      "--model",
      "$(touch hacked)",
      "o'hai",
    ]);

    assert.ok(remoteCmd.includes("git pull"));
    assert.ok(remoteCmd.includes("run-agent.sh"));
    assert.ok(remoteCmd.includes("'claude-abc12345'"));
    assert.ok(remoteCmd.includes("'abc12345'"));
    assert.ok(remoteCmd.includes("'$(touch hacked)'"));
    assert.ok(remoteCmd.includes("'o'\\''hai'"));
  });
});
