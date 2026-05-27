const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { extractFlags } = require("../lib/agent-spawn");
const { ROOT_DIR, ALOLA_CONFIG } = require("../lib/config");
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
} = require("../lib/alola-session");

describe("Alola target parsing", () => {
  it("defaults plain --alola to login node 03 and gfx90a", () => {
    const target = parseAlolaTarget([]);
    assert.equal(target.mode, "login");
    assert.equal(target.loginNode, "03");
    assert.equal(target.asic, "gfx90a");
    assert.equal(target.container, ALOLA_CONFIG.defaultLoginContainer);
  });

  it("accepts explicit default target token", () => {
    const target = parseAlolaTarget(["default"]);
    assert.equal(target.mode, "login");
    assert.equal(target.loginNode, "03");
    assert.equal(target.asic, "gfx90a");
  });

  it("parses a login-node override", () => {
    const target = parseAlolaTarget(["04"]);
    assert.equal(target.mode, "login");
    assert.equal(target.loginNode, "04");
    assert.equal(target.asic, "gfx90a");
  });

  it("parses a GPU ASIC target", () => {
    const target = parseAlolaTarget(["gfx942"]);
    assert.equal(target.mode, "gpu");
    assert.equal(target.loginNode, "03");
    assert.equal(target.asic, "gfx942");
    assert.equal(target.image, "/cluster/images/hipdnn/hipdnn_latest_gfx942.sqsh");
    assert.equal(target.constraint, "MARKHAM&GFX942");
  });

  it("parses node plus ASIC", () => {
    const target = parseAlolaTarget(["03", "gfx950"]);
    assert.equal(target.mode, "gpu");
    assert.equal(target.loginNode, "03");
    assert.equal(target.asic, "gfx950");
    assert.equal(target.image, "/cluster/images/hipdnn/hipdnn_latest_gfx950.sqsh");
    assert.equal(target.constraint, "MARKHAM&GFX950");
  });

  it("forces compute allocation for gpu:gfx90a", () => {
    const target = parseAlolaTarget(["gpu:gfx90a"]);
    assert.equal(target.mode, "gpu");
    assert.equal(target.asic, "gfx90a");
    assert.equal(target.constraint, "MARKHAM&GFX90A");
  });

  it("expands image paths and constraints for multiple ASICs", () => {
    for (const asic of ["gfx90a", "gfx942", "gfx950"]) {
      assert.equal(imagePathForAsic(asic), `/cluster/images/hipdnn/hipdnn_latest_${asic}.sqsh`);
      assert.equal(defaultConstraintForAsic(asic), `MARKHAM&${asic.toUpperCase()}`);
    }
  });
});

describe("Alola flag extraction", () => {
  it("keeps --alola out of harness args", () => {
    const { flags, harnessArgs, prompt } = extractFlags("--alola 04 --model opus --effort max do work");
    assert.equal(flags.alola.mode, "login");
    assert.equal(flags.alola.loginNode, "04");
    assert.deepEqual(harnessArgs, ["--model", "opus", "--effort", "max"]);
    assert.equal(prompt, "do work");
  });

  it("supports equals syntax for node and ASIC targets", () => {
    assert.equal(extractFlags("--alola=04 build").flags.alola.loginNode, "04");
    const gpu = extractFlags("--alola=gfx942 build").flags.alola;
    assert.equal(gpu.mode, "gpu");
    assert.equal(gpu.asic, "gfx942");
  });

  it("does not consume ordinary prompt tokens as targets", () => {
    const { flags, prompt } = extractFlags("--alola check 123 things");
    assert.equal(flags.alola.mode, "login");
    assert.equal(flags.alola.loginNode, "03");
    assert.equal(prompt, "check 123 things");
  });

  it("preserves slash commands after reserved flags", () => {
    const { flags, prompt } = extractFlags("--alola /goto therock");
    assert.equal(flags.alola.mode, "login");
    assert.equal(prompt, "/goto therock");
  });
});

describe("Alola session metadata", () => {
  it("sanitizes tmux session names", () => {
    const sanitized = sanitizeTmuxSessionName("teams:bad/name with spaces_and_ok");
    assert.equal(sanitized, "teams_bad_name_with_spaces_and_ok");
  });

  it("builds deterministic bounded session names", () => {
    const target = parseAlolaTarget(["gfx942"]);
    const a = buildTmuxSessionName("thread-id", target);
    const b = buildTmuxSessionName("thread-id", target);
    assert.equal(a, b);
    assert.ok(a.length <= 64);
    assert.match(a, /^teams_[a-f0-9]{12}_gpu_03_gfx942$/);
  });

  it("fills durable metadata for GPU sessions", () => {
    const metadata = buildSessionMetadata({ rootMessageId: "root", sessionId: "session" }, parseAlolaTarget(["gfx942"]));
    assert.equal(metadata.mode, "gpu");
    assert.equal(metadata.loginNode, "03");
    assert.equal(metadata.asic, "gfx942");
    assert.equal(metadata.image, "/cluster/images/hipdnn/hipdnn_latest_gfx942.sqsh");
    assert.equal(metadata.constraint, "MARKHAM&GFX942");
    assert.equal(metadata.timeLimit, "08:00:00");
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
  });

  it("starts non-exclusive GPU allocations by ASIC", () => {
    const metadata = buildSessionMetadata({ rootMessageId: "root" }, parseAlolaTarget(["gfx942"]));
    const command = buildGpuStartCommand(metadata);
    assert.ok(command.includes("salloc"));
    assert.ok(command.includes("srun --pty"));
    assert.ok(command.includes("MARKHAM&GFX942"));
    assert.ok(command.includes("hipdnn_latest_gfx942.sqsh"));
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
    const args = sshArgsForNode("03", "hostname", {
      ...ALOLA_CONFIG,
      sshKey: "/run/secrets/alola_ssh_key",
      sshOptions: "-o BatchMode=yes -o StrictHostKeyChecking=yes",
    });
    assert.deepEqual(args.slice(0, 4), ["-i", "/run/secrets/alola_ssh_key", "-o", "BatchMode=yes"]);
    assert.ok(args.includes("sareeder@ctr2-alola-login-03"));
    assert.equal(args.includes("sshpass"), false);
  });
});

describe("Deployment artifacts", () => {
  it("do not contain WSL-specific absolute paths", () => {
    for (const file of ["Dockerfile", "compose.yaml", ".dockerignore"]) {
      const text = fs.readFileSync(path.join(ROOT_DIR, file), "utf8");
      assert.equal(text.includes("/mnt/c"), false, `${file} contains /mnt/c`);
      assert.equal(text.includes("/home/sareeder/teams-bot"), false, `${file} contains current checkout path`);
    }
  });
});
