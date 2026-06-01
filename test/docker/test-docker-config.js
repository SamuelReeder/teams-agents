const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.join(__dirname, "../..");

function readText(file) {
  return fs.readFileSync(path.join(ROOT_DIR, file), "utf8");
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

  it("mounts config/channels.json as the single channel source of truth", () => {
    const compose = readText("compose.yaml");
    assert.ok(compose.includes("./config/channels.json:/app/config/channels.json:ro"));
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

  it("uses Docker secrets for the Alola SSH key", () => {
    const compose = readText("compose.yaml");
    const dockerfile = readText("Dockerfile");

    assert.ok(compose.includes("secrets:"));
    assert.ok(compose.includes("source: alola_ssh_key"));
    assert.ok(compose.includes("file: ${ALOLA_SSH_KEY_SOURCE:-./secrets/alola_ssh_key}"));
    assert.ok(compose.includes("ALOLA_SSH_KEY_FILE: /run/secrets/alola_ssh_key"));
    assert.ok(dockerfile.includes("ALOLA_SSH_KEY_FILE=/run/secrets/alola_ssh_key"));
  });

  it("defaults to a portable harness command instead of an HPE home path", () => {
    const compose = readText("compose.yaml");
    assert.ok(compose.includes("HARNESS_BIN: ${HARNESS_BIN:-omp}"));
    assert.equal(compose.includes("/home/${APP_USER:-sareeder}/.local/bin/omp"), false);
    assert.ok(compose.includes("PI_STREAM_FIRST_EVENT_TIMEOUT_MS: ${PI_STREAM_FIRST_EVENT_TIMEOUT_MS:-600000}"));
    assert.ok(compose.includes("PI_STREAM_IDLE_TIMEOUT_MS: ${PI_STREAM_IDLE_TIMEOUT_MS:-600000}"));
  });

  it("runs with the configured uid/gid and home-local harness paths on PATH", () => {
    const dockerfile = readText("Dockerfile");
    assert.ok(dockerfile.includes("USER ${APP_UID}:${APP_GID}"));
    assert.ok(dockerfile.includes("PATH=/home/${APP_USER}/.local/bin:/home/${APP_USER}/.bun/bin:${PATH}"));
  });

  it("passes supported non-channel runtime variables explicitly", () => {
    const compose = readText("compose.yaml");
    for (const key of [
      "TEAMS_SCRIPTS_DIR:",
      "TEAMS_REPLY_SCRIPT:",
      "HARNESS_DEFAULT_MODEL:",
      "ALOLA_HARNESS_DEFAULT_MODEL:",
      "ALOLA_USER:",
      "ALOLA_DEFAULT_ASIC:",
      "ALOLA_IMAGE_TEMPLATE:",
      "ALOLA_COMMAND_TIMEOUT_MS:"
    ]) {
      assert.ok(compose.includes(key), `${key} missing from compose environment`);
    }
    assert.ok(compose.includes("${HOST_HOME_DIR:-teams_home}:/home/${APP_USER:-teamsbot}"));
  });

  it("uses safe Docker defaults for host filesystem and dashboard exposure", () => {
    const compose = readText("compose.yaml");
    assert.ok(compose.includes("${HOST_WORKSPACE_DIR:-teams_workspace}:${APP_WORKSPACE_DIR:-/app/workspace}"));
    assert.ok(compose.includes("${HOST_HOME_DIR:-teams_home}:/home/${APP_USER:-teamsbot}"));
    assert.ok(compose.includes("${HOST_BIND_ADDR:-127.0.0.1}:${PORT:-3978}:3978"));
  });
});
