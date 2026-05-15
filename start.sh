#!/bin/bash

# Kill any existing processes on port 3978
kill $(lsof -t -i:3978) 2>/dev/null
# Kill any existing cloudflared
pkill -f "cloudflared tunnel" 2>/dev/null

sleep 1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLOUDFLARED="$HOME/cloudflared"
TUNNEL_LOG="/tmp/cloudflared.log"

echo "=== Teams Bot Launcher ==="
echo ""

# Start the Node.js server
echo "[1/3] Starting server..."
cd "$SCRIPT_DIR"
node server.js &
SERVER_PID=$!
sleep 2

# Check server is running
if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "ERROR: Server failed to start"
    exit 1
fi
echo "       Server running (PID $SERVER_PID)"

# Start cloudflared tunnel
echo "[2/3] Starting tunnel..."
$CLOUDFLARED tunnel --url http://localhost:3978 > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

# Wait for tunnel URL to appear in logs
TUNNEL_URL=""
for i in $(seq 1 30); do
    TUNNEL_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
    if [ -n "$TUNNEL_URL" ]; then
        break
    fi
    sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
    echo "ERROR: Could not get tunnel URL after 30s"
    echo "Check $TUNNEL_LOG for details"
    kill $SERVER_PID $TUNNEL_PID 2>/dev/null
    exit 1
fi

echo "       Tunnel running (PID $TUNNEL_PID)"
echo ""

# Post URL to Teams
echo "[3/3] Posting tunnel URL to Teams..."
WEBHOOK_URL=$(grep '^TEAMS_WEBHOOK_URL=' "$SCRIPT_DIR/.env" | cut -d'=' -f2-)

if [ -n "$WEBHOOK_URL" ]; then
    ENDPOINT="${TUNNEL_URL}/api/command"
    curl -s -X POST "$WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d "{
            \"type\": \"message\",
            \"attachments\": [{
                \"contentType\": \"application/vnd.microsoft.card.adaptive\",
                \"content\": {
                    \"\$schema\": \"http://adaptivecards.io/schemas/adaptive-card.json\",
                    \"type\": \"AdaptiveCard\",
                    \"version\": \"1.4\",
                    \"body\": [{
                        \"type\": \"TextBlock\",
                        \"text\": \"🤖 **Agent Bot Online**\",
                        \"size\": \"large\",
                        \"weight\": \"bolder\"
                    }, {
                        \"type\": \"TextBlock\",
                        \"text\": \"Update your Power Automate flow HTTP action URL to:\",
                        \"wrap\": true
                    }, {
                        \"type\": \"TextBlock\",
                        \"text\": \"${ENDPOINT}\",
                        \"wrap\": true,
                        \"fontType\": \"monospace\"
                    }]
                }
            }]
        }" > /dev/null 2>&1
    echo "       Posted to Teams"
fi

echo ""
echo "========================================"
echo "  Server:  http://localhost:3978"
echo "  Tunnel:  $TUNNEL_URL"
echo "  Endpoint: ${TUNNEL_URL}/api/command"
echo ""
echo "  Copy this URL into your Power Automate"
echo "  flow's HTTP action:"
echo ""
echo "  ${TUNNEL_URL}/api/command"
echo "========================================"
echo ""
echo "Press Ctrl+C to stop everything"

# Cleanup on exit
cleanup() {
    echo ""
    echo "Shutting down..."
    kill $SERVER_PID $TUNNEL_PID 2>/dev/null
    exit 0
}
trap cleanup SIGINT SIGTERM

# Wait for either process to exit
wait $SERVER_PID $TUNNEL_PID
