# Teams Agents

Microsoft Teams bot that dispatches an Oh My Pi/Claude-compatible harness from Teams chats. It uses `config/channels.json` as the single source of truth for monitored chats, with per-chat workspaces and model defaults, recurring polls, persistent Teams threads, Docker deployment, and optional remote execution routing.

## Repository layout

```text
.
├── bin/
│   └── alola-session              # app-level remote-session CLI
├── config/
│   ├── channels.example.json
│   ├── env.example
│   └── env.alola.example
├── scripts/
│   ├── setup.js                   # setup/config validation
│   └── teams/
│       └── reply.py
├── src/
│   ├── index.js                   # Express server, dashboard, poll loop
│   ├── config/                    # env, channels, secrets, workspaces
│   ├── agents/                    # harness args, spawn, routing context
│   ├── teams/                     # Teams IO and thread handling
│   ├── polls/                     # recurring poll scheduler
│   ├── alola/                     # SSH/tmux/enroot/SLURM remote session manager
│   └── state/                     # state store exports
├── test/
│   ├── agents/ config/ teams/ polls/ alola/ docker/ state/
├── Dockerfile
├── compose.yaml
└── compose.alola.yaml
```

## Prerequisites

Docker Compose quick start:
- Docker Engine with the Compose plugin (`docker compose`).
- Python 3.10+ for the Teams helper scripts. The Docker image includes Python for runtime use; host Python is only needed when you run the helper scripts from the host.
- The `m365-teams` Claude skill scripts available at `TEAMS_SCRIPTS_DIR` inside the bot runtime. The default is `$HOME/.claude/skills/m365-teams/scripts` as seen by the bot process, and must contain `auth.py`, `list_chats.py`, `list_messages.py`, and `send_chat.py`.
- A completed Teams auth flow for that same bot-visible home/scripts environment. Teams polling and sending are always managed by the bot container/process.
- A harness command available inside the agent-runner runtime, such as `omp`. In Docker Compose runner mode the runner does not mount the bot's Teams-auth home, so bake the harness into the image or mount a dedicated runner home/tool directory with `RUNNER_HOME_DIR`.
- A workspace directory on the host for the harness to run in.
- Membership in the Teams chat the bot will monitor.

Local npm runs additionally require Node.js 20+ and npm on the host. Docker users do not need host Node.js; the image provides Node for the app.

