# HPE Agent Takeover Summary

## Purpose

This branch implements HPE-hosted Teams agents with persistent Alola sessions. The harness stays local to HPE by default. ROCm build/test/benchmark/runtime work is routed through durable Alola login-node tmux/enroot sessions or tmux-held non-exclusive GPU allocations.

The user is moving to an agent running directly on `hpe-sjc2-43`. Claude Code is already installed there, and API keys have already been handled by the user in `.bashrc`.

## Repo and branch

HPE clone path:

```bash
cd ~/teams-bot-hpe-alola-persistent-sessions-ssh
```

Branch:

```bash
hpe-alola-persistent-sessions
```

Bring the clone current:

```bash
git checkout hpe-alola-persistent-sessions
git pull --ff-only
git submodule update --init --recursive
```

Latest pushed commit observed before handoff:

```text
4b72beb Install GitHub CLI in bot image
```

Recent commits on the branch include:

```text
4b72beb Install GitHub CLI in bot image
e1165bd Run container as HPE user with home mount
1d5555b Preserve Alola shell state across commands
e92b1db Fix Alola CLI target parsing
4dbee08 Respect configured state dir in persistence tests
d3d798d Make npm test script portable
```

There are unrelated local WSL changes in `test/test-polls.js` and `test/test-threads.js` that were intentionally not staged or committed.

## Important files

### Teams bot app

- `lib/alola-session.js`
  - Session manager for Alola SSH/tmux/enroot/SLURM.
  - Parses targets: default login, login node override, ASIC GPU allocation, `gpu:gfx90a`.
  - Builds tmux names, image paths, constraints such as `MARKHAM&GFX942`.
  - Starts/reuses login sessions and GPU allocation sessions.
  - Writes command scripts to `~/.teams-agent/commands` and sends only script invocations to tmux.
  - Sources command scripts inside tmux so cwd/env persist across calls.
  - Captures with `__CMD_START_*` / `__CMD_DONE_*:<rc>` sentinels.

- `scripts/alola-session.js`
  - App-level CLI: `run`, `start`, `status`, `stop`, `attach`.

- `workspace/scripts/alola-session`
  - Workspace wrapper to call the app-level CLI.

- `lib/agent-spawn.js`
  - `--alola` no longer starts the harness remotely.
  - Harness remains local to HPE.
  - `--alola` stores target metadata and injects target-specific execution instructions.
  - Build/test/runtime prompts automatically receive Alola routing context.

- `lib/config.js`
  - Adds `ALOLA_CONFIG`, state/log/secrets dirs, deployment/runtime host metadata.

- `lib/threads.js`, `lib/polls.js`, `lib/teams-io.js`
  - Updated to respect configured state directories and persist richer Alola metadata.

### Deployment

- `Dockerfile`
  - Node 20 slim image.
  - Installs `git`, `gh`, `openssh-client`, Python, and `tini`.
  - Creates user `sareeder` with HPE UID/GID defaults `1038:1037`.
  - Runs as `sareeder`.

- `compose.yaml`
  - Builds image with `APP_USER`, `APP_UID`, `APP_GID`.
  - Mounts `/home/sareeder:/home/sareeder` so SSH/Git see the same HPE home, keys, config, and known_hosts as the HPE account.
  - Mounts persistent volumes for `/app/state` and `/app/logs`.
  - Mounts `./secrets/alola_ssh_key:/run/secrets/alola_ssh_key:ro`.
  - Does not mount the Docker socket and does not run privileged.

- `README.md`
  - Updated HPE deployment, Docker Compose, SSH key setup, Alola target syntax, session CLI, and routing behavior.

- `workspace/docs/machines/alola.md`
  - Updated for persistent HPE-controlled Alola sessions.

## HPE GitHub SSH setup

A dedicated no-passphrase service key was generated on HPE:

```bash
~/.ssh/hpe_teams_bot_ed25519
~/.ssh/hpe_teams_bot_ed25519.pub
```

The public key shown during setup was:

```text
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHjApM6cjiYHw2EEqYWAhrd260q2s6IANL6l7HbdjD2b hpe-teams-bot
```

The user said they added the non-interactive SSH key to GitHub.

HPE SSH config was updated to select that key for GitHub:

