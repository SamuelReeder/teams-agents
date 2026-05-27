#!/usr/bin/env node
const {
  AlolaSessionManager,
  parseAlolaTarget,
  buildSessionMetadata,
  coerceAlolaMetadata,
  describeAlolaTarget,
  buildAttachCommand,
} = require("../lib/alola-session");

function maybePushTarget(tokens, token) {
  if (token.toLowerCase() !== "default") tokens.push(token);
}

function maybeUnshiftTarget(tokens, token) {
  if (token.toLowerCase() !== "default") tokens.unshift(token);
}

function looksLikeTargetContinuation(token) {
  return /^gfx[0-9][0-9a-z]*$/i.test(token) || /^gpu:/i.test(token);
}

function usage() {
  return `Usage:
  alola-session run [--target <target>] [--thread <id>] [--timeout-ms <ms>] -- <command>
  alola-session start [--target <target>] [--thread <id>]
  alola-session status [--target <target>] [--thread <id>]
  alola-session stop [--target <target>] [--thread <id>]
  alola-session attach [--target <target>] [--thread <id>]

Targets:
  default          login node 03, gfx90a enroot session
  04               login node 04, gfx90a enroot session
  gfx942           non-exclusive GPU allocation for gfx942 via login node 03
  03 gfx950        non-exclusive GPU allocation for gfx950 via login node 03
  gpu:gfx90a       force a compute-node allocation for gfx90a
`;
}

function parseArgs(argv) {
  const command = argv[2] || "help";
  const opts = { target: [], thread: "manual", timeoutMs: null, command: "" };
  let i = 3;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--") {
      opts.command = argv.slice(i + 1).join(" ");
      break;
    }
    if (arg === "--target" || arg === "-t") {
      i += 1;
      if (i >= argv.length) throw new Error("--target requires a value");
      maybePushTarget(opts.target, argv[i]);
      i += 1;
      if (i < argv.length && looksLikeTargetContinuation(argv[i])) {
        maybePushTarget(opts.target, argv[i]);
        i += 1;
      }
      continue;
    }
    if (arg === "--node") {
      i += 1;
      if (i >= argv.length) throw new Error("--node requires a value");
      maybeUnshiftTarget(opts.target, argv[i]);
      i += 1;
      continue;
    }
    if (arg === "--asic") {
      i += 1;
      if (i >= argv.length) throw new Error("--asic requires a value");
      maybePushTarget(opts.target, argv[i]);
      i += 1;
      continue;
    }
    if (arg === "--thread") {
      i += 1;
      if (i >= argv.length) throw new Error("--thread requires a value");
      opts.thread = argv[i];
      i += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      i += 1;
      if (i >= argv.length) throw new Error("--timeout-ms requires a value");
      opts.timeoutMs = parseInt(argv[i], 10);
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { command: "help", opts };
    }
    if ((command === "run" || command === "exec") && !arg.startsWith("--")) {
      opts.command = argv.slice(i).join(" ");
      break;
    }
    throw new Error(`Unknown argument '${arg}'`);
  }
  return { command, opts };
}

async function main() {
  const { command, opts } = parseArgs(process.argv);
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }

  const target = parseAlolaTarget(opts.target);
  const metadata = buildSessionMetadata({ rootMessageId: opts.thread, sessionId: opts.thread }, target);
  const manager = new AlolaSessionManager();

  if (command === "start") {
    manager.ensureSession(metadata);
    process.stdout.write(`${describeAlolaTarget(metadata)}\n`);
    return;
  }

  if (command === "status") {
    const status = manager.status(metadata);
    process.stdout.write(JSON.stringify({ ...coerceAlolaMetadata(metadata), status, attach: buildAttachCommand(metadata) }, null, 2) + "\n");
    return;
  }

  if (command === "stop") {
    manager.stop(metadata);
    process.stdout.write(`Stopped ${describeAlolaTarget(metadata)}\n`);
    return;
  }

  if (command === "attach") {
    process.stdout.write(`${buildAttachCommand(metadata)}\n`);
    return;
  }

  if (command !== "run" && command !== "exec") {
    throw new Error(`Unknown command '${command}'`);
  }
  if (!opts.command) throw new Error("run requires a command after --");

  const result = await manager.runCommand(metadata, opts.command, { timeoutMs: opts.timeoutMs || undefined });
  if (result.output) process.stdout.write(result.output.endsWith("\n") ? result.output : result.output + "\n");
  process.exitCode = result.rc || 0;
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
