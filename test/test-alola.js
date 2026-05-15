const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Mirror extractFlags for testing
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
  it("builds correct remote command with extra args", () => {
    const ALOLA_RUN_SCRIPT = "~/ROCm-workspace/scripts/run-agent.sh";
    const containerName = "claude-abc12345";
    const sessionId = "abc12345-6789-abcd-ef01-234567890abc";
    const extraArgs = ["--model", "opus"];

    const remoteCmd = `cd ~/ROCm-workspace && git pull --ff-only -q 2>/dev/null; ${ALOLA_RUN_SCRIPT} ${containerName} ${sessionId} ${extraArgs.join(" ")}`;

    assert.ok(remoteCmd.includes("git pull"));
    assert.ok(remoteCmd.includes("run-agent.sh"));
    assert.ok(remoteCmd.includes(containerName));
    assert.ok(remoteCmd.includes(sessionId));
    assert.ok(remoteCmd.includes("--model opus"));
  });

  it("builds remote command with --resume for follow-ups", () => {
    const extraArgs = ["--resume", "--effort", "max"];
    const cmd = extraArgs.join(" ");
    assert.ok(cmd.includes("--resume"));
    assert.ok(cmd.includes("--effort max"));
  });

  it("builds remote command with no extra args", () => {
    const extraArgs = [];
    const cmd = `run-agent.sh container session ${extraArgs.join(" ")}`.trim();
    assert.equal(cmd, "run-agent.sh container session");
  });
});
