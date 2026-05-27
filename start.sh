#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$SCRIPT_DIR/.env"
    set +a
fi

echo "=== Teams Agents Launcher ==="
echo ""

# Check workspace submodule
if [ ! -f "$SCRIPT_DIR/workspace/CLAUDE.md" ]; then
    echo "[!] Workspace submodule not initialized. Running git submodule update..."
    cd "$SCRIPT_DIR" && git submodule update --init --recursive
fi

resolve_harness_bin() {
    local candidate resolved
    local home="${HOME:-$(eval echo ~)}"

    for candidate in "${HARNESS_BIN}" "${OH_MY_PI_BIN}" "$home/.local/bin/oh-my-pi" \
                     "$home/.bun/bin/oh-my-pi" "$home/.bun/bin/omp" \
                     "$home/.local/bin/omp" "$home/.local/bin/claude" \
                     "oh-my-pi" "omp" "claude"; do
        [ -z "$candidate" ] && continue
        case "$candidate" in
            ~*) candidate="$home/${candidate#~}" ;;
        esac
        if [[ "$candidate" = /* ]]; then
            if [ -x "$candidate" ]; then
                resolved="$candidate"
                break
            fi
        else
            if command -v "$candidate" >/dev/null 2>&1; then
                resolved="$(command -v "$candidate")"
                break
            fi
        fi
    done

    if [ -z "$resolved" ]; then
        echo "[!] Harness binary not found. Set HARNESS_BIN." >&2
        return 1
    fi

    echo "$resolved"
}

# Resolve harness binary
HARNESS_BIN_RESOLVED="$(resolve_harness_bin)" || exit 1
export HARNESS_BIN="$HARNESS_BIN_RESOLVED"
# Check Teams auth
if ! python3 "$HOME/.claude/skills/m365-teams/scripts/auth.py" --status 2>/dev/null | grep -q "YES"; then
    echo "[!] Teams not authenticated. Run: python3 ~/.claude/skills/m365-teams/scripts/auth.py"
    exit 1
fi

# Kill existing server only for interactive local launches. Container deployments
# should use the process manager instead of probing/killing by port.
if [ "${KILL_EXISTING_SERVER:-1}" = "1" ] && command -v lsof >/dev/null 2>&1; then
    EXISTING_PIDS="$(lsof -t -i:"${PORT:-3978}" 2>/dev/null || true)"
    if [ -n "$EXISTING_PIDS" ]; then
        kill $EXISTING_PIDS 2>/dev/null || true
        sleep 1
    fi
fi

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
