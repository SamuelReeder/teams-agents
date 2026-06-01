# Teams Agents

Microsoft Teams bot that dispatches an Oh My Pi/Claude-compatible harness from Teams chats. It uses `config/channels.json` as the single source of truth for monitored chats, with per-chat workspaces and model defaults, recurring polls, persistent Teams threads, Docker deployment, and optional Alola remote execution routing.

## Repository layout

```text
.
├── bin/
│   └── alola-session              # app-level Alola CLI
├── config/
│   ├── channels.example.json
│   ├── env.example
│   └── env.alola.example
├── scripts/
│   ├── alola-session.js           # compatibility launcher for old workspace wrappers
│   ├── setup.js                   # setup/config validation
│   └── teams/
│       └── reply.py
├── src/
│   ├── index.js                   # Express server, dashboard, poll loop
│   ├── config/                    # env, channels, secrets, workspaces
│   ├── agents/                    # harness args, spawn, routing context
│   ├── teams/                     # Teams IO and thread handling
│   ├── polls/                     # recurring poll scheduler
│   ├── alola/                     # SSH/tmux/enroot/SLURM session manager
│   └── state/                     # state store compatibility exports
├── test/
│   ├── agents/ config/ teams/ polls/ alola/ docker/ state/
├── Dockerfile
└── compose.yaml
```

`server.js` remains as a short compatibility launcher; new deployments should run `node src/index.js` or `npm start`.

Prerequisite: this app shells out to Microsoft Teams helper scripts from the `m365-teams` Claude skill (`auth.py`, `list_messages.py`, `send_chat.py`). Install/authenticate that skill on the host or set `TEAMS_SCRIPTS_DIR`/`TEAMS_REPLY_SCRIPT` to equivalent scripts before running `npm run setup:check`.

## Quick start: one Teams chat

1. Install dependencies:

```bash
npm ci
```

2. Copy the templates and fill in the required values:

```bash
cp config/env.example .env
cp config/channels.example.json config/channels.json
```

At minimum:
- set one `chatId` entry in `config/channels.json`
- set that entry's `workspace` to your actual workspace directory
- set `HARNESS_BIN` in `.env`, or leave it unset if `omp` is on `PATH`

3. Authenticate the Microsoft Teams helper scripts used by your `TEAMS_SCRIPTS_DIR` installation:

```bash
python3 ~/.claude/skills/m365-teams/scripts/auth.py
python3 ~/.claude/skills/m365-teams/scripts/auth.py --complete <device_code>
```

4. Add your actual workspace directory:

```json
[
  {
    "chatId": "19:your-chat-id@thread.skype",
    "label": "My project chat",
    "workspace": "/absolute/path/to/my-workspace"
  }
]
```

For local non-Docker runs, use an absolute host path or `~/...`. For Docker, mount the host directory and use the container path:

```bash
HOST_WORKSPACE_DIR=/host/path/to/my-workspace
APP_WORKSPACE_DIR=/app/workspace
```

```json
"workspace": "/app/workspace"
```

A workspace is treated as an opaque harness working directory. The bot does not require `.claude/`, `.shared/`, `repos/`, `worktrees`, or registry files to exist. If those conventional files exist, help/dashboard output may surface them; otherwise the harness simply starts with `cwd` set to the selected workspace.

5. Validate configuration:

```bash
npm run setup:check
```

6. Start the bot:

```bash
npm start
```

Dashboard: `http://localhost:3978/`.

## Channel configuration

`config/channels.json` is the only runtime source for monitored Teams chats. There is no `TEAMS_CHAT_ID` fallback and the legacy root `channels.json` file is intentionally ignored by the app. Keep one-chat and multi-chat deployments in the same file shape.

Each channel can set its own workspace, model defaults, and concurrency:

```json
[
  {
    "chatId": "19:chat-a@thread.skype",
    "label": "Workspace A",
    "workspace": "/srv/workspaces/a",
    "defaultModel": "openai/gpt-5.5",
    "alolaDefaultModel": "anthropic/claude-haiku-4-5",
    "maxConcurrentAgents": 2
  },
  {
    "chatId": "19:chat-b@thread.skype",
    "label": "Workspace B",
    "workspace": "~/workspaces/b",
    "defaultModel": "anthropic/claude-haiku-4-5",
    "maxConcurrentAgents": 1
  }
]
```

Validation rejects malformed JSON, duplicate chat IDs, missing `chatId`, non-string `workspace` values, and non-positive `maxConcurrentAgents`.

Workspace resolution order is:

1. `channel.workspace`
2. `APP_WORKSPACE_DIR`
3. `$HOME`

Explicitly configured workspace paths must exist and be readable.

## Secrets

Secrets are resolved at runtime; they are not baked into the Docker image. For a secret named `OPENAI_API_KEY`, resolution precedence is:

1. `OPENAI_API_KEY_FILE`
2. `/run/secrets/openai_api_key`
3. `APP_SECRETS_DIR/openai_api_key`
4. direct `OPENAI_API_KEY` environment value for local development

The same naming rule applies to `ANTHROPIC_API_KEY`, `LLM_GATEWAY_API_KEY`, and other allowlisted harness provider keys. Direct values are convenient for local development but are visible to the spawned harness when injected.

Important exposure model:

- Bot-only Teams credentials and Teams helper script state are not passed to spawned harness processes.
- Harness-required LLM/provider keys are passed only by explicit allowlist. If the harness can use a key, an agent can expose or misuse it.
- `ALOLA_SSH_KEY` is handled as a path secret. The bot passes a readable key path only to Alola-routed harness runs; it does not read private key material into logs or ordinary harness environments.
- Docker secrets and `*_FILE` variables protect against repo/image/log leakage. They are not a sandbox boundary once a child process can read the file or value.
- Agent output is not redacted before posting to Teams. Treat every harness-visible value as chat-visible.