```sshconfig
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/hpe_teams_bot_ed25519
  IdentitiesOnly yes
```

Verify on HPE:

```bash
ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -T git@github.com
```

Expected successful output:

```text
Hi SamuelReeder! You've successfully authenticated, but GitHub does not provide shell access.
```

Note: GitHub normally exits with rc `1` for this test because it does not provide shell access. The important signal is the `Hi ... successfully authenticated` message, not rc `0`.

Verify in the container with mounted HPE home:

```bash
docker run --rm \
  -v "$HOME:$HOME" \
  teams-bot:hpe-alola-persistent-sessions-verify \
  sh -lc 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -T git@github.com'
```

Observed before handoff from the container:

```text
Hi SamuelReeder! You've successfully authenticated, but GitHub does not provide shell access.
```

## Alola SSH setup

HPE-local deploy key for Alola:

```bash
~/teams-bot-hpe-alola-persistent-sessions-ssh/secrets/alola_ssh_key
```

Public key:

```text
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPcEo9PL7sHInyujYVb3jRHFZwwctC8YK97WMoHMU38y teams-bot-hpe-alola
```

This key was authorized on Alola. Verification from HPE succeeded:

```bash
key="$HOME/teams-bot-hpe-alola-persistent-sessions-ssh/secrets/alola_ssh_key"
ssh -i "$key" \
  -o IdentitiesOnly=yes \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=accept-new \
  sareeder@ctr2-alola-login-03 hostname
```

Observed:

```text
ctr2-alola-login-03.adc.amd.com
```

The same key also worked for login node 04 during verification.

## Image/container verification

Build on HPE:

```bash
cd ~/teams-bot-hpe-alola-persistent-sessions-ssh
docker build -t teams-bot:hpe-alola-persistent-sessions-verify .
```

Verify container user and tools:

```bash
docker run --rm \
  -v "$HOME:$HOME" \
  teams-bot:hpe-alola-persistent-sessions-verify \
  sh -lc 'id; gh --version; git --version'
```

Observed:

```text
uid=1038(sareeder) gid=1037(sareeder) groups=1037(sareeder)
gh version 2.23.0
git version 2.39.5
```

Verify container can SSH to Alola with the mounted home/key path:

```bash
dir="$HOME/teams-bot-hpe-alola-persistent-sessions-ssh"
key="$dir/secrets/alola_ssh_key"

docker run --rm \
  -v "$HOME:$HOME" \
  -v "$key:/run/secrets/alola_ssh_key:ro" \
  teams-bot:hpe-alola-persistent-sessions-verify \
  sh -lc "ssh -i '$key' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new sareeder@ctr2-alola-login-03 hostname"
```

Observed:

```text
ctr2-alola-login-03.adc.amd.com
```

## Local/unit tests

Local WSL test run after final code changes passed:

```bash
npm test
```

Observed:

```text
118 tests passing
0 failing
```

HPE dockerized tests passed before the final Dockerfile-only GitHub CLI change. Re-run after pull/build if desired:

```bash
docker run --rm teams-bot:hpe-alola-persistent-sessions-verify npm test
```

## Login-node Alola smoke

Login-node smoke through the HPE container/session manager succeeded.

Command shape:

```bash
dir="$HOME/teams-bot-hpe-alola-persistent-sessions-ssh"
key="$dir/secrets/alola_ssh_key"

docker run --rm \
  -v "$HOME:$HOME" \
  -v "$dir/state:/app/state" \
  -v "$dir/logs:/app/logs" \
  -v "$key:/run/secrets/alola_ssh_key:ro" \
  -e ALOLA_SSH_OPTIONS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new" \
  teams-bot:hpe-alola-persistent-sessions-verify \
  node scripts/alola-session.js run \
    --thread smoke-login-20260527 \
    --timeout-ms 180000 \
    -- "hostname; pwd; command -v hipcc || true"
```

Observed:

```text
ctr2-alola-login-03.adc.amd.com
/workspace
/opt/rocm/bin/hipcc
```

Persistence test succeeded:

First command set env/cwd:

```bash
node scripts/alola-session.js run \
  --thread smoke-login-20260527 \
  --timeout-ms 180000 \
  -- "export TEAMS_ALOLA_SMOKE=login_ok; cd /home/AMD/sareeder; pwd"
```

