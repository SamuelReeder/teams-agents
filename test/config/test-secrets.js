const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildHarnessEnv,
  redactSecrets,
  resolveSecretPath,
  resolveSecretValue,
} = require("../../src/config/env");

const tempRoots = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teams-bot-secrets-"));
  tempRoots.push(dir);
  return dir;
}

function writeSecret(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, value, { mode: 0o600 });
  return file;
}

afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

describe("secret resolution", () => {
  it("uses *_FILE before Docker secrets, APP_SECRETS_DIR files, and direct env", () => {
    const root = tempDir();
    const explicitFile = writeSecret(root, "explicit", "from-file\n");
    const dockerDir = path.join(root, "docker");
    const appDir = path.join(root, "app");
    writeSecret(dockerDir, "openai_api_key", "from-docker");
    writeSecret(appDir, "openai_api_key", "from-app");

    const value = resolveSecretValue("OPENAI_API_KEY", {
      env: { OPENAI_API_KEY_FILE: explicitFile, OPENAI_API_KEY: "from-env" },
      dockerSecretsDir: dockerDir,
      secretsDir: appDir,
    });

    assert.equal(value, "from-file");
  });

  it("uses Docker secrets before APP_SECRETS_DIR and direct env", () => {
    const root = tempDir();
    const dockerDir = path.join(root, "docker");
    const appDir = path.join(root, "app");
    writeSecret(dockerDir, "anthropic_api_key", "from-docker");
    writeSecret(appDir, "anthropic_api_key", "from-app");

    const value = resolveSecretValue("ANTHROPIC_API_KEY", {
      env: { ANTHROPIC_API_KEY: "from-env" },
      dockerSecretsDir: dockerDir,
      secretsDir: appDir,
    });

    assert.equal(value, "from-docker");
  });

  it("uses APP_SECRETS_DIR before direct env and accepts direct env for local development", () => {
    const root = tempDir();
    const appDir = path.join(root, "app");
    writeSecret(appDir, "llm_gateway_api_key", "from-app");

    assert.equal(resolveSecretValue("LLM_GATEWAY_API_KEY", {
      env: { LLM_GATEWAY_API_KEY: "from-env" },
      dockerSecretsDir: path.join(root, "missing-docker"),
      secretsDir: appDir,
    }), "from-app");

    assert.equal(resolveSecretValue("LLM_GATEWAY_API_KEY", {
      env: { LLM_GATEWAY_API_KEY: "from-env" },
      dockerSecretsDir: path.join(root, "missing-docker"),
      secretsDir: path.join(root, "missing-app"),
    }), "from-env");
  });

  it("returns secret paths for path secrets without reading key material into the caller", () => {
    const root = tempDir();
    const keyFile = writeSecret(root, "remote_ssh_key", "fixture key material");

    const resolved = resolveSecretPath("ALOLA_SSH_KEY", {
      env: { ALOLA_SSH_KEY_FILE: keyFile },
      dockerSecretsDir: path.join(root, "missing-docker"),
      secretsDir: path.join(root, "missing-app"),
    });

    assert.equal(resolved, keyFile);
  });
});

describe("harness environment exposure", () => {
  it("passes allowlisted LLM secrets to the harness from secret files", () => {
    const root = tempDir();
    const openAiFile = writeSecret(root, "openai", "openai-secret\n");

    const env = buildHarnessEnv({
      env: {
        PATH: "/usr/bin",
        HOME: "/home/tester",
        OPENAI_API_KEY_FILE: openAiFile,
        TEAMS_TOKEN: "teams-secret",
        ALOLA_SSH_KEY: "/run/secrets/remote_ssh_key",
      },
    });

    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/home/tester");
    assert.equal(env.OPENAI_API_KEY, "openai-secret");
    assert.equal(env.TEAMS_TOKEN, undefined);
    assert.equal(env.ALOLA_SSH_KEY, undefined);
  });

  it("keeps bot-only secrets out of default harness environment snapshots", () => {
    const env = buildHarnessEnv({
      env: {
        PATH: "/usr/bin",
        TEAMS_REFRESH_TOKEN: "refresh-token",
        TEAMS_ACCESS_TOKEN: "teams-token",
        MICROSOFT_CLIENT_SECRET: "client-secret",
        AGENT_RUNNER_TOKEN: "runner-token",
      },
    });

    assert.equal(env.TEAMS_REFRESH_TOKEN, undefined);
    assert.equal(env.TEAMS_ACCESS_TOKEN, undefined);
    assert.equal(env.MICROSOFT_CLIENT_SECRET, undefined);
    assert.equal(env.AGENT_RUNNER_TOKEN, undefined);
  });

  it("passes thread-scoped Alola session identity only for Alola-routed harnesses", () => {
    const localEnv = buildHarnessEnv({
      includeAlola: false,
      alolaThreadId: "thread-123",
      env: { PATH: "/usr/bin" },
    });
    assert.equal(localEnv.ALOLA_THREAD_ID, undefined);

    const alolaEnv = buildHarnessEnv({
      includeAlola: true,
      alolaThreadId: "thread-123",
      env: { PATH: "/usr/bin" },
    });
    assert.equal(alolaEnv.ALOLA_THREAD_ID, "thread-123");

    const unsafeEnv = buildHarnessEnv({
      includeAlola: true,
      alolaThreadId: "bad thread id with spaces",
      env: { PATH: "/usr/bin" },
    });
    assert.equal(unsafeEnv.ALOLA_THREAD_ID, undefined);
  });

  it("redacts direct secret values and secret file paths", () => {
    const root = tempDir();
    const secretFile = writeSecret(root, "key", "value");
    const text = `OPENAI_API_KEY=sk-test file=${secretFile}`;

    const redacted = redactSecrets(text, {
      OPENAI_API_KEY: "sk-test",
      OPENAI_API_KEY_FILE: secretFile,
    });

    assert.equal(redacted.includes("sk-test"), false);
    assert.equal(redacted.includes(secretFile), false);
    assert.ok(redacted.includes("[REDACTED]"));
  });
});
