#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const {
  ALOLA_CONFIG,
  HARNESS_BIN,
  HARNESS_SECRET_ENV,
  REPLY_SCRIPT,
  SCRIPTS_DIR,
  buildHarnessEnv,
  loadChannels,
  redactSecrets,
  resolveExecutable,
  resolveSecretPath,
  resolveSecretValue,
  resolveWorkspace,
} = require("../src/config/env");

function isReadableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    const stat = fs.statSync(filePath);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function pushError(errors, message) {
  errors.push(redactSecrets(message));
}

function pushWarning(warnings, message) {
  warnings.push(redactSecrets(message));
}

function validateHarness(errors) {
  if (!HARNESS_BIN) {
    pushError(errors, "HARNESS_BIN is empty and no harness executable was discovered");
    return;
  }
  if (HARNESS_BIN.includes("/") || HARNESS_BIN.includes("\\")) {
    if (!isExecutableFile(HARNESS_BIN)) pushError(errors, `Harness binary is not executable: ${HARNESS_BIN}`);
    return;
  }
  if (!resolveExecutable(HARNESS_BIN)) pushError(errors, `Harness command is not on PATH: ${HARNESS_BIN}`);
}

function validateTeamsScripts(errors) {
  const required = [
    path.join(SCRIPTS_DIR, "list_messages.py"),
    path.join(SCRIPTS_DIR, "send_chat.py"),
    REPLY_SCRIPT,
  ];
  for (const file of required) {
    if (!isReadableFile(file)) pushError(errors, `Teams script is not readable: ${file}`);
  }
}

function validateChannelsAndWorkspaces(errors) {
  let channels;
  try {
    channels = loadChannels({ reload: true });
  } catch (err) {
    pushError(errors, err.message);
    return [];
  }
  if (channels.length === 0) pushError(errors, "No Teams channels configured. Set TEAMS_CHAT_ID or create config/channels.json.");
  for (const channel of channels) {
    try {
      resolveWorkspace(channel);
    } catch (err) {
      pushError(errors, err.message);
    }
  }
  return channels;
}

function alolaKeyConfigured() {
  if (process.env.ALOLA_SSH_KEY || process.env.ALOLA_SSH_KEY_FILE) return true;
  if (isReadableFile(path.join("/run/secrets", "alola_ssh_key"))) return true;
  return Boolean(ALOLA_CONFIG.sshKey);
}

function validateAlolaSecrets(errors, warnings) {
  if (!alolaKeyConfigured()) {
    pushWarning(warnings, "ALOLA_SSH_KEY is not configured; Alola routing will fail until a readable key path or secret file is provided.");
    return;
  }
  let keyPath;
  try {
    keyPath = resolveSecretPath("ALOLA_SSH_KEY");
  } catch (err) {
    pushError(errors, err.message);
    return;
  }
  if (!keyPath || !isReadableFile(keyPath)) {
    pushError(errors, `ALOLA_SSH_KEY does not resolve to a readable file: ${keyPath || "(unset)"}`);
  }
}

function validateHarnessSecrets(errors) {
  for (const name of HARNESS_SECRET_ENV) {
    if (!process.env[`${name}_FILE`]) continue;
    try {
      resolveSecretValue(name);
    } catch (err) {
      pushError(errors, err.message);
    }
  }
  try {
    buildHarnessEnv({ includeAlola: false });
  } catch (err) {
    pushError(errors, err.message);
  }
}

function runCheck() {
  const errors = [];
  const warnings = [];
  validateChannelsAndWorkspaces(errors);
  validateTeamsScripts(errors);
  validateHarness(errors);
  validateAlolaSecrets(errors, warnings);
  validateHarnessSecrets(errors);
  return { ok: errors.length === 0, errors, warnings };
}

function main() {
  const checkOnly = process.argv.includes("--check") || process.argv.length <= 2;
  if (!checkOnly) {
    process.stderr.write("Usage: node scripts/setup.js --check\n");
    process.exitCode = 2;
    return;
  }
  const result = runCheck();
  for (const warning of result.warnings) process.stdout.write(`WARN: ${warning}\n`);
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`ERROR: ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Setup check passed.\n");
}

if (require.main === module) main();

module.exports = { runCheck, isReadableFile, isExecutableFile };
