const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { RUNNER_CONFIG } = require("../config/env");
const { assertStringArray, normalizedTimeoutMs, runLocalHarness } = require("./harness-runner");

const MAX_REQUEST_BYTES = 1024 * 1024;

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function writeJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonRequest(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BYTES) {
        reject(httpError(413, "Request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(httpError(400, `Invalid JSON request body: ${err.message}`));
      }
    });

    req.on("error", reject);
  });
}

function timingSafeStringEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function isAuthorized(req, token) {
  if (!token) return true;
  const supplied = bearerToken(req) || req.headers["x-agent-runner-token"] || "";
  return timingSafeStringEqual(supplied, token);
}

function existingRealDirectory(dir) {
  let real;
  try {
    real = fs.realpathSync(dir);
    if (!fs.statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  return real;
}

function normalizeAllowedRoots(roots) {
  const out = [];
  for (const root of roots || []) {
    if (!root) continue;
    const real = existingRealDirectory(path.resolve(String(root)));
    if (real && !out.includes(real)) out.push(real);
  }
  return out;
}

function isPathWithin(realPath, realRoot) {
  const relative = path.relative(realRoot, realPath);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateCwd(cwd, allowedRoots) {
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw httpError(400, "cwd must be a non-empty string");
  }

  const realCwd = existingRealDirectory(path.resolve(cwd));
  if (!realCwd) throw httpError(400, `cwd is not a readable directory: ${cwd}`);

  const roots = normalizeAllowedRoots(allowedRoots);
  if (roots.length === 0) throw httpError(500, "No readable AGENT_RUNNER_ALLOWED_ROOTS are configured");

  for (const root of roots) {
    if (isPathWithin(realCwd, root)) return realCwd;
  }

  throw httpError(403, `cwd is outside AGENT_RUNNER_ALLOWED_ROOTS: ${cwd}`);
}

async function executeHarnessPayload(payload, config = RUNNER_CONFIG, executor = runLocalHarness) {
  assertStringArray(payload.args);
  const cwd = validateCwd(payload.cwd, config.allowedRoots);
  return executor(payload.args, {
    cwd,
    includeAlola: Boolean(payload.includeAlola),
    alolaThreadId: payload.alolaThreadId,
    timeoutMs: normalizedTimeoutMs(payload.timeoutMs),
  });
}

function createRunnerServer(config = RUNNER_CONFIG, options = {}) {
  const executor = options.runHarness || runLocalHarness;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://agent-runner.local");

    if (req.method === "GET" && url.pathname === "/health") {
      writeJson(res, 200, { ok: true });
      return;
    }

    if (req.method !== "POST" || url.pathname !== "/v1/harness/run") {
      writeJson(res, 404, { error: "Not found" });
      return;
    }

    if (!isAuthorized(req, config.token)) {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }

    try {
      const payload = await readJsonRequest(req);
      const result = await executeHarnessPayload(payload, config, executor);
      writeJson(res, 200, result);
    } catch (err) {
      const statusCode = err.statusCode || 500;
      writeJson(res, statusCode, { error: err.message || "Runner request failed" });
    }
  });

  server.requestTimeout = 0;
  server.timeout = 0;
  server.headersTimeout = 60000;
  return server;
}

function startRunnerServer(config = RUNNER_CONFIG) {
  const server = createRunnerServer(config);
  server.listen(config.port, config.bindHost, () => {
    console.log(`[Agent runner] Listening on ${config.bindHost}:${config.port}; allowed roots: ${config.allowedRoots.join(", ")}`);
  });
  return server;
}

if (require.main === module) startRunnerServer();

module.exports = {
  createRunnerServer,
  executeHarnessPayload,
  isAuthorized,
  isPathWithin,
  normalizeAllowedRoots,
  startRunnerServer,
  validateCwd,
};
