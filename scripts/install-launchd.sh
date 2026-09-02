#!/bin/bash
# Builds the relay, writes the launchd plist with absolute paths, and (re)loads it.
# Usage: scripts/install-launchd.sh [--uninstall]
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.patrickmarshall.claude-relay"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="${NODE_BIN:-}"
if [ -z "$NODE" ]; then
  if [ -x /opt/homebrew/bin/node ]; then NODE=/opt/homebrew/bin/node; else NODE="$(command -v node)"; fi
fi
TMUX="$(command -v tmux)"
CLAUDE="$(command -v claude || true)"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

[ -x "$NODE" ] || { echo "node not found; set NODE_BIN=/opt/homebrew/bin/node" >&2; exit 1; }
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "node >= 20 required, got $("$NODE" -v) at $NODE" >&2; exit 1; }
[ -n "$TMUX" ] || { echo "tmux not found" >&2; exit 1; }

# PATH for the relay and for the claude/tmux processes it spawns.
DIRS="$(dirname "$NODE"):$(dirname "$TMUX")"
[ -n "$CLAUDE" ] && DIRS="$DIRS:$(dirname "$CLAUDE")"
PATH_VALUE="$DIRS:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$HOME/.claude-relay/logs" "$HOME/Library/LaunchAgents"
[ -f "$HOME/.claude-relay/config.json" ] || { echo "missing $HOME/.claude-relay/config.json (copy config.example.json, chmod 600)" >&2; exit 1; }

echo "building…"
(cd "$REPO" && PATH="$PATH_VALUE" npm run --silent build)

sed -e "s|__NODE__|$NODE|g" -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" -e "s|__PATH__|$PATH_VALUE|g" \
  "$REPO/launchd/$LABEL.plist.template" > "$PLIST"
chmod 644 "$PLIST"
plutil -lint "$PLIST" >/dev/null

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "installed $PLIST"
echo "logs: $HOME/.claude-relay/logs/{relay.log,launchd.out,launchd.err}"
echo "status: launchctl print gui/$(id -u)/$LABEL | head -20"
