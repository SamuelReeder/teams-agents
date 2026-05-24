const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ROOT_DIR, THREAD_TTL_MS } = require("../lib/config");

const THREADS_FILE = path.join(ROOT_DIR, "threads.json");
const SESSIONS_DIR = path.join(ROOT_DIR, "sessions");

let savedContent = null;

beforeEach(() => {
  if (fs.existsSync(THREADS_FILE)) {
    savedContent = fs.readFileSync(THREADS_FILE, "utf8");
  }
});

afterEach(() => {
  if (savedContent !== null) {
    fs.writeFileSync(THREADS_FILE, savedContent);
  } else if (fs.existsSync(THREADS_FILE)) {
    fs.unlinkSync(THREADS_FILE);
  }
});

describe("saveThreadsToDisk", () => {
  it("writes threads.json with serializable fields", () => {
    const { getThreads, saveThreadsToDisk } = require("../lib/threads");
    const threads = getThreads();

    threads.set("test-root-1", {
      rootMessageId: "test-root-1",
      sessionId: "sess-1",
      harnessSessionId: "harness-1",
      from: "Test User",
      startTime: new Date("2026-05-20T12:00:00Z"),
      isFollowUp: true,
      busy: false,
      lastSeen: "test-msg-99",
      childPid: 12345,
      pending: { text: "queued", from: "user", messageId: "m1" },
      model: "anthropic/claude-haiku-4-5",
      alola: { node: "03", containerName: "claude-abc" },
    });

    saveThreadsToDisk();

    const data = JSON.parse(fs.readFileSync(THREADS_FILE, "utf8"));
    const entry = data.find((t) => t.rootMessageId === "test-root-1");
    assert.ok(entry, "thread entry exists");
    assert.equal(entry.sessionId, "sess-1");
    assert.equal(entry.harnessSessionId, "harness-1");
    assert.equal(entry.from, "Test User");
    assert.equal(entry.model, "anthropic/claude-haiku-4-5");
    assert.deepEqual(entry.alola, { node: "03", containerName: "claude-abc" });

    assert.equal(entry.busy, undefined, "transient field busy excluded");
    assert.equal(entry.childPid, undefined, "transient field childPid excluded");
    assert.equal(entry.pending, undefined, "transient field pending excluded");
    assert.equal(entry.lastSeen, undefined, "transient field lastSeen excluded");
    assert.equal(entry.isFollowUp, undefined, "transient field isFollowUp excluded");

    threads.delete("test-root-1");
  });
});

describe("loadThreadsFromDisk", () => {
  it("restores threads from threads.json", () => {
    const { getThreads, loadThreadsFromDisk } = require("../lib/threads");
    const threads = getThreads();

    const testData = [
      {
        rootMessageId: "load-test-1",
        sessionId: "sess-load-1",
        harnessSessionId: "harness-load-1",
        from: "Load User",
        startTime: new Date().toISOString(),
        model: "openai/gpt-5.5",
        alola: null,
      },
    ];
    fs.writeFileSync(THREADS_FILE, JSON.stringify(testData));

    threads.delete("load-test-1");
    loadThreadsFromDisk();

    const restored = threads.get("load-test-1");
    assert.ok(restored, "thread was restored");
    assert.equal(restored.sessionId, "sess-load-1");
    assert.equal(restored.harnessSessionId, "harness-load-1");
    assert.equal(restored.from, "Load User");
    assert.equal(restored.model, "openai/gpt-5.5");
    assert.equal(restored.isFollowUp, true, "restored threads start as follow-ups");
    assert.equal(restored.busy, false, "restored threads are not busy");
    assert.equal(restored.childPid, null, "restored threads have no child pid");

    threads.delete("load-test-1");
  });

  it("filters out threads older than TTL", () => {
    const { getThreads, loadThreadsFromDisk } = require("../lib/threads");
    const threads = getThreads();

    const expired = new Date(Date.now() - THREAD_TTL_MS - 60000).toISOString();
    const recent = new Date().toISOString();
    const testData = [
      {
        rootMessageId: "ttl-expired",
        sessionId: "s1",
        harnessSessionId: null,
        from: "User",
        startTime: expired,
        model: null,
        alola: null,
      },
      {
        rootMessageId: "ttl-recent",
        sessionId: "s2",
        harnessSessionId: null,
        from: "User",
        startTime: recent,
        model: null,
        alola: null,
      },
    ];
    fs.writeFileSync(THREADS_FILE, JSON.stringify(testData));

    threads.delete("ttl-expired");
    threads.delete("ttl-recent");
    loadThreadsFromDisk();

    assert.equal(threads.has("ttl-expired"), false, "expired thread not loaded");
    assert.equal(threads.has("ttl-recent"), true, "recent thread loaded");

    threads.delete("ttl-recent");
  });

  it("recovers harnessSessionId from session directory", () => {
    const { getThreads, loadThreadsFromDisk } = require("../lib/threads");
    const threads = getThreads();

    const existingDirs = fs.existsSync(SESSIONS_DIR)
      ? fs.readdirSync(SESSIONS_DIR).filter((d) => {
          const full = path.join(SESSIONS_DIR, d);
          return fs.statSync(full).isDirectory() && /^\d+$/.test(d);
        })
      : [];

    if (existingDirs.length === 0) {
      return;
    }

    const threadId = existingDirs[0];
    const testData = [
      {
        rootMessageId: threadId,
        sessionId: "recovery-test",
        harnessSessionId: null,
        from: "User",
        startTime: new Date().toISOString(),
        model: null,
        alola: null,
      },
    ];
    fs.writeFileSync(THREADS_FILE, JSON.stringify(testData));

    threads.delete(threadId);
    loadThreadsFromDisk();

    const restored = threads.get(threadId);
    assert.ok(restored, "thread restored");
    assert.ok(
      restored.harnessSessionId,
      `harnessSessionId recovered from session dir: ${restored.harnessSessionId}`
    );

    threads.delete(threadId);
  });
});
