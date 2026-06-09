const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.join(__dirname, "../..");

function readText(file) {
  return fs.readFileSync(path.join(ROOT_DIR, file), "utf8");
}

function serviceBlock(compose, serviceName) {
  const marker = `  ${serviceName}:\n`;
  const start = compose.indexOf(marker);
  assert.notEqual(start, -1, `${serviceName} service missing`);
  const rest = compose.slice(start + marker.length);
  const nextService = rest.search(/\n  [A-Za-z0-9_-]+:\n/);
  const topLevelVolumes = rest.search(/\nvolumes:\n/);
  const candidates = [nextService, topLevelVolumes].filter((idx) => idx >= 0);
  const end = candidates.length ? Math.min(...candidates) : rest.length;
  return compose.slice(start, start + marker.length + end);
}

function ignoredEntries() {
  return readText(".dockerignore")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

describe("Docker deployment config", () => {
  it("uses a configurable Debian-compatible base image and installs Node if absent", () => {
    const dockerfile = readText("Dockerfile");
    assert.match(dockerfile, /^ARG BASE_IMAGE=node:20-bookworm-slim\nFROM \$\{BASE_IMAGE\}/);
    assert.ok(dockerfile.includes("Custom BASE_IMAGE values must be Debian/Ubuntu compatible"));
    assert.ok(dockerfile.includes('node_major="$(node -p'));
    assert.ok(dockerfile.includes("https://deb.nodesource.com/node_20.x"));
    assert.ok(dockerfile.includes("apt-get install -y --no-install-recommends nodejs"));
  });

  it("passes BASE_IMAGE through compose build args", () => {
    const compose = readText("compose.yaml");
    assert.equal(compose.includes("NODE_IMAGE:"), false);
    assert.ok(compose.includes("BASE_IMAGE: ${BASE_IMAGE:-node:20-bookworm-slim}"));
  });

  it("excludes runtime secrets, env files, and channel files from the Docker build context", () => {
    const entries = ignoredEntries();

    assert.equal(entries.includes("secrets"), true);
    assert.equal(entries.includes(".env"), true);
    assert.equal(entries.includes(".env.*"), true);
    assert.equal(entries.includes("!config/env.example"), true);
    assert.equal(entries.includes("channels.json"), true);
    assert.equal(entries.includes("config/channels.json"), true);
  });

  it("mounts config/channels.json only into the Teams bot", () => {
    const compose = readText("compose.yaml");
    const bot = serviceBlock(compose, "teams-bot");
    const runner = serviceBlock(compose, "agent-runner");

    assert.ok(bot.includes("./config/channels.json:/app/config/channels.json:ro"));
    assert.equal(runner.includes("config/channels.json"), false);
  });

  it("separates bot-only Teams material from runner-only harness material", () => {
    const compose = readText("compose.yaml");
    const bot = serviceBlock(compose, "teams-bot");
    const runner = serviceBlock(compose, "agent-runner");

    assert.ok(bot.includes("TEAMS_SCRIPTS_DIR:"));
    assert.ok(bot.includes("TEAMS_REPLY_SCRIPT:"));
    assert.ok(bot.includes("${HOST_HOME_DIR:-${HOME:-teams_home}}:/home/${APP_USER:-teamsbot}"));
    assert.ok(bot.includes("AGENT_RUNNER_URL:"));
    assert.equal(bot.includes("${HOST_SECRETS_DIR:-./secrets}:/app/secrets:ro"), false);
    assert.equal(bot.includes("ALOLA_SSH_KEY_FILE"), false);

    assert.ok(runner.includes("command: [\"node\", \"/app/src/agents/runner-server.js\"]"));
    assert.ok(runner.includes("${HOST_SECRETS_DIR:-./secrets}:/app/secrets:ro"));
    assert.ok(runner.includes("${RUNNER_HOME_DIR:-teams_runner_home}:/home/${APP_USER:-teamsbot}"));
    assert.ok(runner.includes("AGENT_RUNNER_ALLOWED_ROOTS:"));
    assert.equal(runner.includes("TEAMS_SCRIPTS_DIR:"), false);
    assert.equal(runner.includes("TEAMS_REPLY_SCRIPT:"), false);
    assert.equal(runner.includes("${HOST_HOME_DIR:-${HOME:-teams_home}}"), false);
  });

  it("does not pass .env wholesale as a second channel source", () => {
    const compose = readText("compose.yaml");
    assert.equal(compose.includes("env_file:"), false);
    assert.equal(compose.includes("TEAMS_CHAT_ID"), false);
  });

  it("excludes workspaces and workspace-local clones from the Docker build context", () => {
    const entries = ignoredEntries();

    assert.equal(entries.includes("workspace"), true);
    assert.equal(entries.includes("workspace/repos"), true);
    assert.equal(entries.includes("workspace/worktrees"), true);
  });

  it("mounts workspace-local clones and worktrees as durable volumes", () => {
    const compose = readText("compose.yaml");
    const dockerfile = readText("Dockerfile");

    assert.ok(compose.includes("teams_workspace_repos:${APP_WORKSPACE_DIR:-/app/workspace}/repos"));
    assert.ok(compose.includes("teams_workspace_worktrees:${APP_WORKSPACE_DIR:-/app/workspace}/worktrees"));
    assert.match(compose, /^  teams_workspace_repos:$/m);
    assert.match(compose, /^  teams_workspace_worktrees:$/m);
    assert.ok(dockerfile.includes("/app/workspace/repos /app/workspace/worktrees"));
  });

  it("keeps the Alola SSH key mount opt-in and runner-owned", () => {
    const compose = readText("compose.yaml");
    const alolaCompose = readText("compose.alola.yaml");
    const dockerfile = readText("Dockerfile");

    assert.equal(compose.includes("ALOLA_SSH_KEY_FILE"), false);
    assert.equal(compose.includes("remote_ssh_key"), false);
    assert.equal(dockerfile.includes("ALOLA_SSH_KEY_FILE="), false);
    assert.ok(alolaCompose.includes("agent-runner:"));
    assert.equal(alolaCompose.includes("teams-bot:"), false);
    assert.ok(alolaCompose.includes("ALOLA_SSH_KEY_FILE: /run/secrets/remote_ssh_key"));
    assert.ok(alolaCompose.includes("source: remote_ssh_key"));
    assert.ok(alolaCompose.includes("file: ${ALOLA_SSH_KEY_SOURCE:?Set ALOLA_SSH_KEY_SOURCE"));
  });

  it("defaults to a portable runner harness command instead of a user-specific home path", () => {
    const compose = readText("compose.yaml");
    const runner = serviceBlock(compose, "agent-runner");

    assert.ok(runner.includes("HARNESS_BIN: ${HARNESS_BIN:-omp}"));
    assert.equal(compose.includes("/home/${APP_USER:-remote-user}/.local/bin/omp"), false);
    assert.ok(runner.includes("PI_STREAM_FIRST_EVENT_TIMEOUT_MS: ${PI_STREAM_FIRST_EVENT_TIMEOUT_MS:-600000}"));
    assert.ok(runner.includes("PI_STREAM_IDLE_TIMEOUT_MS: ${PI_STREAM_IDLE_TIMEOUT_MS:-600000}"));
  });

  it("runs with the configured uid/gid and home-local harness paths on PATH", () => {
    const dockerfile = readText("Dockerfile");
    assert.ok(dockerfile.includes("USER ${APP_UID}:${APP_GID}"));
    assert.ok(dockerfile.includes("PATH=/home/${APP_USER}/.local/bin:/home/${APP_USER}/.bun/bin:${PATH}"));
    assert.ok(dockerfile.includes("sudo"));
    assert.ok(dockerfile.includes("/etc/sudoers.d/teams-bot"));
    assert.equal(dockerfile.includes("chown -R \"${APP_UID}:${APP_GID}\" \"$workspace_path\""), false);
  });

  it("passes supported non-channel runtime variables explicitly", () => {
    const compose = readText("compose.yaml");
    for (const key of [
      "TEAMS_SCRIPTS_DIR:",
      "TEAMS_REPLY_SCRIPT:",
      "AGENT_RUNNER_URL:",
      "AGENT_RUNNER_BIND_HOST:",
      "AGENT_RUNNER_PORT:",
      "AGENT_RUNNER_TOKEN:",
      "AGENT_RUNNER_ALLOWED_ROOTS:",
      "HARNESS_DEFAULT_MODEL:",
      "HARNESS_PROMPT_FLAG:",
      "HARNESS_SESSION_FLAG:",
      "HARNESS_SESSION_DIR_FLAG:",
      "HARNESS_RESUME_FLAG:",
      "HARNESS_SYSTEM_PROMPT_FLAG:",
      "HARNESS_SKIP_PERMISSIONS_FLAG:",
      "HARNESS_MCP_FLAG:",
      "HARNESS_ADD_DIR_FLAG:",
      "HARNESS_MODEL_FLAG:",
      "HARNESS_LIST_MODELS_FLAG:",
      "HARNESS_ENV_PASSTHROUGH:",
      "ALOLA_HARNESS_DEFAULT_MODEL:",
      "ALOLA_USER:",
      "ALOLA_DEFAULT_ASIC:",
      "ALOLA_IMAGE_TEMPLATE:",
      "ALOLA_SSH_HOST_TEMPLATE:",
      "ALOLA_COMMAND_TIMEOUT_MS:"
    ]) {
      assert.ok(compose.includes(key), `${key} missing from compose environment`);
    }
    assert.ok(compose.includes("${TEAMS_SCRIPTS_DIR:-${TEAMS_SCRIPT_DIR:-/home/${APP_USER:-teamsbot}/.claude/skills/m365-teams/scripts}}"));
    assert.ok(compose.includes("${HOST_HOME_DIR:-${HOME:-teams_home}}:/home/${APP_USER:-teamsbot}"));
  });

  it("uses explicit Docker defaults for mounts and dashboard exposure", () => {
    const compose = readText("compose.yaml");
    const bot = serviceBlock(compose, "teams-bot");
    const runner = serviceBlock(compose, "agent-runner");

    assert.ok(runner.includes("${HOST_SECRETS_DIR:-./secrets}:/app/secrets:ro"));
    assert.ok(bot.includes("${HOST_WORKSPACE_DIR:-teams_workspace}:${APP_WORKSPACE_DIR:-/app/workspace}"));
    assert.ok(runner.includes("${HOST_WORKSPACE_DIR:-teams_workspace}:${APP_WORKSPACE_DIR:-/app/workspace}"));
    assert.ok(bot.includes("${HOST_HOME_DIR:-${HOME:-teams_home}}:/home/${APP_USER:-teamsbot}"));
    assert.ok(runner.includes("${RUNNER_HOME_DIR:-teams_runner_home}:/home/${APP_USER:-teamsbot}"));
    assert.ok(bot.includes("${HOST_BIND_ADDR:-127.0.0.1}:${PORT:-3978}:3978"));
    assert.equal(runner.includes("ports:"), false);
    assert.match(compose, /^  teams_runner_home:$/m);
  });
});
