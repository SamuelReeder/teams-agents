# Teams Agents

Microsoft Teams bot that dispatches coding-agent harnesses from a Teams channel. By default it launches the Oh My Pi CLI; set `HARNESS_BIN` / `HARNESS_DEFAULT_MODEL` if you want a specific harness or model. Each message starts a new agent session in a thread; replies in the thread continue the conversation.

## Architecture

```
teams-agents/              ← infra (this repo)
├── server.js              ← Express server, polling, dashboard
├── lib/                   ← modules
│   ├── config.js          ← env, paths, constants
│   ├── agent-spawn.js     ← harness process lifecycle
│   ├── teams-io.js        ← Teams messaging via Skype API
│   └── threads.js         ← thread state, polling loops
├── reply.py               ← thread replies via Skype API
├── mcp/                   ← MCP server configs
└── workspace/             ← git submodule (domain knowledge)
```

The `workspace/` submodule contains all project knowledge, specialist agents, slash commands, skills, and machine configs. Agents spawn with `cwd: workspace/` so the harness auto-discovers everything.

## How It Works

1. Server polls a Teams channel every 5s for new messages via the [Skype/Teams internal API](workspace/.claude/skills/m365-teams/)
2. New message → new harness session (UUID), spawned with full workspace context
3. Agent runs autonomously (defaults include `--print`; skip-permissions can be toggled)
4. Result posted back as a thread reply
5. Reply in the thread → session resumed with the harness resume flag (default: `--resume <uuid>`)

## Setup

### Prerequisites

- Node.js 18+
- Python 3.10+
- Harness CLI installed (default: Oh My Pi; override by setting `HARNESS_BIN`)
- Microsoft 365 account (for Teams API)

### Install

```bash
git clone --recurse-submodules git@github.com:SamuelReeder/teams-agents.git
cd teams-agents
npm install
```

### Authenticate with Teams

One-time device code flow:

```bash
python3 ~/.claude/skills/m365-teams/scripts/auth.py
# Follow browser instructions, then:
python3 ~/.claude/skills/m365-teams/scripts/auth.py --complete <device_code>
```

### Configure

Create `.env`:

```bash
TEAMS_CHAT_ID=19:your-channel-id@thread.skype
PORT=3978
POLL_INTERVAL=5000
```

Optional harness overrides (defaults shown):

```bash
HARNESS_BIN=~/.local/bin/oh-my-pi
HARNESS_BASE_ARGS="--print"
HARNESS_SKIP_PERMISSIONS=1
HARNESS_APPEND_SYSTEM_PROMPT=1
# HARNESS_DEFAULT_MODEL=openai/gpt-5.5
```

To find your channel ID:

```bash
python3 ~/.claude/skills/m365-teams/scripts/list_teams.py
python3 ~/.claude/skills/m365-teams/scripts/list_channels.py --team-id <team-id>
```

### Run

```bash
./start.sh
# or
node server.js
```

Dashboard at `http://localhost:3978`.

## Usage

Post a message in the monitored Teams channel. The bot picks it up and spawns a harness agent.

### Free-form messages

Just type naturally. The agent has a routing context with all projects, worktrees, and machines — it decides where to work.

```
Build hipDNN in the consumption worktree
What's the status of ALMIOPEN-1300?
Check GPU utilization on alola3
```

### Workspace commands

All slash commands from the workspace are available natively:

| Command | Description |
|---------|-------------|
| `/goto <project>` | Navigate to a project, load its CLAUDE.md |
| `/status` | Git status across all projects |
| `/worktrees` | List or manage worktrees |
| `/task <action>` | Local issue tracking (beads) |
| `/orchestrate <JIRA-KEY>` | Full Jira → worktree → implement → PR pipeline |
| `/review-pr <project>` | Multi-agent code review |
| `/create-pr` | Push and create a draft PR |
| `/prep-pr` | Draft PR title and body |
| `/descriptor <JIRA-KEY>` | Descriptor lowering/lifting orchestration |

### Thread conversations

Reply in a thread to continue the conversation with the same agent. The session is resumed with full context from prior messages.

## Workspace Submodule

The `workspace/` directory is a git submodule pointing to the domain knowledge repo. It contains:

- `CLAUDE.md` — hub instructions
- `.claude/registry/projects.json` — project paths, aliases, worktrees
- `.claude/registry/machines.json` — SSH machine configs
- `.claude/agents/` — specialist agents (commit, builder, etc.)
- `.claude/commands/` — slash commands
- `.claude/skills/` — skills (review-pr, descriptor-*, orchestrate)

To update the submodule:

```bash
git submodule update --remote workspace
```

To swap in a different workspace for a different domain, replace the submodule.

## Agent Spawn Details

Each agent is spawned with:

```bash
$HARNESS_BIN --print \
  --session-id <uuid> \
  --dangerously-skip-permissions \
  --append-system-prompt "<routing context from projects.json>" \
  --add-dir <all project directories> \
  -p "<user message>"
```

- `cwd`: `workspace/` (auto-discovers CLAUDE.md, agents, commands, skills)
- Routing context includes all projects, aliases, worktrees, machines, and Jira mapping
- `--add-dir` grants file access to all project directories
- Max 3 concurrent agents, 10-minute timeout per agent
- Large outputs (>4000 chars) are split across multiple thread replies

## MCP Servers

Add MCP server configs to `mcp/mcp-servers.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "gh",
      "args": ["mcp-server"]
    }
  }
}
```

All agents receive `--mcp-config mcp/mcp-servers.json` automatically.

## Teams API

Uses the Microsoft Teams Skype internal API (no Azure Bot registration needed):

- **Auth**: OAuth2 device code flow with Teams Desktop client ID
- **Read messages**: `list_messages.py` via Skype messaging service
- **Send messages**: `send_chat.py` via Graph API (`ChatMessage.Send`)
- **Thread replies**: `reply.py` posts to `{channelId};messageid={rootId}`
- Tokens auto-refresh; re-auth needed after ~90 days of inactivity
