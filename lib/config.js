const path = require("path");
const fs = require("fs");
const os = require("os");

const HOME = process.env.HOME || os.homedir();

const envFilePath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFilePath)) {
  for (const line of fs.readFileSync(envFilePath, "utf8").split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

function expandHome(p) {
  if (!p || !p.startsWith("~")) return p;
  return path.join(HOME, p.slice(1));
}

function parseArgList(value, defaultValue) {
  if (value === undefined) return [...defaultValue];
  if (!value.trim()) return [];
  const tokens = value.match(/(?:[^\s\"]+|"[^"]*")+/g);
  if (!tokens) return [];
  return tokens.map((token) => token.replace(/^"(.*)"$/, "$1"));
}

function envToBool(value, fallback) {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function envFlag(name, defaultValue) {
  if (Object.prototype.hasOwnProperty.call(process.env, name)) {
    const value = process.env[name].trim();
    return value.length === 0 ? null : value;
  }
  return defaultValue;
}

function resolveExecutable(cmd) {
  if (!cmd || cmd.includes("/") || cmd.includes("\\")) return null;
  const pathExt =
    process.platform === "win32"
      ? process.env.PATHEXT
        ? process.env.PATHEXT.split(";")
        : [".EXE", ".CMD", ".BAT", ".COM"]
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
  if (!candidate) return null;
  const expanded = expandHome(candidate);
  if (!path.isAbsolute(expanded)) return null;
  try {
    fs.accessSync(expanded, fs.constants.X_OK);
    const stat = fs.statSync(expanded);
    if (stat.isFile() || stat.isSymbolicLink()) return expanded;
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

  const commandCandidates = ["oh-my-pi", "omp", "claude"];
  for (const candidate of commandCandidates) {
    const resolved = resolveExecutable(candidate);
    if (resolved) return resolved;
  }

  return "omp";
}

const PORT = parseInt(process.env.PORT || "3978", 10);
const CHAT_ID = process.env.TEAMS_CHAT_ID;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "5000", 10);
const MAX_CONCURRENT_AGENTS = parseInt(process.env.MAX_AGENTS || "3", 10);
const AGENT_TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT || "3600000", 10);
const THREAD_TTL_MS = parseInt(process.env.THREAD_TTL || String(7 * 24 * 60 * 60 * 1000), 10);

const ROOT_DIR = path.join(__dirname, "..");
function envPath(name, fallback = null) {
  const value = Object.prototype.hasOwnProperty.call(process.env, name)
    ? process.env[name].trim()
    : fallback;
  if (!value) return null;
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? expanded : path.resolve(ROOT_DIR, expanded);
}

const STATE_DIR = envPath("APP_STATE_DIR", ROOT_DIR);
const LOG_DIR = envPath("APP_LOG_DIR", path.join(ROOT_DIR, "logs"));
const SECRETS_DIR = envPath("APP_SECRETS_DIR", path.join(ROOT_DIR, "secrets"));
for (const dir of [STATE_DIR, LOG_DIR]) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}

const WORKSPACE_DIR = path.join(ROOT_DIR, "workspace");
const SCRIPTS_DIR = path.join(HOME, ".claude/skills/m365-teams/scripts");
const REPLY_SCRIPT = path.join(ROOT_DIR, "reply.py");
const HARNESS_BIN = resolveHarnessBin();
const DEFAULT_BASE_ARGS = ["--print"];
const HARNESS_BASE_ARGS = Object.freeze(parseArgList(process.env.HARNESS_BASE_ARGS, DEFAULT_BASE_ARGS));
const HARNESS_FLAGS = {
  prompt: envFlag("HARNESS_PROMPT_FLAG", "-p"),
  sessionId: envFlag("HARNESS_SESSION_FLAG", "--session-id"),
  sessionDir: envFlag("HARNESS_SESSION_DIR_FLAG", "--session-dir"),
  resume: envFlag("HARNESS_RESUME_FLAG", "--resume"),
  appendSystemPrompt: envFlag("HARNESS_SYSTEM_PROMPT_FLAG", "--append-system-prompt"),
  appendSystemPromptFile: envFlag("HARNESS_SYSTEM_PROMPT_FILE_FLAG", "--append-system-prompt-file"),
  skipPermissions: envFlag("HARNESS_SKIP_PERMISSIONS_FLAG", "--dangerously-skip-permissions"),
  mcpConfig: envFlag("HARNESS_MCP_FLAG", "--mcp-config"),
  addDir: envFlag("HARNESS_ADD_DIR_FLAG", "--add-dir"),
  model: envFlag("HARNESS_MODEL_FLAG", "--model"),
};

function envString(name, fallback = null) {
  if (!Object.prototype.hasOwnProperty.call(process.env, name)) return fallback;
  const value = process.env[name].trim();
  return value.length === 0 ? null : value;
}
function envCsv(name, fallback) {
  const value = envString(name, fallback);
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
const AGENT_PREFIX = envString("AGENT_PREFIX", "!agent") || "!agent";


const HARNESS_DEFAULT_MODEL = envString("HARNESS_DEFAULT_MODEL", null);
const ALOLA_HARNESS_DEFAULT_MODEL = envString(
  "ALOLA_HARNESS_DEFAULT_MODEL",
  HARNESS_DEFAULT_MODEL
);

const HARNESS_CONFIG = {
  bin: HARNESS_BIN,
  baseArgs: HARNESS_BASE_ARGS,
  flags: HARNESS_FLAGS,
  appendSystemPrompt: envToBool(process.env.HARNESS_APPEND_SYSTEM_PROMPT, true),
  skipPermissions: envToBool(process.env.HARNESS_SKIP_PERMISSIONS, true),
  defaultModel: HARNESS_DEFAULT_MODEL,
  alolaDefaultModel: ALOLA_HARNESS_DEFAULT_MODEL,
};

const DEPLOYMENT_HOST = envString("DEPLOYMENT_HOST", os.hostname());
const AGENT_RUNTIME_HOST = envString("AGENT_RUNTIME_HOST", DEPLOYMENT_HOST);
const ALOLA_CONFIG = {
  user: envString("ALOLA_USER", "sareeder"),
  loginNodes: Object.freeze(envCsv("ALOLA_LOGIN_NODES", "03,04")),
  defaultLoginNode: envString("ALOLA_DEFAULT_LOGIN_NODE", "03"),
  defaultAsic: envString("ALOLA_DEFAULT_ASIC", "gfx90a"),
  defaultLoginContainer: envString("ALOLA_DEFAULT_LOGIN_CONTAINER", "sareeder-latest_container"),
  imageTemplate: envString("ALOLA_IMAGE_TEMPLATE", "/cluster/images/hipdnn/hipdnn_latest_{asic}.sqsh"),
  defaultConstraintPrefix: envString("ALOLA_DEFAULT_CONSTRAINT_PREFIX", "MARKHAM"),
  defaultGpuTimeout: envString("ALOLA_DEFAULT_GPU_TIMEOUT", "08:00:00"),
  sshKey: envPath("ALOLA_SSH_KEY", null),
  sshOptions: envString("ALOLA_SSH_OPTIONS", "-o BatchMode=yes -o StrictHostKeyChecking=yes"),
  stateFile: envPath("ALOLA_STATE_FILE", path.join(STATE_DIR, "alola-sessions.json")),
  gpuPartition: envString("ALOLA_GPU_PARTITION", "defq"),
  gpuCpusPerTask: parseInt(process.env.ALOLA_GPU_CPUS_PER_TASK || "16", 10),
  remoteHomeMount: envString("ALOLA_REMOTE_HOME_MOUNT", "/home/AMD/sareeder:/home/AMD/sareeder"),
  sshTimeoutMs: parseInt(process.env.ALOLA_SSH_TIMEOUT_MS || "30000", 10),
  startTimeoutMs: parseInt(process.env.ALOLA_START_TIMEOUT_MS || "60000", 10),
  commandTimeoutMs: parseInt(process.env.ALOLA_COMMAND_TIMEOUT_MS || "1800000", 10),
};

const MCP_CONFIG = path.join(ROOT_DIR, "mcp/mcp-servers.json");
const CHANNELS_FILE = path.join(ROOT_DIR, "channels.json");

let channelsData = null;

function loadChannels() {
  if (channelsData) return channelsData;
  if (fs.existsSync(CHANNELS_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8"));
      channelsData = raw.map((ch) => ({
        chatId: ch.chatId,
        label: ch.label || ch.chatId,
        prefix: AGENT_PREFIX,
        defaultModel: ch.defaultModel || null,
        alolaDefaultModel: ch.alolaDefaultModel || null,
        workspace: ch.workspace || null,
        maxConcurrentAgents: ch.maxConcurrentAgents || null,
      }));
      return channelsData;
    } catch {}
  }
  if (CHAT_ID) {
    channelsData = [{ chatId: CHAT_ID, label: "Default", prefix: AGENT_PREFIX, defaultModel: null, alolaDefaultModel: null, workspace: null, maxConcurrentAgents: null }];
    return channelsData;
  }
  return [];
}

const PROJECTS_PATH = path.join(WORKSPACE_DIR, ".claude/registry/projects.json");
const MACHINES_PATH = path.join(WORKSPACE_DIR, ".claude/registry/machines.json");

let projectsData = null;
let machinesData = null;

function loadProjects() {
  if (!projectsData && fs.existsSync(PROJECTS_PATH)) {
    projectsData = JSON.parse(fs.readFileSync(PROJECTS_PATH, "utf8"));
  }
  return projectsData;
}

function loadMachines() {
  if (!machinesData && fs.existsSync(MACHINES_PATH)) {
    machinesData = JSON.parse(fs.readFileSync(MACHINES_PATH, "utf8"));
  }
  return machinesData;
}

module.exports = {
  PORT,
  CHAT_ID,
  POLL_INTERVAL,
  AGENT_PREFIX,
  MAX_CONCURRENT_AGENTS,
  AGENT_TIMEOUT_MS,
  THREAD_TTL_MS,
  ROOT_DIR,
  STATE_DIR,
  LOG_DIR,
  SECRETS_DIR,
  WORKSPACE_DIR,
  SCRIPTS_DIR,
  REPLY_SCRIPT,
  HARNESS_BIN,
  HARNESS_CONFIG,
  MCP_CONFIG,
  DEPLOYMENT_HOST,
  AGENT_RUNTIME_HOST,
  ALOLA_CONFIG,
  loadProjects,
  loadMachines,
  loadChannels,
};
