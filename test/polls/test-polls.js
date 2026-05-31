const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ROOT_DIR, STATE_DIR, resolveWorkspace } = require("../../src/config/env");

const POLLS_FILE = path.join(STATE_DIR || ROOT_DIR, "polls.json");
let savedPollsContent = null;

beforeEach(() => {
  savedPollsContent = null;
  if (fs.existsSync(POLLS_FILE)) savedPollsContent = fs.readFileSync(POLLS_FILE, "utf8");
});

afterEach(() => {
  if (savedPollsContent !== null) {
    fs.writeFileSync(POLLS_FILE, savedPollsContent);
  } else if (fs.existsSync(POLLS_FILE)) {
    fs.unlinkSync(POLLS_FILE);
  }
});

// Parse tests keep pure logic inline to avoid exercising module side effects;
// channel-isolation tests below load the module and manipulate in-memory state directly.

function parseInterval(str) {
  const match = str.match(/^(\d+)(m|h|d|w)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const multipliers = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  return n * multipliers[match[2]];
}

function parsePollCommand(text) {
  const match = text.match(/^\/poll\s+(\d+[mhdw])\s+([\s\S]+)$/);
  if (!match) return null;
  const intervalMs = parseInterval(match[1]);
  if (!intervalMs) return null;
  return { intervalStr: match[1], intervalMs, prompt: match[2].trim() };
}

describe("parseInterval", () => {
  it("parses minutes", () => {
    assert.equal(parseInterval("5m"), 300000);
    assert.equal(parseInterval("1m"), 60000);
  });

  it("parses hours", () => {
    assert.equal(parseInterval("1h"), 3600000);
    assert.equal(parseInterval("24h"), 86400000);
  });

  it("parses days", () => {
    assert.equal(parseInterval("1d"), 86400000);
    assert.equal(parseInterval("2d"), 172800000);
  });

  it("parses weeks", () => {
    assert.equal(parseInterval("1w"), 604800000);
  });

  it("returns null for invalid input", () => {
    assert.equal(parseInterval("abc"), null);
    assert.equal(parseInterval("5"), null);
    assert.equal(parseInterval("5s"), null);
    assert.equal(parseInterval(""), null);
    assert.equal(parseInterval("0x"), null);
  });
});

describe("parsePollCommand", () => {
  it("parses a basic poll command", () => {
    const result = parsePollCommand("/poll 2d check my PRs");
    assert.deepEqual(result, {
      intervalStr: "2d",
      intervalMs: 172800000,
      prompt: "check my PRs",
    });
  });

  it("parses poll with multiline prompt", () => {
    const result = parsePollCommand("/poll 1h check CI\nand report failures");
    assert.equal(result.prompt, "check CI\nand report failures");
    assert.equal(result.intervalMs, 3600000);
  });

  it("parses poll with minute interval", () => {
    const result = parsePollCommand("/poll 30m run tests");
    assert.equal(result.intervalMs, 1800000);
    assert.equal(result.prompt, "run tests");
  });

  it("returns null for missing interval", () => {
    assert.equal(parsePollCommand("/poll check stuff"), null);
  });

  it("returns null for missing prompt", () => {
    assert.equal(parsePollCommand("/poll 2d"), null);
    assert.equal(parsePollCommand("/poll 2d "), null);
  });

  it("returns null for non-poll commands", () => {
    assert.equal(parsePollCommand("/worktrees"), null);
    assert.equal(parsePollCommand("hello"), null);
  });

  it("returns null for invalid interval unit", () => {
    assert.equal(parsePollCommand("/poll 5s do stuff"), null);
  });
});

describe("poll channel isolation", () => {
  function poll(id, chatId, active) {
    return {
      id,
      chatId,
      prompt: `${id} prompt`,
      intervalMs: 3600000,
      intervalStr: "1h",
      sessionId: `${id}-session`,
      from: "Tester",
      createdAt: new Date("2026-05-20T12:00:00Z").toISOString(),
      lastRun: null,
      active,
      runCount: active ? 1 : 20,
      maxRuns: 20,
    };
  }

  it("filters polls by current channel", () => {
    const { getPolls, getPollsForChat } = require("../../src/polls/polls");
    const polls = getPolls();
    const ids = ["poll-chat-a", "poll-chat-b", "poll-chat-a-old"];

    try {
      polls.set(ids[0], poll(ids[0], "chat-a", true));
      polls.set(ids[1], poll(ids[1], "chat-b", true));
      polls.set(ids[2], poll(ids[2], "chat-a", false));

      assert.deepEqual(getPollsForChat("chat-a").map((p) => p.id), [ids[0]]);
      assert.deepEqual(getPollsForChat("chat-a", true).map((p) => p.id), [ids[0], ids[2]]);
      assert.deepEqual(getPollsForChat("chat-b").map((p) => p.id), [ids[1]]);
    } finally {
      for (const id of ids) polls.delete(id);
    }
  });

  it("does not cancel or restart crons from another channel", () => {
    const { getPolls, cancelPoll, restartPoll } = require("../../src/polls/polls");
    const polls = getPolls();
    const id = "poll-cross-channel-control";

    try {
      const scoped = poll(id, "chat-a", true);
      polls.set(id, scoped);

      assert.equal(cancelPoll(`/poll-cancel ${id}`, "chat-b"), false);
      assert.equal(scoped.active, true, "other channel cannot cancel the cron");

      scoped.active = false;
      assert.equal(restartPoll(`/poll-restart ${id}`, "reply-id", "chat-b"), false);
      assert.equal(scoped.active, false, "other channel cannot restart the cron");
    } finally {
      polls.delete(id);
    }
  });

  it("keeps result-thread lookup scoped by channel", () => {
    const {
      getPolls,
      getPollForResultThread,
      hasPollResultThread,
      pollResultThreads,
      rememberPollResultThread,
    } = require("../../src/polls/polls");
    const polls = getPolls();
    const ids = ["poll-result-chat-a", "poll-result-chat-b"];

    try {
      polls.set(ids[0], poll(ids[0], "chat-a", true));
      polls.set(ids[1], poll(ids[1], "chat-b", true));
      rememberPollResultThread("chat-a", "same-message-id", ids[0]);
      rememberPollResultThread("chat-b", "same-message-id", ids[1]);

      assert.equal(hasPollResultThread("same-message-id", "chat-a"), true);
      assert.equal(hasPollResultThread("same-message-id", "chat-b"), true);
      assert.equal(getPollForResultThread("same-message-id", "chat-a").id, ids[0]);
      assert.equal(getPollForResultThread("same-message-id", "chat-b").id, ids[1]);
    } finally {
      for (const id of ids) polls.delete(id);
      pollResultThreads.clear();
    }
  });
});
describe("poll workspace persistence", () => {
  it("persists workspace identity for recurring polls", () => {
    const { getPolls, savePollsToDisk } = require("../../src/polls/polls");
    const polls = getPolls();
    const id = "poll-workspace-persist";
    const workspace = resolveWorkspace();

    try {
      polls.set(id, {
        id,
        chatId: "chat-workspace",
        prompt: "check workspace",
        intervalMs: 3600000,
        intervalStr: "1h",
        sessionId: "poll-session-workspace",
        from: "Tester",
        createdAt: new Date("2026-05-20T12:00:00Z").toISOString(),
        lastRun: null,
        active: true,
        runCount: 0,
        maxRuns: 20,
        workspaceId: workspace.id,
        workspaceDir: workspace.dir,
        workspaceSource: workspace.source,
      });

      savePollsToDisk();

      const data = JSON.parse(fs.readFileSync(POLLS_FILE, "utf8"));
      const entry = data.find((poll) => poll.id === id);
      assert.ok(entry, "poll entry exists");
      assert.equal(entry.workspaceId, workspace.id);
      assert.equal(entry.workspaceDir, workspace.dir);
    } finally {
      polls.delete(id);
    }
  });
});
