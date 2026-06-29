#!/usr/bin/env bash
# atrium notify backend: POST the alert to a webhook (Slack/Discord/generic).
# atrium calls this with the alert message as the single final argument.
#
# Wire it in ~/.config/atrium/config.json:
#   "notify": { "sendCmd": ["/abs/path/to/examples/notify/webhook.sh"] }
#
# Set ATRIUM_WEBHOOK_URL in the environment (e.g. in the systemd unit) or hardcode below.
set -euo pipefail

URL="${ATRIUM_WEBHOOK_URL:-}"
if [[ -z "$URL" ]]; then
  echo "webhook.sh: set ATRIUM_WEBHOOK_URL" >&2
  exit 1
fi

MESSAGE="${1:-}"

# Slack and Discord both accept {"text": "..."}. Adjust the payload for other targets.
curl -fsS -X POST -H 'content-type: application/json' \
  --data "$(printf '{"text":%s}' "$(printf '%s' "$MESSAGE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" \
  "$URL" >/dev/null
