const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT_DIR = path.join(__dirname, "../..");
const HOME = process.env.HOME || os.homedir();

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([^#=]+)=(.*)$/);
    if (!match) continue;
    const name = match[1].trim();
    if (!name || Object.prototype.hasOwnProperty.call(process.env, name)) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === "\"" || quote === "'") && value[value.length - 1] === quote) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    process.env[name] = value;
  }
}

loadEnvFile(path.join(ROOT_DIR, ".env"));

function expandHome(p, home = HOME) {
  if (!p || !String(p).startsWith("~")) return p;
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}

function resolveAppPath(value, baseDir = ROOT_DIR, home = HOME) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const expanded = expandHome(raw, home);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDir, expanded);
}

function envString(name, fallback = null, env = process.env) {
  if (!Object.prototype.hasOwnProperty.call(env, name)) return fallback;
  const value = String(env[name] || "").trim();
  return value.length === 0 ? null : value;
}

function envPath(name, fallback = null, env = process.env) {
  const value = envString(name, fallback, env);
  return value ? resolveAppPath(value) : null;
}

function envCsv(name, fallback, env = process.env) {
  const value = envString(name, fallback, env);
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function envToBool(value, fallback) {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function envFlag(name, defaultValue) {
  if (Object.prototype.hasOwnProperty.call(process.env, name)) {
    const value = String(process.env[name] || "").trim();
    return value.length === 0 ? null : value;
  }
  return defaultValue;
}

function parseIntEnv(name, fallback, env = process.env) {
  const raw = envString(name, null, env);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function parseArgList(value, defaultValue) {
  if (value === undefined) return [...defaultValue];
  if (!String(value).trim()) return [];
  const tokens = String(value).match(/(?:[^\s\"]+|"[^"]*")+/g);
  if (!tokens) return [];
  return tokens.map((token) => token.replace(/^(".*")$/, (m) => m.slice(1, -1)));
}

function resolveExecutable(cmd) {
  if (!cmd || cmd.includes("/") || cmd.includes("\\")) return null;
  const pathExt = process.platform === "win32"
    ? (process.env.PATHEXT ? process.env.PATHEXT.split(";") : [".EXE", ".CMD", ".BAT", ".COM"])
    : [""];
  const searchDirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of searchDirs) {
    if (!dir) continue;
    for (const ext of pathExt) {
      const candidate = path.join(dir, ext ? cmd + ext : cmd);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        const stat = fs.statSync(candidate);
        if (stat.isFile() || stat.isSymbolicLink()) return candidate;
      } catch {}
    }
  }
  return null;
}

function resolvePathCandidate(candidate) {
  const resolvedPath = resolveAppPath(candidate);
  if (!resolvedPath) return null;
  try {
    fs.accessSync(resolvedPath, fs.constants.X_OK);
    const stat = fs.statSync(resolvedPath);
    if (stat.isFile() || stat.isSymbolicLink()) return resolvedPath;
  } catch {}
  return null;
}

function resolveHarnessBin() {
  const pathCandidates = [
    process.env.HARNESS_BIN,
    process.env.OH_MY_PI_BIN,
    path.join(HOME, ".local/bin/oh-my-pi"),
    path.join(HOME, ".bun/bin/oh-my-pi"),
    path.join(HOME, ".bun/bin/omp"),
    path.join(HOME, ".local/bin/omp"),
    path.join(HOME, ".local/bin/claude"),
  ];

  for (const candidate of pathCandidates) {
    const resolved = resolvePathCandidate(candidate);
    if (resolved) return resolved;
  }

  for (const candidate of [process.env.HARNESS_BIN, process.env.OH_MY_PI_BIN]) {
    const resolved = resolveExecutable(candidate);
    if (resolved) return resolved;
  }

  for (const candidate of ["oh-my-pi", "omp", "claude"]) {
    const resolved = resolveExecutable(candidate);
    if (resolved) return resolved;
  }

  return "omp";
}

const PORT = parseIntEnv("PORT", 3978);
const BIND_HOST = envString("APP_BIND_HOST", "127.0.0.1");
const CHANNELS_FILE = path.join(ROOT_DIR, "config/channels.json");
const POLL_INTERVAL = parseIntEnv("POLL_INTERVAL", 5000);
const MAX_CONCURRENT_AGENTS = parseIntEnv("MAX_AGENTS", 3);
const AGENT_TIMEOUT_MS = parseIntEnv("AGENT_TIMEOUT", 3600000);
const THREAD_TTL_MS = parseIntEnv("THREAD_TTL", 7 * 24 * 60 * 60 * 1000);

const STATE_DIR = envPath("APP_STATE_DIR", ROOT_DIR);
const LOG_DIR = envPath("APP_LOG_DIR", path.join(ROOT_DIR, "logs"));
const SECRETS_DIR = envPath("APP_SECRETS_DIR", path.join(ROOT_DIR, "secrets"));
for (const dir of [STATE_DIR, LOG_DIR]) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}

const DEFAULT_TEAMS_SCRIPTS_DIR = path.join(HOME, ".claude/skills/m365-teams/scripts");
const SCRIPTS_DIR = resolveAppPath(
  envString("TEAMS_SCRIPTS_DIR", null) ||
  envString("TEAMS_SCRIPT_DIR", null) ||
  DEFAULT_TEAMS_SCRIPTS_DIR
);
const REPLY_SCRIPT = envPath("TEAMS_REPLY_SCRIPT", path.join(ROOT_DIR, "scripts/teams/reply.py"));

function teamsScriptPath(scriptName) {
  return path.join(SCRIPTS_DIR, scriptName);
}
const HARNESS_BIN = resolveHarnessBin();
const DEFAULT_BASE_ARGS = ["--print"];
const HARNESS_BASE_ARGS = Object.freeze(parseArgList(process.env.HARNESS_BASE_ARGS, DEFAULT_BASE_ARGS));
const HARNESS_FLAGS = {
  prompt: envFlag("HARNESS_PROMPT_FLAG", "-p"),
  sessionId: envFlag("HARNESS_SESSION_FLAG", "--session-id"),
  sessionDir: envFlag("HARNESS_SESSION_DIR_FLAG", "--session-dir"),
  resume: envFlag("HARNESS_RESUME_FLAG", "--resume"),
  appendSystemPrompt: envFlag("HARNESS_SYSTEM_PROMPT_FLAG", "--append-system-prompt"),
  skipPermissions: envFlag("HARNESS_SKIP_PERMISSIONS_FLAG", "--dangerously-skip-permissions"),
  mcpConfig: envFlag("HARNESS_MCP_FLAG", "--mcp-config"),
  addDir: envFlag("HARNESS_ADD_DIR_FLAG", "--add-dir"),
  model: envFlag("HARNESS_MODEL_FLAG", "--model"),
  listModels: envFlag("HARNESS_LIST_MODELS_FLAG", "--list-models"),
};

const AGENT_PREFIX = envString("AGENT_PREFIX", "!agent") || "!agent";
const HARNESS_DEFAULT_MODEL = envString("HARNESS_DEFAULT_MODEL", null);
const ALOLA_HARNESS_DEFAULT_MODEL = envString("ALOLA_HARNESS_DEFAULT_MODEL", HARNESS_DEFAULT_MODEL);

const HARNESS_CONFIG = {
  bin: HARNESS_BIN,
  baseArgs: HARNESS_BASE_ARGS,
  flags: HARNESS_FLAGS,
  appendSystemPrompt: envToBool(process.env.HARNESS_APPEND_SYSTEM_PROMPT, true),
  skipPermissions: envToBool(process.env.HARNESS_SKIP_PERMISSIONS, true),
  defaultModel: HARNESS_DEFAULT_MODEL,
  alolaDefaultModel: ALOLA_HARNESS_DEFAULT_MODEL,
};

function normalizedSecretName(name) {
  return String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function secretFileCandidates(name, options = {}) {
  const env = options.env || process.env;
  const normalized = normalizedSecretName(name);
  const candidates = [];
  const envFile = envString(`${name}_FILE`, null, env);
  if (envFile) candidates.push({ path: resolveAppPath(envFile), source: `${name}_FILE`, required: true });
  const dockerSecretsDir = options.dockerSecretsDir || "/run/secrets";
  if (dockerSecretsDir) candidates.push({ path: path.join(dockerSecretsDir, normalized), source: "docker-secret", required: false });
  const appSecretsDir = options.secretsDir === undefined ? SECRETS_DIR : options.secretsDir;
  if (appSecretsDir) candidates.push({ path: path.join(appSecretsDir, normalized), source: "app-secrets-dir", required: false });
  return candidates;
}

function readableFile(filePath) {
  if (!filePath) return false;
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveSecretValue(name, options = {}) {
  const env = options.env || process.env;
  for (const candidate of secretFileCandidates(name, options)) {
    if (readableFile(candidate.path)) {
      return fs.readFileSync(candidate.path, "utf8").trim();
    }
    if (candidate.required) {
      throw new Error(`${candidate.source} points to unreadable secret file: ${candidate.path}`);
    }
  }
  return options.directEnv === false ? null : envString(name, null, env);
}

function resolveSecretPath(name, options = {}) {
  const env = options.env || process.env;
  for (const candidate of secretFileCandidates(name, options)) {
    if (readableFile(candidate.path)) return candidate.path;
    if (candidate.required) {
      if (options.allowMissingFile) return candidate.path;
      throw new Error(`${candidate.source} points to unreadable secret file: ${candidate.path}`);
    }
  }
  const direct = envString(name, null, env);
  return direct ? resolveAppPath(direct) : null;
}

function redactSecrets(value, env = process.env) {
  let out = String(value || "");
  const replacements = new Set();
  for (const [name, raw] of Object.entries(env)) {
    if (!raw) continue;
    if (/(TOKEN|SECRET|KEY|PASSWORD|CLIENT_ID|TENANT_ID)/i.test(name)) replacements.add(String(raw));
    if (name.endsWith("_FILE")) replacements.add(resolveAppPath(String(raw)) || String(raw));
  }
  if (SECRETS_DIR) replacements.add(SECRETS_DIR);
  replacements.add("/run/secrets");
  for (const secret of replacements) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

const DEPLOYMENT_HOST = envString("DEPLOYMENT_HOST", os.hostname());
const AGENT_RUNTIME_HOST = envString("AGENT_RUNTIME_HOST", DEPLOYMENT_HOST);
const ALOLA_CONFIG = {
  user: envString("ALOLA_USER", "remote-user"),
  loginNodes: Object.freeze(envCsv("ALOLA_LOGIN_NODES", "01")),
  defaultLoginNode: envString("ALOLA_DEFAULT_LOGIN_NODE", "01"),
  defaultAsic: envString("ALOLA_DEFAULT_ASIC", "gfx000"),
  defaultLoginContainer: envString("ALOLA_DEFAULT_LOGIN_CONTAINER", "remote-session"),
  imageTemplate: envString("ALOLA_IMAGE_TEMPLATE", "remote_image_{asic}.sqsh"),
  defaultConstraintPrefix: envString("ALOLA_DEFAULT_CONSTRAINT_PREFIX", null),
  defaultGpuTimeout: envString("ALOLA_DEFAULT_GPU_TIMEOUT", "08:00:00"),
  sshKey: resolveSecretPath("ALOLA_SSH_KEY", { allowMissingFile: true }),
  sshOptions: envString("ALOLA_SSH_OPTIONS", "-o BatchMode=yes -o StrictHostKeyChecking=yes"),
  sshHostTemplate: envString("ALOLA_SSH_HOST_TEMPLATE", "login-{node}"),
  stateFile: envPath("ALOLA_STATE_FILE", path.join(STATE_DIR, "alola-sessions.json")),
  gpuPartition: envString("ALOLA_GPU_PARTITION", "defq"),
  gpuCpusPerTask: parseIntEnv("ALOLA_GPU_CPUS_PER_TASK", 16),
  remoteHomeMount: envString("ALOLA_REMOTE_HOME_MOUNT", "/home/remote:/home/remote"),
  sshTimeoutMs: parseIntEnv("ALOLA_SSH_TIMEOUT_MS", 30000),
  startTimeoutMs: parseIntEnv("ALOLA_START_TIMEOUT_MS", 60000),
  commandTimeoutMs: parseIntEnv("ALOLA_COMMAND_TIMEOUT_MS", 1800000),
};

const ALOLA_SESSION_BIN = envPath("ALOLA_SESSION_BIN", path.join(ROOT_DIR, "bin/alola-session"));
const MCP_CONFIG = envPath("MCP_CONFIG", path.join(ROOT_DIR, "mcp/mcp-servers.json"));
function defaultRunnerAllowedRoots(env = process.env) {
  const roots = [];
  const workspaceDir = envString("APP_WORKSPACE_DIR", null, env);
  if (workspaceDir) roots.push(workspaceDir);
  roots.push(ROOT_DIR);
  return roots;
}

function resolveRunnerAllowedRoots(env = process.env) {
  const configured = envCsv("AGENT_RUNNER_ALLOWED_ROOTS", "", env);
  const rawRoots = configured.length ? configured : defaultRunnerAllowedRoots(env);
  const home = env.HOME || HOME;
  const roots = [];
  for (const root of rawRoots) {
    const resolved = resolveAppPath(root, ROOT_DIR, home);
    if (resolved && !roots.includes(resolved)) roots.push(resolved);
  }
  return roots;
}

function buildRunnerConfig(env = process.env) {
  return {
    url: envString("AGENT_RUNNER_URL", null, env),
    bindHost: envString("AGENT_RUNNER_BIND_HOST", "127.0.0.1", env),
    port: parseIntEnv("AGENT_RUNNER_PORT", 3979, env),
    token: resolveSecretValue("AGENT_RUNNER_TOKEN", { env }),
    allowedRoots: Object.freeze(resolveRunnerAllowedRoots(env)),
  };
}

const RUNNER_CONFIG = Object.freeze(buildRunnerConfig());

const CONFIG_CHANNELS_FILE = CHANNELS_FILE;

function isAccessibleDirectory(dir) {
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK);
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function workspaceIdForDir(dir) {
  const resolved = path.resolve(dir || HOME);
  const base = (path.basename(resolved) || "workspace").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return `${base}-${hash}`;
}

function workspaceObject(dir, source) {
  const resolved = path.resolve(dir);
  return Object.freeze({ id: workspaceIdForDir(resolved), dir: resolved, source });
}

function assertWorkspaceDirectory(dir, source, channelLabel) {
  if (!isAccessibleDirectory(dir)) {
    const label = channelLabel ? ` for ${channelLabel}` : "";
    throw new Error(`Configured workspace${label} is not a readable directory: ${dir}`);
  }
}

function resolveWorkspace(channel = null, options = {}) {
  const env = options.env || process.env;
  const rootDir = options.rootDir || ROOT_DIR;
  const home = options.home || env.HOME || HOME;
  const label = channel?.label || channel?.chatId || null;
  const rawChannelWorkspace = channel && typeof channel.workspace === "string" && channel.workspace.trim()
    ? channel.workspace
    : null;

  if (rawChannelWorkspace) {
    const dir = resolveAppPath(rawChannelWorkspace, rootDir, home);
    assertWorkspaceDirectory(dir, "channel", label);
    return workspaceObject(dir, "channel");
  }

  const envWorkspace = envString("APP_WORKSPACE_DIR", null, env);
  if (envWorkspace) {
    const dir = resolveAppPath(envWorkspace, rootDir, home);
    assertWorkspaceDirectory(dir, "env", label);
    return workspaceObject(dir, "env");
  }


  const fallbackHome = path.resolve(home || os.homedir());
  assertWorkspaceDirectory(fallbackHome, "home", label);
  return workspaceObject(fallbackHome, "home");
}

function workspaceFromPersisted(id, dir, source = "persisted") {
  if (!dir) return resolveWorkspace();
  const resolved = path.resolve(dir);
  return Object.freeze({ id: id || workspaceIdForDir(resolved), dir: resolved, source });
}

function attachWorkspace(target, workspace) {
  const ws = workspace || resolveWorkspace();
  target.workspaceId = ws.id;
  target.workspaceDir = ws.dir;
  target.workspaceSource = ws.source;
  return target;
}

function channelMaxConcurrentAgents(channel) {
  const value = channel?.maxConcurrentAgents;
  return Number.isInteger(value) && value > 0 ? value : MAX_CONCURRENT_AGENTS;
}

function channelDefaultModel(channel) {
  return channel?.defaultModel || HARNESS_CONFIG.defaultModel || null;
}

function channelAlolaDefaultModel(channel) {
  return channel?.alolaDefaultModel || HARNESS_CONFIG.alolaDefaultModel || channelDefaultModel(channel);
}

function resolveChannelsFile() {
  return { path: CHANNELS_FILE, explicit: true };
}

function normalizeChannel(raw, index, sourceFile) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${sourceFile}: channel #${index + 1} must be an object`);
  }
  const chatId = typeof raw.chatId === "string" ? raw.chatId.trim() : "";
  if (!chatId) throw new Error(`${sourceFile}: channel #${index + 1} is missing required string chatId`);

  function optionalString(field) {
    if (raw[field] === undefined || raw[field] === null || raw[field] === "") return null;
    if (typeof raw[field] !== "string") throw new Error(`${sourceFile}: channel ${chatId} field ${field} must be a string`);
    return raw[field].trim() || null;
  }

  let maxConcurrentAgents = null;
  if (raw.maxConcurrentAgents !== undefined && raw.maxConcurrentAgents !== null) {
    if (!Number.isInteger(raw.maxConcurrentAgents) || raw.maxConcurrentAgents <= 0) {
      throw new Error(`${sourceFile}: channel ${chatId} field maxConcurrentAgents must be a positive integer`);
    }
    maxConcurrentAgents = raw.maxConcurrentAgents;
  }

  let prefix = AGENT_PREFIX;
  if (raw.prefix !== undefined) {
    if (raw.prefix === null || raw.prefix === "") {
      prefix = null;
    } else if (typeof raw.prefix === "string") {
      prefix = raw.prefix;
    } else {
      throw new Error(`${sourceFile}: channel ${chatId} field prefix must be a string or null`);
    }
  }

  return {
    chatId,
    label: optionalString("label") || chatId,
    prefix,
    defaultModel: optionalString("defaultModel"),
    alolaDefaultModel: optionalString("alolaDefaultModel"),
    workspace: optionalString("workspace"),
    maxConcurrentAgents,
  };
}

function validateChannels(raw, sourceFile = "channels") {
  if (!Array.isArray(raw)) throw new Error(`${sourceFile}: expected a JSON array of channels`);
  const seen = new Set();
  return raw.map((entry, index) => {
    const channel = normalizeChannel(entry, index, sourceFile);
    if (seen.has(channel.chatId)) throw new Error(`${sourceFile}: duplicate chatId ${channel.chatId}`);
    seen.add(channel.chatId);
    return channel;
  });
}

let channelsData = null;

function loadChannels(options = {}) {
  if (channelsData && !options.reload) return channelsData;
  const selected = options.file
    ? { path: resolveAppPath(options.file), explicit: true }
    : resolveChannelsFile();
  if (!fs.existsSync(selected.path)) {
    throw new Error(`Channel config file does not exist: ${selected.path}. Create config/channels.json from config/channels.example.json.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(selected.path, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse ${selected.path}: ${err.message}`);
  }
  channelsData = validateChannels(parsed, selected.path);
  return channelsData;
}

function resetChannelsForTests() {
  channelsData = null;
}

const registryCache = new Map();
function loadWorkspaceRegistry(workspace, fileName) {
  const ws = workspace || resolveWorkspace();
  const registryPath = path.join(ws.dir, ".claude/registry", fileName);
  if (!fs.existsSync(registryPath)) return null;
  const key = `${registryPath}:${fs.statSync(registryPath).mtimeMs}`;
  if (!registryCache.has(key)) {
    registryCache.set(key, JSON.parse(fs.readFileSync(registryPath, "utf8")));
  }
  return registryCache.get(key);
}

function loadProjects(workspace = null) {
  return loadWorkspaceRegistry(workspace, "projects.json");
}

function loadMachines(workspace = null) {
  return loadWorkspaceRegistry(workspace, "machines.json");
}

const HARNESS_SECRET_ENV = Object.freeze(envCsv(
  "HARNESS_SECRET_ENV",
  "OPENAI_API_KEY,ANTHROPIC_API_KEY,GOOGLE_API_KEY,GEMINI_API_KEY,MISTRAL_API_KEY,COHERE_API_KEY,OPENROUTER_API_KEY,AZURE_OPENAI_API_KEY,LLM_GATEWAY_API_KEY,LLM_API_KEY,PI_API_KEY,PI_OPENAI_API_KEY,PI_ANTHROPIC_API_KEY,AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY,AWS_SESSION_TOKEN"
));
const HARNESS_VALUE_ENV = Object.freeze(envCsv(
  "HARNESS_VALUE_ENV",
  "OPENAI_BASE_URL,ANTHROPIC_BASE_URL,AZURE_OPENAI_ENDPOINT,AZURE_OPENAI_API_VERSION,LLM_GATEWAY_URL,PI_GATEWAY_URL,PI_PROVIDER_BASE_URL,PI_STREAM_FIRST_EVENT_TIMEOUT_MS,PI_STREAM_IDLE_TIMEOUT_MS"
));
const SAFE_HARNESS_ENV = Object.freeze(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "NO_COLOR", "FORCE_COLOR", "CI"]);
const ALOLA_ENV_KEYS = Object.freeze([
  "ALOLA_USER",
  "ALOLA_LOGIN_NODES",
  "ALOLA_DEFAULT_LOGIN_NODE",
  "ALOLA_DEFAULT_ASIC",
  "ALOLA_DEFAULT_LOGIN_CONTAINER",
  "ALOLA_IMAGE_TEMPLATE",
  "ALOLA_DEFAULT_CONSTRAINT_PREFIX",
  "ALOLA_DEFAULT_GPU_TIMEOUT",
  "ALOLA_SSH_HOST_TEMPLATE",
  "ALOLA_SSH_OPTIONS",
  "ALOLA_STATE_FILE",
  "ALOLA_GPU_PARTITION",
  "ALOLA_GPU_CPUS_PER_TASK",
  "ALOLA_REMOTE_HOME_MOUNT",
  "ALOLA_SSH_TIMEOUT_MS",
  "ALOLA_START_TIMEOUT_MS",
  "ALOLA_COMMAND_TIMEOUT_MS",
]);

function copyEnvNames(out, names, env = process.env) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined) out[name] = String(env[name]);
  }
}