Remote routing additionally requires an SSH key and remote environment settings described in [Remote routing](#remote-routing).

## Quick start: Docker Compose

Use Docker Compose as the default path. It makes the runtime boundary explicit: the bot, state, logs, secrets, and mounted workspace are the same shape as a deployed instance.

> [!CAUTION]
> Docker Compose runner mode isolates spawned agents from the bot's Teams scripts, Teams auth home, and `config/channels.json` by running the harness in the `agent-runner` sidecar. The `teams-bot` service still mounts the bot-visible home for Teams auth/scripts; the `agent-runner` service mounts `RUNNER_HOME_DIR` or the `teams_runner_home` named volume instead. Do not point `RUNNER_HOME_DIR` at the same home that contains Teams auth unless you intentionally want agents to see those files.

1. Copy the templates:

```bash
cp config/env.example .env
cp config/channels.example.json config/channels.json
```

2. In `.env`, set the host workspace to mount and the path the bot should use inside the container:

```bash
HOST_WORKSPACE_DIR=/absolute/host/path/to/my-workspace
APP_WORKSPACE_DIR=/app/workspace
HARNESS_BIN=omp
```

Set `HARNESS_BIN` to the harness command or absolute path visible inside the `agent-runner` container. If your host home files are not readable by uid/gid `1000:1000`, set `APP_UID` and `APP_GID` in `.env` to your host uid/gid before building the image. If the harness is installed under a user home, prefer a dedicated `RUNNER_HOME_DIR` containing only runner tools and harness state, not Teams auth or Teams skill scripts.

3. If the harness needs provider API keys, add them as files under `./secrets`:

```bash
mkdir -p secrets
printf '%s' '<openai-api-key>' > secrets/openai_api_key
chmod 600 secrets/openai_api_key
```

Docker Compose mounts `./secrets` read-only into `agent-runner` at `/app/secrets`, and the runner resolves `secrets/openai_api_key` to `OPENAI_API_KEY` for spawned harness processes. Use the normalized lowercase file name for each provider key, such as `anthropic_api_key` for `ANTHROPIC_API_KEY`. Skip this step if your harness gets credentials another way.

4. Make sure the Teams helper scripts are visible where the bot will see them, then authenticate Teams and find the chat ID to monitor:

```bash
TEAMS_SCRIPTS_DIR="${TEAMS_SCRIPTS_DIR:-$HOME/.claude/skills/m365-teams/scripts}"
python3 "$TEAMS_SCRIPTS_DIR/auth.py"
python3 "$TEAMS_SCRIPTS_DIR/auth.py" --complete <device_code>
python3 "$TEAMS_SCRIPTS_DIR/list_chats.py" --limit 20 --json
```

Copy the `id` for the Teams chat you want the bot to monitor. That value is the `chatId` in `config/channels.json`.

5. Fill out `config/channels.json`. For one Docker-mounted workspace, the file can be:

```json
[
  {
    "chatId": "19:your-chat-id@thread.skype",
    "label": "My project chat",
    "workspace": "/app/workspace"
  }
]
```

`workspace` is the path seen by the bot. With the Compose settings above, `HOST_WORKSPACE_DIR` is mounted at `APP_WORKSPACE_DIR`, so channel entries should use the container path (`/app/workspace`), not the host path.

A workspace is treated as an opaque harness working directory. The bot does not require `.claude/`, `.shared/`, `repos`, `worktrees`, or registry files to exist. If those conventional files exist, help/dashboard output may surface them; otherwise the harness simply starts with `cwd` set to the selected workspace.

6. Validate the container configuration:

```bash
docker compose build
docker compose run --rm teams-bot npm run setup:check
```

A warning about `ALOLA_SSH_KEY` is expected unless you are using remote routing.

7. Start the bot:

```bash
docker compose up -d
docker compose logs -f teams-bot
```

Dashboard: `http://localhost:3978/`.

8. Send a smoke-test message in the monitored Teams chat:

```text
!agent say hello and print the current working directory
```

The bot should reply in the same Teams thread.

> [!NOTE]
> Teams replies can be a little leisurely, especially on the first run while the harness wakes up and stretches. Wait a bit before retrying; if nothing shows up, check for startup or send errors with `docker compose logs -f teams-bot`.

## Local npm run

Use the host-local Node path when Docker is unavailable or when you intentionally want the bot to run directly on the host. In this mode the bot spawns the harness directly; it is useful for development but is not a Teams filesystem isolation boundary.

1. Install dependencies and copy the templates if you have not already done so:

```bash
npm ci
cp config/env.example .env
cp config/channels.example.json config/channels.json
```

2. Authenticate Teams and find the chat ID to monitor:

```bash
TEAMS_SCRIPTS_DIR="${TEAMS_SCRIPTS_DIR:-$HOME/.claude/skills/m365-teams/scripts}"
python3 "$TEAMS_SCRIPTS_DIR/auth.py"
python3 "$TEAMS_SCRIPTS_DIR/auth.py" --complete <device_code>
python3 "$TEAMS_SCRIPTS_DIR/list_chats.py" --limit 20 --json
```

Copy the `id` for the Teams chat you want the bot to monitor. That value is the `chatId` in `config/channels.json`.

3. Fill out `config/channels.json` with a host path:

```json
[
  {
    "chatId": "19:your-chat-id@thread.skype",
    "label": "My project chat",
    "workspace": "/absolute/path/to/my-workspace"
  }
]
```

4. Set `HARNESS_BIN` in `.env`, or leave it unset if `omp` is on `PATH`.

5. Validate configuration and start:

```bash
npm run setup:check
npm start
```

Dashboard: `http://localhost:3978/`.

## Teams helper scripts

`TEAMS_SCRIPTS_DIR` is the bot's path to the `m365-teams` skill scripts directory. It is not resolved from the workspace. The directory must be visible inside the bot runtime and contain `auth.py`, `list_chats.py`, `list_messages.py`, and `send_chat.py`; `TEAMS_SCRIPT_DIR` is accepted as a singular alias.

With default Docker Compose settings, your host home is mounted as the bot home, so a host install at `$HOME/.claude/skills/m365-teams/scripts` appears inside the container at `/home/${APP_USER:-teamsbot}/.claude/skills/m365-teams/scripts`. If you set `HOST_HOME_DIR` to a dedicated service-account home, install/copy the skill and complete Teams auth under that home. If you set `HOST_HOME_DIR=teams_home`, bake/copy the scripts into the image or volume and set `TEAMS_SCRIPTS_DIR` to their in-container path.

`TEAMS_REPLY_SCRIPT` defaults to this repo's `scripts/teams/reply.py`. That wrapper also uses `TEAMS_SCRIPTS_DIR` to import the skill's `skype_client`, so direct sends, message polling, and thread replies all use the same script-directory setting.

## Channel configuration

`config/channels.json` is the only runtime source for monitored Teams chats. Keep one-chat and multi-chat deployments in the same file shape.

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

## Harness integration

The bot is not hard-coded to one harness binary. It builds harness arguments with a configured working directory, passes a non-interactive prompt, and reads stdout/stderr for the Teams reply. In Docker runner mode those requests go to the `agent-runner` sidecar; when `AGENT_RUNNER_URL` is unset the bot falls back to direct local spawn. Defaults target an Oh My Pi/Claude-compatible CLI:

```bash
HARNESS_BIN=omp
HARNESS_BASE_ARGS=--print
HARNESS_PROMPT_FLAG=-p
HARNESS_MODEL_FLAG=--model
```

For another harness, set `HARNESS_BIN`, `HARNESS_BASE_ARGS`, and any `HARNESS_*_FLAG` values needed by that CLI. Optional flags can be disabled by setting the value empty in `.env`; for example, `HARNESS_SESSION_FLAG=` disables session-id injection. Leading `--flags` in Teams messages are forwarded verbatim to the harness before the prompt. `!models` uses `HARNESS_LIST_MODELS_FLAG` and can be disabled with `HARNESS_LIST_MODELS_FLAG=` if the harness cannot list models.

## Agent runner isolation

Docker Compose starts two app containers on the private Compose network:

- `teams-bot` owns Teams polling, Teams sending, thread state, `config/channels.json`, `TEAMS_SCRIPTS_DIR`, and the bot-visible home where Teams auth lives.
- `agent-runner` owns harness execution, model listing, provider secret files, the mounted workspace, and optional remote SSH access. It does not mount `config/channels.json`, `TEAMS_SCRIPTS_DIR`, or the bot home.

The bot sends `args`, `cwd`, timeout, and remote-routing intent to `agent-runner` over HTTP. The runner validates `cwd` against `AGENT_RUNNER_ALLOWED_ROOTS` before spawning the harness and builds the harness environment from its own mounted secrets. Set `AGENT_RUNNER_TOKEN` or `AGENT_RUNNER_TOKEN_FILE` on both services if you want a shared bearer token on the private API.

Runner mode is the Teams isolation boundary. Direct local mode remains useful for development, but the harness then runs in the same process environment and filesystem view as the bot. Runner mode also does not hide secrets intentionally mounted into the runner: provider API keys and remote SSH access are agent-visible by design. If the workspace itself contains Teams auth/config files, agents can read them because the workspace is intentionally mounted into the runner.

Provide the harness to `agent-runner` without mounting the Teams-auth home: bake it into the image, install it in a custom base image, or set `RUNNER_HOME_DIR` to a dedicated home/tool directory that contains only runner material. Do not reuse `HOST_HOME_DIR` as `RUNNER_HOME_DIR` unless you accept exposing that home to agents.

## Secrets

Secrets are resolved at runtime; they are not baked into the Docker image. For local npm runs, direct `.env` values are acceptable. For Docker or shared deployments, prefer mounted secret files and keep raw key values out of `compose.yaml`, Dockerfiles, image build args, and committed config. The base Compose file mounts `${HOST_SECRETS_DIR:-./secrets}` read-only into `agent-runner` at `/app/secrets`; the `teams-bot` service does not mount that secret directory in isolated mode.

> [!CAUTION]
> File-based secrets reduce accidental exposure in config, image layers, `docker inspect`, shell history, and environment dumps. They are not a sandbox boundary: once the runner reads a provider key and injects it into a spawned harness, that harness can read, use, print, or exfiltrate it. Treat every runner-visible secret as agent-visible and Teams-visible.

For a secret named `OPENAI_API_KEY`, the Docker-friendly default is a file at `./secrets/openai_api_key`. Full resolution precedence is:

1. `OPENAI_API_KEY_FILE`
2. `/run/secrets/openai_api_key`
3. `APP_SECRETS_DIR/openai_api_key`
4. direct `OPENAI_API_KEY` environment value

The same naming rule applies to `ANTHROPIC_API_KEY`, `LLM_GATEWAY_API_KEY`, and other allowlisted harness provider keys.

Important exposure model:

- In runner mode, bot-only Teams credentials, Teams helper script state, and `config/channels.json` are neither passed to nor mounted into `agent-runner`.
- In direct local mode, bot-only Teams credentials are still excluded from the harness environment, but local filesystem access is not isolated from the bot.
- Harness-required LLM/provider keys are passed only by explicit allowlist from runner-local env/secret files. If the harness can use a key, an agent can expose or misuse it.
- `ALOLA_SSH_KEY` is handled as a path secret. In Compose remote-routing mode the key is mounted into `agent-runner`, not `teams-bot`; agents can intentionally use `bin/alola-session` because remote routing is a runner capability.
- Docker secrets and `*_FILE` variables protect against repo/image/log leakage. They are not a sandbox boundary once a child process can read the file or value.
- Agent output is not redacted before posting to Teams. Treat every harness-visible value as chat-visible.

## Docker Compose

Default build and run:

```bash
docker compose up -d --build
docker compose logs -f teams-bot agent-runner
```

Use a custom base image:

```bash
BASE_IMAGE=my-node-runtime:tag docker compose build
```

Custom `BASE_IMAGE` values must be Debian/Ubuntu-compatible because the Dockerfile uses `apt-get` in the app layer. If the base does not already provide `node >=20` and `npm` on `PATH`, the layer installs Node.js 20 from NodeSource.

Compose defaults are portable and intentionally split between bot-owned and runner-owned mounts:

- shared state: `teams_state:/app/state`
- shared logs: `teams_logs:/app/logs`
- bot-only channel config: `./config/channels.json:/app/config/channels.json:ro`
- runner-only provider secrets: `${HOST_SECRETS_DIR:-./secrets}:/app/secrets:ro`
- workspace mounted into both services: `${HOST_WORKSPACE_DIR:-teams_workspace}:${APP_WORKSPACE_DIR:-/app/workspace}`
- optional durable workspace source roots mounted into both services: `teams_workspace_repos` and `teams_workspace_worktrees`
- bot-only home for Teams auth/scripts: `${HOST_HOME_DIR:-${HOME:-teams_home}}:/home/${APP_USER:-teamsbot}`
- runner-only home/tool volume: `${RUNNER_HOME_DIR:-teams_runner_home}:/home/${APP_USER:-teamsbot}`
- private runner API: `http://agent-runner:${AGENT_RUNNER_PORT:-3979}` on the Compose network only
- dashboard port published only by `teams-bot`: `${HOST_BIND_ADDR:-127.0.0.1}:${PORT:-3978}:3978`

Compose uses `.env` for variable interpolation but does not pass the entire `.env` file into either container. Runtime channel identity remains `config/channels.json` in the bot service. The base compose file does not mount a host Docker socket and publishes the dashboard on host loopback by default.

## Remote routing

Remote routing lets a bot deployed on your Docker host or service machine give the agent SSH-backed access to a configured remote environment for build/test/GPU/runtime work. It is not a deployment target for the bot itself.

To enable remote routing, copy the relevant optional values from `config/env.alola.example` into `.env`. Docker Compose deployments with remote routing must also set `ALOLA_SSH_KEY_SOURCE` and include the remote override file. The override mounts the SSH key into `agent-runner`, not `teams-bot`.

```bash
docker compose -f compose.yaml -f compose.alola.yaml run --rm teams-bot npm run setup:check
docker compose -f compose.yaml -f compose.alola.yaml up -d --build
```

The app-level CLI is `bin/alola-session` and is also exposed as the package binary `alola-session`. In runner mode the harness invokes it inside `agent-runner`. Teams-routed agents receive `ALOLA_THREAD_ID` so CLI calls without `--thread` are scoped to the Teams thread; manual debugging should pass an explicit `--thread` value to avoid reusing the shared `manual` session.

Examples:

```bash
bin/alola-session run --thread manual-check -- 'hostname && pwd'
bin/alola-session run --thread manual-check --target 02 -- 'hostname'
bin/alola-session run --thread manual-gpu --target gfx000 -- 'command -v python3'
bin/alola-session status --thread manual-gpu --target gfx000
bin/alola-session attach --thread manual-gpu --target gfx000
bin/alola-session stop --thread manual-gpu --target gfx000
```

`--alola` in Teams messages is consumed by the bot and is not forwarded to the harness. It records a durable remote execution target for that Teams thread. Build/test/runtime prompts can also infer remote routing from the prompt; the injected routing context tells the agent to use the app-level CLI from inside `agent-runner`.

> [!NOTE]
> Remote routing can be slow while SSH sessions, containers, or GPU allocations spin up. Give it a moment before poking it, and use `bin/alola-session status --target <target>` from the runner context or `docker compose logs -f teams-bot agent-runner` if you need to see where it got stuck.

Remote routing values are deployment-specific and should live in `.env`, Docker secrets, or a private override file. Keep private users, hostnames, image paths, key paths, and allocation constraints out of committed files.

## Teams usage

Post a message with the configured prefix (default `!agent`) in a monitored Teams chat:

```text
!agent summarize the current branch
!agent --model openai/gpt-5.5 investigate this failure
!agent --alola <target> run the configured remote environment check
```

Replies in the Teams thread continue the same harness session. The bot persists thread state under `APP_STATE_DIR/threads.json` and harness session files under `APP_STATE_DIR/sessions/<workspaceId>/<threadId>`.

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

The suite covers flag parsing, harness arg ordering, workspace fallback, channel schema validation, per-channel model/concurrency defaults, secret resolution/redaction, bot-secret environment isolation, runner request/cwd validation, thread/poll workspace persistence, Docker build context rules, Docker bot/runner mount separation, Teams thread collection, and Alola command construction.
