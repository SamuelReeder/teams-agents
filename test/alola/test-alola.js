const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { extractFlags } = require("../../src/agents/spawn");
const { ROOT_DIR, ALOLA_CONFIG } = require("../../src/config/env");
const {
  parseAlolaTarget,
  imagePathForAsic,
  defaultConstraintForAsic,
  sanitizeTmuxSessionName,
  buildTmuxSessionName,
  buildSessionMetadata,
  buildLoginStartCommand,
  buildGpuStartCommand,
  buildWriteScriptCommand,
  buildSendKeysCommand,
  buildRemoteScript,
  parseCapturedCommand,
  sshArgsForNode,
  sshHostForNode,
} = require("../../src/alola/session");

const defaultNode = ALOLA_CONFIG.defaultLoginNode;
const defaultAsic = ALOLA_CONFIG.defaultAsic;
const alternateNode = ALOLA_CONFIG.loginNodes.find((node) => node !== defaultNode) || defaultNode;
const gpuAsic = defaultAsic === "gfx123" ? "gfx124" : "gfx123";
const otherGpuAsic = gpuAsic === "gfx124" ? "gfx125" : "gfx124";

describe("Alola target parsing", () => {
  it("defaults plain --alola to the configured login target", () => {
    const target = parseAlolaTarget([]);
    assert.equal(target.mode, "login");
    assert.equal(target.loginNode, defaultNode);
    assert.equal(target.asic, defaultAsic);
    assert.equal(target.container, ALOLA_CONFIG.defaultLoginContainer);
  });

  it("accepts explicit default target token", () => {
    const target = parseAlolaTarget(["default"]);
    assert.equal(target.mode, "login");
    assert.equal(target.loginNode, defaultNode);
    assert.equal(target.asic, defaultAsic);
  });

  it("parses a login-node override", () => {
    const target = parseAlolaTarget([alternateNode]);
    assert.equal(target.mode, "login");
    assert.equal(target.loginNode, alternateNode);
    assert.equal(target.asic, defaultAsic);
  });

  it("parses a GPU ASIC target", () => {
    const target = parseAlolaTarget([gpuAsic]);
    assert.equal(target.mode, "gpu");
    assert.equal(target.loginNode, defaultNode);
    assert.equal(target.asic, gpuAsic);
    assert.equal(target.image, imagePathForAsic(gpuAsic));
    assert.equal(target.constraint, defaultConstraintForAsic(gpuAsic));
  });

  it("parses node plus ASIC", () => {
    const target = parseAlolaTarget([defaultNode, otherGpuAsic]);
    assert.equal(target.mode, "gpu");
    assert.equal(target.loginNode, defaultNode);
    assert.equal(target.asic, otherGpuAsic);
    assert.equal(target.image, imagePathForAsic(otherGpuAsic));
    assert.equal(target.constraint, defaultConstraintForAsic(otherGpuAsic));
  });

  it("forces compute allocation for gpu targets", () => {
    const target = parseAlolaTarget([`gpu:${gpuAsic}`]);
    assert.equal(target.mode, "gpu");
    assert.equal(target.asic, gpuAsic);
    assert.equal(target.constraint, defaultConstraintForAsic(gpuAsic));
  });

  it("expands image paths and constraints for multiple ASICs", () => {
    for (const asic of [defaultAsic, gpuAsic, otherGpuAsic]) {
      assert.equal(imagePathForAsic(asic), ALOLA_CONFIG.imageTemplate.replace(/\{asic\}/g, asic).replace(/\{ASIC\}/g, asic.toUpperCase()));
      assert.equal(defaultConstraintForAsic(asic), ALOLA_CONFIG.defaultConstraintPrefix ? `${ALOLA_CONFIG.defaultConstraintPrefix}&${asic.toUpperCase()}` : asic.toUpperCase());
    }
  });
});

describe("Alola flag extraction", () => {
  it("keeps --alola out of harness args", () => {
    const { flags, harnessArgs, prompt } = extractFlags(`--alola ${alternateNode} --model opus --effort max do work`);
    assert.equal(flags.alola.mode, "login");
    assert.equal(flags.alola.loginNode, alternateNode);
    assert.deepEqual(harnessArgs, ["--model", "opus", "--effort", "max"]);
    assert.equal(prompt, "do work");
  });

  it("supports equals syntax for node and ASIC targets", () => {
    assert.equal(extractFlags(`--alola=${alternateNode} build`).flags.alola.loginNode, alternateNode);
    const gpu = extractFlags(`--alola=${gpuAsic} build`).flags.alola;
    assert.equal(gpu.mode, "gpu");
    assert.equal(gpu.asic, gpuAsic);
  });

  it("does not consume ordinary prompt tokens as targets", () => {
    const { flags, prompt } = extractFlags("--alola check 123 things");
    assert.equal(flags.alola.mode, "login");
    assert.equal(flags.alola.loginNode, defaultNode);
    assert.equal(prompt, "check 123 things");
  });

  it("preserves slash commands after reserved flags", () => {
    const { flags, prompt } = extractFlags("--alola /worktrees");
    assert.equal(flags.alola.mode, "login");
    assert.equal(prompt, "/worktrees");
  });
});

