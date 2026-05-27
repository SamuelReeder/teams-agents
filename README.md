# Teams Agents

Microsoft Teams bot that dispatches coding-agent harnesses from a Teams channel. The production topology is HPE-hosted: the harness runs locally on `hpe-sjc2-43` by default, while ROCm build/test/benchmark/GPU work is executed through durable Alola tmux sessions.

## Architecture

```text
Teams
  -> Teams bot on hpe-sjc2-43
      -> local Oh My Pi / harness agent process
          -> workspace/scripts/alola-session when ROCm/GPU execution is needed
              -> SSH to ctr2-alola-login-03/04
                  -> persistent login-node enroot tmux shell, or
                  -> persistent tmux-held non-exclusive SLURM GPU allocation
```

Repository layout:

```text
teams-agents/
├── server.js                  # Express server, polling, dashboard
├── lib/
│   ├── config.js              # env, paths, HPE/Alola configuration
│   ├── agent-spawn.js         # local harness lifecycle and routing context
│   ├── alola-session.js       # SSH/tmux/enroot/SLURM session manager
│   ├── teams-io.js            # Teams messaging via Skype API
│   └── threads.js             # thread state, polling loops
├── scripts/alola-session.js   # CLI entrypoint used by workspace wrapper
├── Dockerfile
├── compose.yaml
└── workspace/                 # submodule with project knowledge, agents, skills
```

The `workspace/` submodule contains project knowledge, specialist agents, slash commands, skills, machine configs, and `workspace/scripts/alola-session`, a wrapper around the app-level Alola session manager.

## HPE deployment

Deploy from a fresh clone on HPE, not by copying this workstation checkout:

```bash
git clone --recurse-submodules --branch hpe-alola-persistent-sessions git@github.com:SamuelReeder/teams-agents.git
cd teams-agents
git submodule update --init --recursive
npm ci
```

Create `.env` on HPE with Teams and harness settings:

```bash
TEAMS_CHAT_ID=19:your-channel-id@thread.skype
PORT=3978
POLL_INTERVAL=5000
HARNESS_BIN=omp
HARNESS_BASE_ARGS="--print"
HARNESS_SKIP_PERMISSIONS=1
HARNESS_APPEND_SYSTEM_PROMPT=1
```

Authenticate Teams once on HPE using the mounted/installed m365 Teams skill:

```bash
python3 ~/.claude/skills/m365-teams/scripts/auth.py
python3 ~/.claude/skills/m365-teams/scripts/auth.py --complete <device_code>
```

### SSH key for Alola

Production Alola access is key-based. Do not store passwords in the repo, `.env`, image, or compose file.

```bash
mkdir -p secrets
install -m 0400 /path/to/alola_key secrets/alola_ssh_key
ssh -i secrets/alola_ssh_key -o BatchMode=yes -o StrictHostKeyChecking=yes sareeder@ctr2-alola-login-03 hostname
```

Relevant environment defaults:

```bash
ALOLA_USER=sareeder
ALOLA_LOGIN_NODES=03,04
ALOLA_DEFAULT_LOGIN_NODE=03
ALOLA_DEFAULT_ASIC=gfx90a
ALOLA_DEFAULT_LOGIN_CONTAINER=sareeder-latest_container
ALOLA_IMAGE_TEMPLATE=/cluster/images/hipdnn/hipdnn_latest_{asic}.sqsh
ALOLA_DEFAULT_CONSTRAINT_PREFIX=MARKHAM
ALOLA_DEFAULT_GPU_TIMEOUT=08:00:00
ALOLA_SSH_KEY=/run/secrets/alola_ssh_key
ALOLA_SSH_OPTIONS="-o BatchMode=yes -o StrictHostKeyChecking=yes"
APP_STATE_DIR=/app/state
APP_LOG_DIR=/app/logs
APP_SECRETS_DIR=/app/secrets
```

### Docker Compose

```bash
docker compose up -d --build
docker compose logs -f teams-bot
```

Compose builds the image with the HPE account UID/GID (`APP_USER=sareeder`, `APP_UID=1038`, `APP_GID=1037` by default), mounts `/home/sareeder` into the container, and mounts durable HPE-local volumes for state/logs plus the read-only Alola deploy key. That makes SSH/Git see the same home-directory keys and config as the HPE account while keeping the bot independent of this WSL checkout. It does not mount the Docker socket and does not run privileged. If the harness binary is not installed in the image, mount an HPE-local harness install and set `HARNESS_BIN` accordingly in `.env` or `compose.yaml`.

Dashboard: `http://hpe-sjc2-43:3978/`.

## Local/manual run

```bash
npm install
./start.sh
# or
node server.js
```

`start.sh` is for interactive launches. Container deployments should use Compose/process-manager restarts rather than killing by port.

