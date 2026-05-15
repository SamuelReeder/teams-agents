#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Teams Agents Launcher ==="
echo ""

# Check workspace submodule
if [ ! -f "$SCRIPT_DIR/workspace/CLAUDE.md" ]; then
    echo "[!] Workspace submodule not initialized. Running git submodule update..."
    cd "$SCRIPT_DIR" && git submodule update --init --recursive
fi

# Check Claude CLI
if ! command -v claude &>/dev/null && [ ! -f "$HOME/.local/bin/claude" ]; then
    echo "[!] Claude CLI not found"
    exit 1
fi

# Check Teams auth
if ! python3 "$HOME/.claude/skills/m365-teams/scripts/auth.py" --status 2>/dev/null | grep -q "YES"; then
    echo "[!] Teams not authenticated. Run: python3 ~/.claude/skills/m365-teams/scripts/auth.py"
    exit 1
fi

# Kill existing server
kill $(lsof -t -i:3978) 2>/dev/null
sleep 1

# Start server
echo "[1/1] Starting server..."
cd "$SCRIPT_DIR"
node server.js &
SERVER_PID=$!
sleep 2

if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "ERROR: Server failed to start"
    exit 1
fi

echo ""
echo "========================================"
echo "  Server:    http://localhost:3978"
echo "  Dashboard: http://localhost:3978/"
echo "  Workspace: $SCRIPT_DIR/workspace"
echo "========================================"
echo ""
echo "Press Ctrl+C to stop"

cleanup() {
    echo ""
    echo "Shutting down..."
    kill $SERVER_PID 2>/dev/null
    exit 0
}
trap cleanup SIGINT SIGTERM

wait $SERVER_PID