function safeHarnessThreadId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(id) ? id : null;
}

function buildHarnessEnv(options = {}) {
  const source = options.env || process.env;
  const out = {};
  copyEnvNames(out, SAFE_HARNESS_ENV, source);
  copyEnvNames(out, HARNESS_VALUE_ENV, source);
  copyEnvNames(out, envCsv("HARNESS_ENV_PASSTHROUGH", "", source), source);

  for (const name of HARNESS_SECRET_ENV) {
    const value = resolveSecretValue(name, { env: source });
    if (value) out[name] = value;
  }


  if (options.includeAlola) {
    copyEnvNames(out, ALOLA_ENV_KEYS, source);
    out.ALOLA_SESSION_BIN = ALOLA_SESSION_BIN;
    const threadId = safeHarnessThreadId(options.alolaThreadId);
    if (threadId) out.ALOLA_THREAD_ID = threadId;
    if (ALOLA_CONFIG.sshKey) out.ALOLA_SSH_KEY = ALOLA_CONFIG.sshKey;
  }

  return out;
}

module.exports = {
  PORT,
  BIND_HOST,
  CHANNELS_FILE,
  POLL_INTERVAL,
  AGENT_PREFIX,
  MAX_CONCURRENT_AGENTS,
  AGENT_TIMEOUT_MS,
  THREAD_TTL_MS,
  ROOT_DIR,
  HOME,
  STATE_DIR,
  LOG_DIR,
  SECRETS_DIR,
  SCRIPTS_DIR,
  REPLY_SCRIPT,
  teamsScriptPath,
  HARNESS_BIN,
  HARNESS_CONFIG,
  HARNESS_SECRET_ENV,
  HARNESS_VALUE_ENV,
  RUNNER_CONFIG,
  MCP_CONFIG,
  DEPLOYMENT_HOST,
  AGENT_RUNTIME_HOST,
  ALOLA_CONFIG,
  ALOLA_SESSION_BIN,
  CONFIG_CHANNELS_FILE,
  resolveChannelsFile,
  validateChannels,
  loadChannels,
  resetChannelsForTests,
  resolveWorkspace,
  workspaceFromPersisted,
  workspaceIdForDir,
  attachWorkspace,
  channelMaxConcurrentAgents,
  channelDefaultModel,
  channelAlolaDefaultModel,
  loadProjects,
  loadMachines,
  resolveSecretValue,
  resolveSecretPath,
  normalizedSecretName,
  redactSecrets,
  buildHarnessEnv,
  buildRunnerConfig,
  resolveRunnerAllowedRoots,
  safeHarnessThreadId,
  envString,
  envPath,
  expandHome,
  resolveAppPath,
  resolveExecutable,
};