## Usage

Post a message in the monitored Teams channel. The bot starts a harness session and replies in the thread. Replies continue the same harness session.

### Default execution

No flag means the harness runs locally on HPE. Agents receive routing context instructing them to keep ordinary code/review/research work local, and to use Alola sessions for ROCm builds/tests/benchmarks/GPU runtime/provider verification.

Examples:

```text
Build hipDNN in the consumption worktree
What's the status of ALMIOPEN-1300?
Check GPU utilization on Alola
```

Build/test prompts do not require `--alola`; the routing context directs the agent to `workspace/scripts/alola-session` automatically.

### Alola target flags

`--alola` is consumed by the bot and is not forwarded to the harness. It keeps the harness local to HPE while setting a durable remote execution target for that Teams thread.

```text
--alola build hipDNN in the consumption worktree
--alola 04 run a quick login-node ROCm environment check
--alola gfx942 run rocminfo and verify the MI300 path
--alola 03 gfx950 run the gfx950 provider verification
--alola gpu:gfx90a force a compute-node allocation for gfx90a
--alola=gfx942 run a benchmark smoke test
```

Follow-up replies preserve the thread target unless a new `--alola ...` flag overrides it. GPU allocations use non-exclusive SLURM jobs with the configured timeout. If an allocation expires before a later prompt, the next command using the same target reacquires a fresh allocation.

### Harness flags

Leading `--` flags other than `--alola` are forwarded verbatim to the harness:

```text
--model openai/gpt-5.5 summarize the failing tests
--effort high --temperature 0.2 investigate this issue
--verbose -- prompt that starts after a valueless flag
```

Use standalone `--` to end harness flags before prompts that start with dashes.

## Alola session CLI

The session CLI writes command payloads to remote script files, invokes them through tmux, and captures output using start/done sentinels.

```bash
# Default login-node enroot session: node 03, gfx90a
workspace/scripts/alola-session run -- 'hostname && pwd && command -v hipcc'

# Specific login node
workspace/scripts/alola-session run --target 04 -- 'hostname'

# Non-exclusive GPU allocation
workspace/scripts/alola-session run --target gfx942 -- 'rocminfo'

# Force compute-node allocation for login ASIC
workspace/scripts/alola-session run --target gpu:gfx90a -- 'rocminfo'

# Status, attach, stop
workspace/scripts/alola-session status --target gfx942
workspace/scripts/alola-session attach --target gfx942
workspace/scripts/alola-session stop --target gfx942
```

Human attach commands are printed by `attach`; sessions are shared with agents where practical. Login sessions are cheap to keep. GPU sessions are bounded by SLURM `--time` and can be reacquired automatically.

## Workspace commands

Available workspace slash commands are passed through to the harness:

| Command | Description |
|---------|-------------|
| `/worktrees` | List or manage worktrees |
| `/orchestrate <JIRA-KEY>` | Full Jira → worktree → implement → PR pipeline |
| `/review-pr <project>` | Multi-agent code review |
| `/squash-prep [project] [base]` | Suggest squash strategy for clean history |

Available workspace skills are also listed by `!help`; ask for them by name, e.g. `pr-summary` or `hipdnn-superbuild-test`.

## Agent spawn details

Local agents are spawned with:

```bash
$HARNESS_BIN ${HARNESS_BASE_ARGS} \
  ${HARNESS_SESSION_FLAG:-"--session-id"} <uuid> \
  ${HARNESS_SYSTEM_PROMPT_FLAG:-"--append-system-prompt"} "<HPE/Alola routing context>" \
  ${HARNESS_SKIP_PERMISSIONS_FLAG:-"--dangerously-skip-permissions"} \
  <forwarded leading -- flags from the Teams message> \
  ${HARNESS_MCP_FLAG:-"--mcp-config"} mcp/mcp-servers.json \
  ${HARNESS_ADD_DIR_FLAG:-"--add-dir"} <all project directories> \
  ${HARNESS_PROMPT_FLAG:-"-p"} "<user message>"
```

- `cwd`: `workspace/` so the harness discovers AGENTS/CLAUDE instructions, skills, commands, and agents.
- State files default under the repo for local runs and under `APP_STATE_DIR` in deployment.
- Large outputs are split across multiple Teams replies.

## Teams API

Uses the Microsoft Teams Skype internal API:

- Auth: OAuth2 device code flow with Teams Desktop client ID.
- Read messages: `list_messages.py` via Skype messaging service.
- Send messages: `send_chat.py` via Graph API (`ChatMessage.Send`).
- Thread replies: `reply.py` posts to `{channelId};messageid={rootId}`.
- Tokens auto-refresh; re-auth is needed after extended inactivity.
