const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ALOLA_CONFIG } = require("./config");

const COMMAND_ID_RE = /^[A-Za-z0-9_-]+$/;
const ASIC_RE = /^gfx[0-9][0-9a-z]*$/i;
const NODE_RE = /^\d{1,2}$/;
const DEFAULT_CAPTURE_LINES = 2000;

function shellQuote(value) {
  const s = String(value);
  if (s.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function parseSshOptions(value) {
  if (!value || !value.trim()) return [];
  const matches = value.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return matches.map((token) => token.replace(/^"(.*)"$/, "$1"));
}

function normalizeAsic(value, config = ALOLA_CONFIG) {
  const raw = String(value || config.defaultAsic || "gfx90a").trim().toLowerCase();
  if (!ASIC_RE.test(raw)) {
    throw new Error(`Invalid Alola ASIC '${value}'`);
  }
  return raw;
}

function normalizeLoginNode(value, config = ALOLA_CONFIG) {
  const raw = String(value || config.defaultLoginNode || "03").trim();
  if (!NODE_RE.test(raw)) {
    throw new Error(`Invalid Alola login node '${value}'`);
  }
  const node = raw.padStart(2, "0");
  if (config.loginNodes?.length && !config.loginNodes.includes(node)) {
    throw new Error(`Alola login node '${node}' is not in ALOLA_LOGIN_NODES (${config.loginNodes.join(",")})`);
  }
  return node;
}

function isConfiguredLoginNodeToken(token, config = ALOLA_CONFIG) {
  if (!NODE_RE.test(String(token || ""))) return false;
  const node = String(token).padStart(2, "0");
  return !config.loginNodes?.length || config.loginNodes.includes(node);
}

function isAsicToken(token) {
  return ASIC_RE.test(String(token || ""));
}

function isGpuToken(token) {
  return /^gpu:/i.test(String(token || ""));
}

function parseAlolaTarget(tokens = [], config = ALOLA_CONFIG) {
  const parts = Array.isArray(tokens)
    ? tokens.filter((part) => part !== undefined && part !== null && String(part).length > 0)
    : String(tokens || "").trim().split(/\s+/).filter(Boolean);

  let loginNode = null;
  let asic = null;
  let forceGpu = false;

  for (const part of parts) {
    const token = String(part).trim();
    if (!token) continue;
    if (token.toLowerCase() === "default") continue;

    if (isGpuToken(token)) {
      forceGpu = true;
      asic = normalizeAsic(token.slice("gpu:".length), config);
      continue;
    }

    if (NODE_RE.test(token) && !asic) {
      loginNode = normalizeLoginNode(token, config);
      continue;
    }

    if (isAsicToken(token)) {
      forceGpu = true;
      asic = normalizeAsic(token, config);
      continue;
    }

    throw new Error(`Invalid --alola target token '${token}'`);
  }

  const normalizedAsic = normalizeAsic(asic || config.defaultAsic || "gfx90a", config);
  const normalizedNode = normalizeLoginNode(loginNode || config.defaultLoginNode || "03", config);
  const mode = forceGpu ? "gpu" : "login";

  return {
    mode,
    loginNode: normalizedNode,
    asic: normalizedAsic,
    container: config.defaultLoginContainer,
    image: imagePathForAsic(normalizedAsic, config),
    constraint: mode === "gpu" ? defaultConstraintForAsic(normalizedAsic, config) : null,
    timeLimit: config.defaultGpuTimeout,
  };
}

function imagePathForAsic(asic, config = ALOLA_CONFIG) {
  const normalized = normalizeAsic(asic, config);
  return String(config.imageTemplate || "/cluster/images/hipdnn/hipdnn_latest_{asic}.sqsh")
    .replace(/\{asic\}/g, normalized)
    .replace(/\{ASIC\}/g, normalized.toUpperCase());
}

function defaultConstraintForAsic(asic, config = ALOLA_CONFIG) {
  const upper = normalizeAsic(asic, config).toUpperCase();
  const prefix = String(config.defaultConstraintPrefix || "").trim();
  return prefix ? `${prefix}&${upper}` : upper;
}

function sanitizeTmuxSessionName(value, maxLength = 64) {
  const sanitized = String(value || "teams")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength);
  return sanitized || "teams";
}

function shortHash(value, length = 12) {
  return crypto.createHash("sha256").update(String(value || "manual")).digest("hex").slice(0, length);
}

function buildTmuxSessionName(seed, target, config = ALOLA_CONFIG) {
  const normalized = target.mode ? target : parseAlolaTarget(target, config);
  const suffix = `${normalized.mode}_${normalized.loginNode}_${normalized.asic}`;
  return sanitizeTmuxSessionName(`teams_${shortHash(seed)}_${suffix}`);
}

function buildSessionMetadata(threadInfo = {}, target = null, config = ALOLA_CONFIG) {
  const normalized = target?.mode ? target : parseAlolaTarget(target || [], config);
  const seed = threadInfo.rootMessageId || threadInfo.sessionId || normalized.tmuxSession || "manual";
  const tmuxSession = normalized.tmuxSession || buildTmuxSessionName(seed, normalized, config);
  const metadata = {
    mode: normalized.mode,
    loginNode: normalizeLoginNode(normalized.loginNode, config),
    asic: normalizeAsic(normalized.asic, config),
    container: normalized.container || config.defaultLoginContainer,
    image: imagePathForAsic(normalized.asic, config),
    constraint: normalized.mode === "gpu"
      ? (normalized.constraint || defaultConstraintForAsic(normalized.asic, config))
      : null,
    tmuxSession,
    slurmJobId: normalized.slurmJobId || null,
    timeLimit: normalized.timeLimit || config.defaultGpuTimeout,
    lastSeen: new Date().toISOString(),
  };
  if (normalized.expiresAt) metadata.expiresAt = normalized.expiresAt;
  return metadata;
}

function coerceAlolaMetadata(value, threadInfo = {}, config = ALOLA_CONFIG) {
  if (!value) return null;

  if (value.mode) {
    const metadata = buildSessionMetadata(threadInfo, value, config);
    metadata.tmuxSession = value.tmuxSession || metadata.tmuxSession;
    metadata.slurmJobId = value.slurmJobId || null;
    metadata.lastSeen = value.lastSeen || metadata.lastSeen;
    if (value.expiresAt) metadata.expiresAt = value.expiresAt;
    return metadata;
  }

  if (value.node || value.loginNode || value.containerName) {
    return buildSessionMetadata(
      threadInfo,
      {
        mode: "login",
        loginNode: value.loginNode || value.node || config.defaultLoginNode,
        asic: value.asic || config.defaultAsic,
        container: config.defaultLoginContainer,
      },
      config
    );
  }

  return buildSessionMetadata(threadInfo, value, config);
}

function describeAlolaTarget(metadata) {
  if (!metadata) return "HPE local";
  const base = metadata.mode === "gpu"
    ? `Alola GPU ${metadata.asic} via login ${metadata.loginNode}`
    : `Alola login ${metadata.loginNode} (${metadata.asic})`;
  const session = metadata.tmuxSession ? ` session=${metadata.tmuxSession}` : "";
  const job = metadata.slurmJobId ? ` job=${metadata.slurmJobId}` : "";
  return `${base}${session}${job}`;
}

function buildLoginStartCommand(metadata) {
  const session = shellQuote(metadata.tmuxSession);
  const container = shellQuote(metadata.container || ALOLA_CONFIG.defaultLoginContainer);
  const enrootCommand = `export ENROOT_ROOTFS_WRITABLE=y; exec enroot start --rw --mount "$HOME:$HOME" ${container} bash --login`;
  return `tmux new-session -Ad -s ${session} ${shellQuote(enrootCommand)}`;
}

function buildGpuStartCommand(metadata, config = ALOLA_CONFIG) {
  const session = shellQuote(metadata.tmuxSession);
  const image = shellQuote(metadata.image || imagePathForAsic(metadata.asic, config));
  const mounts = shellQuote(config.remoteHomeMount || "/home/AMD/sareeder:/home/AMD/sareeder");
  const constraint = shellQuote(metadata.constraint || defaultConstraintForAsic(metadata.asic, config));
  const timeLimit = shellQuote(metadata.timeLimit || config.defaultGpuTimeout);
  const cpus = Number.isInteger(config.gpuCpusPerTask) && config.gpuCpusPerTask > 0 ? config.gpuCpusPerTask : 16;
  const partition = shellQuote(config.gpuPartition || "defq");
  const srunCommand = `srun --pty --container-image=${image} --container-mounts=${mounts} bash --login`;
  const sallocCommand = [
    "salloc",
    `--partition=${partition}`,
    `--job-name=${session}`,
    `--constraint=${constraint}`,
    "--gpus-per-node=1",
    `--cpus-per-task=${cpus}`,
    `--time=${timeLimit}`,
    "bash -lc",
    shellQuote(srunCommand),
  ].join(" ");
  return `tmux new-session -Ad -s ${session} ${shellQuote(sallocCommand)}`;
}

function buildStartCommand(metadata, config = ALOLA_CONFIG) {
  return metadata.mode === "gpu"
    ? buildGpuStartCommand(metadata, config)
    : buildLoginStartCommand(metadata, config);
}

function buildSessionExistsCommand(sessionName) {
  return `tmux has-session -t ${shellQuote(sessionName)} >/dev/null 2>&1`;
}

function buildWriteScriptCommand(commandId) {
  assertCommandId(commandId);
  return [
    'dir="$HOME/.teams-agent/commands"',
    'mkdir -p "$dir"',
    'umask 077',
    'tmp=$(mktemp "$dir/.cmd.XXXXXX")',
    'cat > "$tmp"',
    'chmod 700 "$tmp"',
    `mv "$tmp" "$dir/${commandId}.sh"`,
  ].join(" && ");
}

function buildSendKeysCommand(metadata, commandId) {
  assertCommandId(commandId);
  const invocation = `bash "$HOME/.teams-agent/commands/${commandId}.sh"`;
  return `tmux send-keys -t ${shellQuote(metadata.tmuxSession)} ${shellQuote(invocation)} Enter`;
}

function buildCaptureCommand(metadata, lines = DEFAULT_CAPTURE_LINES) {
  const count = Math.max(1, parseInt(lines, 10) || DEFAULT_CAPTURE_LINES);
  return `tmux capture-pane -p -S -${count} -t ${shellQuote(metadata.tmuxSession)}`;
}

function buildStopCommand(metadata, config = ALOLA_CONFIG) {
  const commands = [`tmux kill-session -t ${shellQuote(metadata.tmuxSession)} >/dev/null 2>&1 || true`];
  if (metadata.mode === "gpu") {
    if (metadata.slurmJobId) {
      commands.push(`scancel ${shellQuote(metadata.slurmJobId)} >/dev/null 2>&1 || true`);
    }
    commands.push(`scancel -u ${shellQuote(config.user)} -n ${shellQuote(metadata.tmuxSession)} >/dev/null 2>&1 || true`);
  }
  return commands.join("; ");
}

function buildRemoteScript(command, commandId) {
  assertCommandId(commandId);
  const start = `__CMD_START_${commandId}__`;
  const done = `__CMD_DONE_${commandId}__`;
  return [
    "#!/usr/bin/env bash",
    "__teams_agent_finish() {",
    "  local rc=$?",
    "  trap - EXIT",
    `  printf '%s:%s\\n' ${shellQuote(done)} "$rc"`,
    "  exit \"$rc\"",
    "}",
    "trap __teams_agent_finish EXIT",
    `printf '%s\\n' ${shellQuote(start)}`,
    "set +e",
    String(command || ""),
    "",
  ].join("\n");
}

function parseCapturedCommand(capture, commandId) {
  assertCommandId(commandId);
  const start = `__CMD_START_${commandId}__`;
  const done = `__CMD_DONE_${commandId}__`;
  const text = String(capture || "");
  const doneRe = new RegExp(`${escapeRegex(done)}:(\\d+)`);
  const doneMatch = text.match(doneRe);
  if (!doneMatch) return { complete: false, output: text, rc: null };

  const startIndex = text.lastIndexOf(start);
  const outputStart = startIndex === -1 ? 0 : startIndex + start.length;
  const output = text
    .slice(outputStart, doneMatch.index)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");
  return { complete: true, output, rc: parseInt(doneMatch[1], 10) };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertCommandId(commandId) {
  if (!COMMAND_ID_RE.test(String(commandId || ""))) {
    throw new Error(`Invalid command id '${commandId}'`);
  }
}

function sshArgsForNode(loginNode, remoteCommand, config = ALOLA_CONFIG) {
  const node = normalizeLoginNode(loginNode, config);
  const args = [];
  if (config.sshKey) args.push("-i", config.sshKey);
  args.push(...parseSshOptions(config.sshOptions));
  args.push(`${config.user}@ctr2-alola-login-${node}`);
  if (remoteCommand) args.push(remoteCommand);
  return args;
}

function buildAttachCommand(metadata, config = ALOLA_CONFIG) {
  const args = ["ssh"];
  if (config.sshKey) args.push("-i", shellQuote(config.sshKey));
  args.push(...parseSshOptions(config.sshOptions));
  args.push(`${config.user}@ctr2-alola-login-${metadata.loginNode}`);
  args.push("-t", "tmux", "attach", "-t", metadata.tmuxSession);
  return args.map((arg) => shellQuote(arg)).join(" ");
}

class AlolaSessionManager {
  constructor(config = ALOLA_CONFIG) {
    this.config = config;
  }

  loadState() {
    try {
      if (!fs.existsSync(this.config.stateFile)) return { sessions: {} };
      const parsed = JSON.parse(fs.readFileSync(this.config.stateFile, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : { sessions: {} };
    } catch {
      return { sessions: {} };
    }
  }

  saveState(state) {
    fs.mkdirSync(path.dirname(this.config.stateFile), { recursive: true });
    fs.writeFileSync(this.config.stateFile, JSON.stringify(state, null, 2));
  }

  record(metadata) {
    const state = this.loadState();
    state.sessions ||= {};
    state.sessions[`${metadata.loginNode}:${metadata.tmuxSession}`] = {
      ...metadata,
      lastSeen: new Date().toISOString(),
    };
    this.saveState(state);
  }

  runSsh(metadataOrNode, remoteCommand, options = {}) {
    const loginNode = typeof metadataOrNode === "string" ? metadataOrNode : metadataOrNode.loginNode;
    const result = spawnSync("ssh", sshArgsForNode(loginNode, remoteCommand, this.config), {
      input: options.input,
      encoding: "utf8",
      timeout: options.timeoutMs || this.config.sshTimeoutMs || 30000,
      maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && !options.allowFailure) {
      const detail = (result.stderr || result.stdout || `ssh exited ${result.status}`).trim();
      throw new Error(detail);
    }
    return result;
  }

  status(metadata) {
    const session = shellQuote(metadata.tmuxSession);
    const commands = [
      `${buildSessionExistsCommand(metadata.tmuxSession)} && echo tmux=yes || echo tmux=no`,
    ];
    if (metadata.mode === "gpu") {
      commands.push(`squeue -h -u ${shellQuote(this.config.user)} -n ${session} -o ${shellQuote("%A %T %M %L")} || true`);
    }
    const result = this.runSsh(metadata, commands.join("; "), { allowFailure: true });
    const stdout = result.stdout || "";
    const tmuxExists = /(^|\n)tmux=yes(\n|$)/.test(stdout);
    const jobLine = stdout.split("\n").map((line) => line.trim()).find((line) => /^\d+\s+/.test(line));
    const slurmJobId = jobLine ? jobLine.split(/\s+/)[0] : null;
    return { tmuxExists, slurmJobId, raw: stdout };
  }

  ensureSession(metadata) {
    const current = this.status(metadata);
    if (metadata.mode === "gpu" && metadata.slurmJobId && !current.slurmJobId) {
      this.runSsh(metadata, buildStopCommand(metadata, this.config), { allowFailure: true });
      current.tmuxExists = false;
    }

    if (!current.tmuxExists) {
      this.runSsh(metadata, buildStartCommand(metadata, this.config), { timeoutMs: this.config.startTimeoutMs || 60000 });
    }

    if (metadata.mode === "gpu") {
      const refreshed = this.status(metadata);
      if (refreshed.slurmJobId) metadata.slurmJobId = refreshed.slurmJobId;
    }

    this.record(metadata);
    return metadata;
  }

  async runCommand(metadata, command, options = {}) {
    const commandId = options.commandId || crypto.randomBytes(8).toString("hex");
    const captureLines = options.captureLines || DEFAULT_CAPTURE_LINES;
    const timeoutMs = options.timeoutMs || this.config.commandTimeoutMs || 30 * 60 * 1000;
    const pollMs = options.pollMs || 1000;

    this.ensureSession(metadata);
    this.runSsh(metadata, buildWriteScriptCommand(commandId), {
      input: buildRemoteScript(command, commandId),
      timeoutMs: this.config.sshTimeoutMs || 30000,
    });
    this.runSsh(metadata, buildSendKeysCommand(metadata, commandId));

    const deadline = Date.now() + timeoutMs;
    let lastCapture = "";
    while (Date.now() < deadline) {
      const capture = this.runSsh(metadata, buildCaptureCommand(metadata, captureLines), { allowFailure: true });
      lastCapture = capture.stdout || "";
      const parsed = parseCapturedCommand(lastCapture, commandId);
      if (parsed.complete) {
        this.record(metadata);
        return parsed;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    const err = new Error(`Timed out waiting for ${commandId}`);
    err.capture = lastCapture;
    throw err;
  }

  stop(metadata) {
    const result = this.runSsh(metadata, buildStopCommand(metadata, this.config), { allowFailure: true });
    const state = this.loadState();
    if (state.sessions) delete state.sessions[`${metadata.loginNode}:${metadata.tmuxSession}`];
    this.saveState(state);
    return result;
  }
}

module.exports = {
  AlolaSessionManager,
  shellQuote,
  parseSshOptions,
  normalizeAsic,
  normalizeLoginNode,
  isConfiguredLoginNodeToken,
  isAsicToken,
  isGpuToken,
  parseAlolaTarget,
  imagePathForAsic,
  defaultConstraintForAsic,
  sanitizeTmuxSessionName,
  buildTmuxSessionName,
  buildSessionMetadata,
  coerceAlolaMetadata,
  describeAlolaTarget,
  buildLoginStartCommand,
  buildGpuStartCommand,
  buildStartCommand,
  buildSessionExistsCommand,
  buildWriteScriptCommand,
  buildSendKeysCommand,
  buildCaptureCommand,
  buildStopCommand,
  buildRemoteScript,
  parseCapturedCommand,
  sshArgsForNode,
  buildAttachCommand,
};
