const { afterEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildModelListArgs,
  runHarness,
} = require("../../src/agents/harness-runner");
const {
  createRunnerServer,
  validateCwd,
} = require("../../src/agents/runner-server");

const tempRoots = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teams-bot-runner-"));
  tempRoots.push(dir);
  return dir;
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

describe("harness runner local fallback", () => {
  it("runs the harness locally when no runner URL is configured", async () => {
    const cwd = tempDir();
    const result = await runHarness(["-e", "process.stdout.write(process.cwd())"], {
      bin: process.execPath,
      cwd,
      env: { PATH: process.env.PATH, HOME: os.homedir() },
      runnerConfig: { url: null },
      timeoutMs: 3000,
    });

    assert.equal(result.mode, "local");
    assert.equal(result.code, 0);
    assert.equal(result.stdout, fs.realpathSync(cwd));
  });

  it("builds model listing args without adding prompt/base flags", () => {
    assert.deepEqual(buildModelListArgs("gpt"), ["--list-models=gpt"]);
    assert.deepEqual(buildModelListArgs(""), ["--list-models"]);
  });
});

describe("agent runner HTTP path", () => {
  it("sends harness requests to the runner with cwd, timeout, token, and Alola intent", async () => {
    const root = tempDir();
    const cwd = mkdirp(path.join(root, "workspace"));
    const server = createRunnerServer(
      { token: "shared-token", allowedRoots: [root] },
      {
        runHarness: async (args, options) => ({
          code: 0,
          stdout: JSON.stringify({
            args,
            cwd: options.cwd,
            includeAlola: options.includeAlola,
            timeoutMs: options.timeoutMs,
          }),
          stderr: "",
        }),
      }
    );
    const url = await listen(server);

    try {
      const result = await runHarness(["--flag", "value"], {
        cwd,
        includeAlola: true,
        runnerConfig: { url, token: "shared-token" },
        timeoutMs: 1234,
      });
      const payload = JSON.parse(result.stdout);

      assert.equal(result.mode, "agent-runner");
      assert.equal(result.code, 0);
      assert.deepEqual(payload.args, ["--flag", "value"]);
      assert.equal(payload.cwd, fs.realpathSync(cwd));
      assert.equal(payload.includeAlola, true);
      assert.equal(payload.timeoutMs, 1234);
    } finally {
      await close(server);
    }
  });

  it("rejects runner requests without the shared token", async () => {
    const root = tempDir();
    const cwd = mkdirp(path.join(root, "workspace"));
    const server = createRunnerServer(
      { token: "shared-token", allowedRoots: [root] },
      { runHarness: async () => assert.fail("runner should not execute unauthorized requests") }
    );
    const url = await listen(server);

    try {
      await assert.rejects(
        () => runHarness(["--version"], { cwd, runnerConfig: { url, token: "wrong" }, timeoutMs: 1000 }),
        /Agent runner request failed \(401\)/
      );
    } finally {
      await close(server);
    }
  });

  it("rejects cwd values outside configured allowed roots", async () => {
    const root = tempDir();
    const outside = tempDir();
    const server = createRunnerServer(
      { token: null, allowedRoots: [root] },
      { runHarness: async () => assert.fail("runner should not execute outside allowed roots") }
    );
    const url = await listen(server);

    try {
      await assert.rejects(
        () => runHarness(["--version"], { cwd: outside, runnerConfig: { url }, timeoutMs: 1000 }),
        /Agent runner request failed \(403\)/
      );
    } finally {
      await close(server);
    }
  });
});

describe("runner cwd validation", () => {
  it("allows exact roots and children but rejects sibling-prefix paths", () => {
    const root = tempDir();
    const child = mkdirp(path.join(root, "child"));
    const sibling = mkdirp(`${root}-sibling`);
    tempRoots.push(sibling);

    assert.equal(validateCwd(root, [root]), fs.realpathSync(root));
    assert.equal(validateCwd(child, [root]), fs.realpathSync(child));
    assert.throws(() => validateCwd(sibling, [root]), /outside AGENT_RUNNER_ALLOWED_ROOTS/);
  });

  it("rejects symlinks that escape the allowed root", { skip: process.platform === "win32" }, () => {
    const root = tempDir();
    const outside = tempDir();
    const link = path.join(root, "escape");
    fs.symlinkSync(outside, link, "dir");

    assert.throws(() => validateCwd(link, [root]), /outside AGENT_RUNNER_ALLOWED_ROOTS/);
  });
});
