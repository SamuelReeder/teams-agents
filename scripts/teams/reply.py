#!/usr/bin/env python3
"""Reply to a specific message in a Teams channel thread.

Uses the Skype/Teams internal messaging API. Thread replies are sent
by encoding the original message ID into the conversation ID:
  {channelId};messageid={originalMessageId}

Usage:
    python3 scripts/teams/reply.py --chat-id "19:...@thread.skype" --reply-to "1778857658351" -m "Hello!"
"""

import argparse
import os
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

teams_scripts_dir = (
    os.environ.get("TEAMS_SCRIPTS_DIR")
    or os.environ.get("TEAMS_SCRIPT_DIR")
    or str(Path.home() / ".claude" / "skills" / "m365-teams" / "scripts")
)
sys.path.insert(0, teams_scripts_dir)
from skype_client import SkypeClient


def send_reply(chat_id: str, reply_to_id: str, message: str, as_html: bool = True) -> dict:
    client = SkypeClient()
    token = client.get_skypetoken()
    msg_base = client._msg_base

    thread_id = f"{chat_id};messageid={reply_to_id}"
    url = (
        f"{msg_base}/users/ME/conversations/"
        f"{urllib.parse.quote(thread_id, safe='')}/messages"
    )

    body = {
        "content": message,
        "messagetype": "RichText/Html" if as_html else "Text",
        "contenttype": "text/html" if as_html else "text",
    }

    data = json.dumps(body).encode()
    headers = {
        "X-Skypetoken": token,
        "Content-Type": "application/json",
    }

    req = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            location = resp.headers.get("Location", "")
            msg_id = location.rsplit("/", 1)[-1] if location else ""
            return {"status": "sent", "message_id": msg_id}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()[:500]
        return {"status": "error", "code": e.code, "body": raw}


def main():
    parser = argparse.ArgumentParser(description="Reply to a Teams message in a thread")
    parser.add_argument("--chat-id", required=True, help="Chat/channel thread ID")
    parser.add_argument("--reply-to", required=True, help="Message ID to reply to")
    parser.add_argument("--message", "-m", required=True, help="Reply content")
    parser.add_argument("--html", action="store_true", default=True, help="Send as HTML")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    message = sys.stdin.read() if args.message == "-" else args.message
    result = send_reply(args.chat_id, args.reply_to, message, args.html)

    if args.json:
        print(json.dumps(result, indent=2))
    elif result["status"] == "sent":
        print(f"Reply sent (message_id: {result.get('message_id', 'N/A')})")
    else:
        print(f"Failed: {result}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