For stronger isolation, run the harness under a separate user/container or broker privileged operations through the bot instead of giving raw credentials to the harness. Anyone who can trigger the harness can execute code in the configured workspace; keep monitored chat membership tight.

## Docker Compose

Default build and run:

```bash
docker compose up -d --build
docker compose logs -f teams-bot
```

Use a custom base image:

```bash
BASE_IMAGE=my-node-runtime:tag docker compose build
```

Custom `BASE_IMAGE` values must be Debian/Ubuntu-compatible because the Dockerfile uses `apt-get` in the app layer. If the base does not already provide `node` and `npm` on `PATH`, the layer installs Debian `nodejs`/`npm` packages; use a base that already has the Node version you require when Debian's packages are not sufficient.

Compose defaults are portable:

- state: `teams_state:/app/state`
- logs: `teams_logs:/app/logs`
- channel config: `./config/channels.json:/app/config/channels.json:ro`
- workspace: `${HOST_WORKSPACE_DIR:-teams_workspace}:${APP_WORKSPACE_DIR:-/app/workspace}`
- optional durable workspace source roots: `teams_workspace_repos` and `teams_workspace_worktrees`
- home: `${HOST_HOME_DIR:-teams_home}:/home/${APP_USER:-teamsbot}`
- dashboard port: `${HOST_BIND_ADDR:-127.0.0.1}:${PORT:-3978}:3978`
- Alola key: Docker secret `alola_ssh_key`, sourced from `${ALOLA_SSH_KEY_SOURCE:-./secrets/alola_ssh_key}` and mounted at `/run/secrets/alola_ssh_key`

Compose uses `.env` for variable interpolation but does not pass the entire `.env` file into the container. Runtime channel identity remains `config/channels.json`; deprecated values like `TEAMS_CHAT_ID` are ignored.
The base compose file does not mount a host Docker socket, does not bind-mount host `$HOME` by default, and publishes the dashboard on host loopback by default. Set `HOST_WORKSPACE_DIR`, `HOST_HOME_DIR`, or `HOST_BIND_ADDR=0.0.0.0` only when that exposure is intentional.

## Alola routing

For Alola deployments, copy the relevant optional values from `config/env.alola.example` into `.env`.

The app-level CLI is `bin/alola-session` and is also exposed as the package binary `alola-session`. `scripts/alola-session.js` remains as a compatibility launcher for old workspace wrappers, but external workspaces do not need to contain an Alola wrapper.

Examples:

```bash
bin/alola-session run -- 'hostname && pwd && command -v hipcc'
bin/alola-session run --target 04 -- 'hostname'
bin/alola-session run --target gfx942 -- 'rocminfo'
bin/alola-session run --target gpu:gfx90a -- 'rocminfo'
bin/alola-session status --target gfx942
bin/alola-session attach --target gfx942
bin/alola-session stop --target gfx942
```

`--alola` in Teams messages is consumed by the bot and is not forwarded to the harness. It records a durable remote execution target for that Teams thread. Build/test/runtime prompts can also infer Alola routing from the prompt; the injected routing context tells the agent to use the app-level CLI.

HPE/Alola deployments usually override these values in `.env` or an override file:

```bash
TEAMS_BOT_IMAGE=teams-bot:hipdnn-agent
BASE_IMAGE=registry-sc-harbor.amd.com/miopen-images/hipdnn_env@sha256:d9e27314d00b2694af59dfbe1f3d4363928bd19009ad4b4dd97cf6380e8ee30a
# The custom base must be Debian/Ubuntu-compatible for the app layer.
APP_USER=sareeder
APP_UID=1038
APP_GID=1037
HARNESS_BIN=/home/sareeder/.local/bin/omp
HOST_HOME_DIR=/home/sareeder
ALOLA_USER=sareeder
ALOLA_LOGIN_NODES=03,04
ALOLA_DEFAULT_LOGIN_NODE=03
ALOLA_DEFAULT_ASIC=gfx90a
ALOLA_DEFAULT_LOGIN_CONTAINER=sareeder-latest_container
ALOLA_IMAGE_TEMPLATE=/cluster/images/hipdnn/hipdnn_latest_{asic}.sqsh
ALOLA_DEFAULT_CONSTRAINT_PREFIX=MARKHAM
ALOLA_DEFAULT_GPU_TIMEOUT=08:00:00
ALOLA_SSH_KEY_SOURCE=./secrets/alola_ssh_key
```

## Teams usage

Post a message with the configured prefix (default `!agent`) in a monitored Teams chat:

```text
!agent summarize the current branch
!agent --model openai/gpt-5.5 investigate this failure
!agent --alola gfx942 run rocminfo and verify the MI300 path
```

Replies in the Teams thread continue the same harness session. The bot persists thread state under `APP_STATE_DIR/threads.json` and harness session files under `APP_STATE_DIR/sessions/<workspaceId>/<threadId>`. Legacy `sessions/<threadId>` directories are still discovered for migration.

Bot commands can be sent directly:

```text
!help
!models [filter]
!cron <interval> [--fresh] <prompt>
!cron-cancel <id>
!cron-restart <id>
!crons [--all]
```

Recurring polls persist workspace identity and post results as new Teams threads. Replies to poll result threads are routed back to the poll's workspace and session.

## Tests

Run the full suite:

```bash
npm test
```

The suite covers flag parsing, harness arg ordering, workspace fallback, channel schema validation, per-channel model/concurrency defaults, secret resolution/redaction, bot-secret environment isolation, thread/poll workspace persistence, legacy session migration, Docker build context rules, Docker base-image customization, Teams thread collection, and Alola command construction.
