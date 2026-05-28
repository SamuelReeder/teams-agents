const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.join(__dirname, "..");

function ignoredEntries() {
  const dockerignore = fs.readFileSync(path.join(ROOT_DIR, ".dockerignore"), "utf8");
  return dockerignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

describe("Docker deployment config", () => {
  it("includes channels.json in the build context when present", () => {
    const entries = ignoredEntries();

    assert.equal(
      entries.includes("channels.json"),
      false,
      "docker compose builds must include channels.json so multi-chat config reaches /app/channels.json"
    );
  });

  it("excludes workspace-local clones from the Docker build context", () => {
    const entries = ignoredEntries();

    assert.equal(entries.includes("workspace/repos"), true);
    assert.equal(entries.includes("workspace/worktrees"), true);
  });

  it("uses the mounted HPE OMP harness by default", () => {
    const compose = fs.readFileSync(path.join(ROOT_DIR, "compose.yaml"), "utf8");
    assert.ok(compose.includes("HARNESS_BIN: ${HARNESS_BIN:-/home/${APP_USER:-sareeder}/.local/bin/omp}"));
    assert.ok(compose.includes("PI_STREAM_FIRST_EVENT_TIMEOUT_MS: ${PI_STREAM_FIRST_EVENT_TIMEOUT_MS:-600000}"));
    assert.ok(compose.includes("PI_STREAM_IDLE_TIMEOUT_MS: ${PI_STREAM_IDLE_TIMEOUT_MS:-600000}"));
  });
});
