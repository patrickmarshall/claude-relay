#!/bin/bash
# Prints the numeric Telegram user IDs that have messaged the bot recently.
# Send the bot any message (e.g. /start) from your phone first, then run this.
# Stop the relay before running it: only one process may long-poll a bot.
set -euo pipefail
CFG="$HOME/.claude-relay/config.json"
TOKEN=$(jq -r .telegramToken "$CFG")
curl -s "https://api.telegram.org/bot${TOKEN}/getUpdates?limit=100" \
  | jq -r '.result[] | .message // .callback_query.message | select(. != null) | .from | "\(.id)\t\(.first_name // "")\t@\(.username // "")"' \
  | sort -u