Second command observed persisted state:

```bash
node scripts/alola-session.js run \
  --thread smoke-login-20260527 \
  --timeout-ms 180000 \
  -- 'printf "%s\n" "$TEAMS_ALOLA_SMOKE"; pwd'
```

Observed:

```text
login_ok
/home/AMD/sareeder
```

## GPU smoke status

The user said not to worry about GPU tests for now.

Partial GPU smoke was already successful before stopping:

```text
ctr-cx63-mi300x-21.adc.amd.com
/workspace
rocminfo_has_gfx942=true
exists:/home/AMD/sareeder/full/rocm-libraries
exists:/home/AMD/sareeder/TheRock
exists:/home/AMD/sareeder/ROCm-workspace
```

GPU session persistence was also observed:

```text
/home/AMD/sareeder/full/rocm-libraries
gpu_ok
/home/AMD/sareeder/full/rocm-libraries
```

The GPU session used a short timeout (`ALOLA_DEFAULT_GPU_TIMEOUT=00:10:00`) and should expire automatically. If taking over soon, check and clean up any smoke sessions:

```bash
dir="$HOME/teams-bot-hpe-alola-persistent-sessions-ssh"
key="$dir/secrets/alola_ssh_key"

docker run --rm \
  -v "$HOME:$HOME" \
  -v "$dir/state:/app/state" \
  -v "$dir/logs:/app/logs" \
  -v "$key:/run/secrets/alola_ssh_key:ro" \
  teams-bot:hpe-alola-persistent-sessions-verify \
  node scripts/alola-session.js stop --target gfx942 --thread smoke-gpu-20260527
```

Also safe to stop the login smoke session if not needed:

```bash
docker run --rm \
  -v "$HOME:$HOME" \
  -v "$dir/state:/app/state" \
  -v "$dir/logs:/app/logs" \
  -v "$key:/run/secrets/alola_ssh_key:ro" \
  teams-bot:hpe-alola-persistent-sessions-verify \
  node scripts/alola-session.js stop --thread smoke-login-20260527
```

## Compose deployment

Before bringing up Compose, ensure `.env` exists in the HPE clone and contains Teams/harness settings. Minimum shape:

```bash
TEAMS_CHAT_ID=19:your-channel-id@thread.skype
PORT=3978
POLL_INTERVAL=5000
HARNESS_BIN=omp
HARNESS_BASE_ARGS="--print"
HARNESS_SKIP_PERMISSIONS=1
HARNESS_APPEND_SYSTEM_PROMPT=1
```

Then:

```bash
cd ~/teams-bot-hpe-alola-persistent-sessions-ssh
docker compose config
docker compose up -d --build
docker compose logs -f teams-bot
```

Dashboard:

```text
http://hpe-sjc2-43:3978/
```

## User-facing Alola syntax

No flag:

```text
normal prompt -> harness local to HPE
```

Build/test/runtime prompts automatically instruct agents to use Alola session CLI.

Explicit targets:

```text
--alola                 default login node 03, gfx90a enroot session
--alola 04              login node 04
--alola gfx942          non-exclusive GPU allocation for gfx942
--alola 03 gfx950       GPU allocation for gfx950 via login node 03
--alola gpu:gfx90a      force compute-node allocation for gfx90a
```

CLI examples:

```bash
workspace/scripts/alola-session run -- 'hostname && pwd'
workspace/scripts/alola-session run --target gfx942 -- 'rocminfo'
workspace/scripts/alola-session status --target gfx942
workspace/scripts/alola-session attach --target gfx942
workspace/scripts/alola-session stop --target gfx942
```

## Known caveats / next checks

1. Re-run `docker compose config` and `docker compose up -d --build` on HPE after pulling latest branch.
2. Re-verify GitHub SSH after the user-added key:
   ```bash
   ssh -o BatchMode=yes -T git@github.com
   docker run --rm -v "$HOME:$HOME" teams-bot:hpe-alola-persistent-sessions-verify sh -lc 'ssh -o BatchMode=yes -T git@github.com'
   ```
3. Stop smoke sessions if still present.
4. GPU smoke is optional per user; do not spend time on it unless requested.
5. Do not stage or revert unrelated existing changes to `test/test-polls.js` or `test/test-threads.js` in the WSL checkout.
