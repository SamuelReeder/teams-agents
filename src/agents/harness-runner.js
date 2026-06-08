const { spawn } = require("child_process");
const {
  AGENT_TIMEOUT_MS,
  HARNESS_BIN,
  HARNESS_CONFIG,
  RUNNER_CONFIG,
  buildHarnessEnv,
} = require("../config/env");

function assertStringArray(args, name = "args") {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError(`${name} must be an array of strings`);
  }
}

function normalizedTimeoutMs(value, fallback = AGENT_TIMEOUT_MS) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : fallback;
}

function runnerMode(config = RUNNER_CONFIG) {
  return config && config.url ? "agent-runner" : "local";
}

function runLocalHarness(args, options = {}) {
  assertStringArray(args);
  const cwd = options.cwd || process.cwd();
  const timeoutMs = normalizedTimeoutMs(options.timeoutMs, 0);
  const env = options.env || buildHarnessEnv({
    includeAlola: Boolean(options.includeAlola),
    alolaThreadId: options.alolaThreadId,
  });
  const bin = options.bin || HARNESS_BIN;

  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(bin, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(err);
      return;
    }

    if (typeof options.onStart === "function") options.onStart(proc.pid);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
        }, timeoutMs)
      : null;

    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        pid: proc.pid,
        mode: "local",
      });
    });
  });
}

function runnerEndpoint(config, pathname) {
  const base = String(config.url || "").replace(/\/+$/, "");
  return `${base}${pathname}`;
}

async function readErrorBody(response) {
  try {
    const text = await response.text();
    return text.trim();
  } catch {
    return "";
  }
}

async function postRunner(pathname, payload, options = {}) {
  const config = options.runnerConfig || RUNNER_CONFIG;
  const timeoutMs = normalizedTimeoutMs(payload.timeoutMs, AGENT_TIMEOUT_MS);
  const requestTimeoutMs = timeoutMs > 0 ? timeoutMs + 5000 : 0;
  const controller = requestTimeoutMs > 0 ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), requestTimeoutMs)
    : null;
  const headers = { "content-type": "application/json" };
  if (config.token) headers.authorization = `Bearer ${config.token}`;

  try {
    const response = await fetch(runnerEndpoint(config, pathname), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });

    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new Error(`Agent runner request failed (${response.status}): ${body || response.statusText}`);
    }

    return await response.json();
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(`Agent runner request timed out after ${requestTimeoutMs}ms`);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runRemoteHarness(args, options = {}) {
  assertStringArray(args);
  const payload = {
    args,
    cwd: options.cwd || process.cwd(),
    includeAlola: Boolean(options.includeAlola),
    timeoutMs: normalizedTimeoutMs(options.timeoutMs),
    alolaThreadId: options.alolaThreadId || null,
  };
  const result = await postRunner("/v1/harness/run", payload, options);
  return { ...result, mode: "agent-runner" };
}

function runHarness(args, options = {}) {
  const config = options.runnerConfig || RUNNER_CONFIG;
  if (config && config.url) return runRemoteHarness(args, { ...options, runnerConfig: config });
  return runLocalHarness(args, options);
}

function buildModelListArgs(search = "") {
  const listModelsFlag = HARNESS_CONFIG.flags.listModels;
  if (!listModelsFlag) return null;
  const trimmed = String(search || "").trim();
  return trimmed ? [`${listModelsFlag}=${trimmed}`] : [listModelsFlag];
}

async function listHarnessModels(search = "", options = {}) {
  const args = buildModelListArgs(search);
  if (!args) throw new Error("Model listing is not supported by the configured harness.");
  return runHarness(args, { ...options, includeAlola: false });
}

module.exports = {
  assertStringArray,
  buildModelListArgs,
  listHarnessModels,
  normalizedTimeoutMs,
  postRunner,
  runHarness,
  runLocalHarness,
  runnerMode,
};