describe("Alola session metadata", () => {
  it("sanitizes tmux session names", () => {
    const sanitized = sanitizeTmuxSessionName("teams:bad/name with spaces_and_ok");
    assert.equal(sanitized, "teams_bad_name_with_spaces_and_ok");
  });

  it("builds deterministic bounded session names", () => {
    const target = parseAlolaTarget([gpuAsic]);
    const a = buildTmuxSessionName("thread-id", target);
    const b = buildTmuxSessionName("thread-id", target);
    assert.equal(a, b);
    assert.ok(a.length <= 64);
    assert.match(a, new RegExp(`^teams_[a-f0-9]{12}_gpu_${defaultNode}_${gpuAsic}$`));
  });

  it("fills durable metadata for GPU sessions", () => {
    const metadata = buildSessionMetadata({ rootMessageId: "root", sessionId: "session" }, parseAlolaTarget([gpuAsic]));
    assert.equal(metadata.mode, "gpu");
    assert.equal(metadata.loginNode, defaultNode);
    assert.equal(metadata.asic, gpuAsic);
    assert.equal(metadata.image, imagePathForAsic(gpuAsic));
    assert.equal(metadata.constraint, defaultConstraintForAsic(gpuAsic));
    assert.equal(metadata.timeLimit, ALOLA_CONFIG.defaultGpuTimeout);
    assert.ok(metadata.tmuxSession);
    assert.ok(metadata.lastSeen);
  });
});

describe("Alola command construction", () => {
  it("starts login sessions with enroot in tmux", () => {
    const metadata = buildSessionMetadata({ rootMessageId: "root" }, parseAlolaTarget([]));
    const command = buildLoginStartCommand(metadata);
    assert.ok(command.includes("tmux new-session -Ad"));
    assert.ok(command.includes("enroot start --rw"));
    assert.ok(command.includes(ALOLA_CONFIG.defaultLoginContainer));
    assert.ok(command.includes("enroot create -n"));
    assert.ok(command.includes(imagePathForAsic(defaultAsic)));
  });

  it("starts non-exclusive GPU allocations by ASIC", () => {
    const metadata = buildSessionMetadata({ rootMessageId: "root" }, parseAlolaTarget([gpuAsic]));
    const command = buildGpuStartCommand(metadata);
    assert.ok(command.includes("salloc"));
    assert.ok(command.includes("srun --pty"));
    assert.ok(command.includes(defaultConstraintForAsic(gpuAsic)));
    assert.ok(command.includes(imagePathForAsic(gpuAsic)));
    assert.equal(command.includes("--exclusive"), false);
  });

  it("writes user commands through scripts, not tmux send-keys quoting", () => {
    const metadata = buildSessionMetadata({ rootMessageId: "root" }, parseAlolaTarget([]));
    const dangerous = "echo safe; touch /tmp/hacked; echo 'quote'";
    const script = buildRemoteScript(dangerous, "cmd123");
    const writer = buildWriteScriptCommand("cmd123");
    const sender = buildSendKeysCommand(metadata, "cmd123");

    assert.ok(script.includes(dangerous));
    assert.equal(writer.includes(dangerous), false);
    assert.equal(sender.includes(dangerous), false);
    assert.ok(sender.includes("cmd123.sh"));
  });

  it("wraps and parses command sentinels", () => {
    const metadata = buildSessionMetadata({ rootMessageId: "root" }, parseAlolaTarget([]));
    const sender = buildSendKeysCommand(metadata, "abc123");
    assert.ok(sender.includes("__CMD_START_abc123__"));
    assert.ok(sender.includes("__CMD_DONE_abc123__"));
    const parsed = parseCapturedCommand("noise\n__CMD_START_abc123__\nhello\n__CMD_DONE_abc123__:7\n", "abc123");
    assert.equal(parsed.complete, true);
    assert.equal(parsed.rc, 7);
    assert.equal(parsed.output, "hello");
  });

  it("constructs SSH args for key-based auth without sshpass", () => {
    const config = {
      ...ALOLA_CONFIG,
      user: "remote-user",
      sshKey: "/run/secrets/remote_ssh_key",
      sshHostTemplate: "login-{node}.example.invalid",
      sshOptions: "-o BatchMode=yes -o StrictHostKeyChecking=yes",
    };
    const args = sshArgsForNode(defaultNode, "hostname", config);
    assert.deepEqual(args.slice(0, 4), ["-i", "/run/secrets/remote_ssh_key", "-o", "BatchMode=yes"]);
    assert.ok(args.includes(`remote-user@${sshHostForNode(defaultNode, config)}`));
    assert.equal(args.includes("sshpass"), false);
  });
});


describe("Deployment artifacts", () => {
  it("do not contain user-specific absolute paths", () => {
    for (const file of ["Dockerfile", "compose.yaml", ".dockerignore"]) {
      const text = fs.readFileSync(path.join(ROOT_DIR, file), "utf8");
      assert.equal(text.includes("/mnt/c"), false, `${file} contains /mnt/c`);
      assert.equal(text.includes("/home/remote-user/teams-bot"), false, `${file} contains a concrete checkout path`);
    }
  });
});
