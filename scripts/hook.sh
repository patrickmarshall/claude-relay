#!/bin/bash
# Claude Code hook -> claude-relay bridge.
# Usage (from claude-hooks.json): hook.sh <EventName>
# Reads the hook JSON from stdin and POSTs it to the relay on localhost, tagged
# with the tmux window Claude Code is running in. Must NEVER block or fail
# Claude Code: every path exits 0, output is discarded, hard 2 s timeout.
PORT="${CLAUDE_RELAY_PORT:-48761}"
[ -z "$TMUX_PANE" ] && exit 0
WIN=$(tmux display-message -p -t "$TMUX_PANE" '#S:#W' 2>/dev/null) || exit 0
[ -z "$WIN" ] && exit 0
curl -s -m 2 -o /dev/null \
  -X POST "http://127.0.0.1:${PORT}/hook" \
  -H 'Content-Type: application/json' \
  -H "X-Relay-Event: ${1:-unknown}" \
  -H "X-Relay-Window: ${WIN}" \
  --data-binary @- 2>/dev/null
exit 0
