const path = require("path");
const fs = require("fs");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

const PORT = parseInt(process.env.PORT || "3978", 10);
const CHAT_ID = process.env.TEAMS_CHAT_ID;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "5000", 10);
const MAX_CONCURRENT_AGENTS = parseInt(process.env.MAX_AGENTS || "3", 10);
const AGENT_TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT || "600000", 10);

const ROOT_DIR = path.join(__dirname, "..");
const WORKSPACE_DIR = path.join(ROOT_DIR, "workspace");
const SCRIPTS_DIR = path.join(process.env.HOME, ".claude/skills/m365-teams/scripts");
const REPLY_SCRIPT = path.join(ROOT_DIR, "reply.py");
const CLAUDE_BIN = path.join(process.env.HOME, ".local/bin/claude");
const MCP_CONFIG = path.join(ROOT_DIR, "mcp/mcp-servers.json");

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
  MAX_CONCURRENT_AGENTS,
  AGENT_TIMEOUT_MS,
  ROOT_DIR,
  WORKSPACE_DIR,
  SCRIPTS_DIR,
  REPLY_SCRIPT,
  CLAUDE_BIN,
  MCP_CONFIG,
  loadProjects,
  loadMachines,
};
