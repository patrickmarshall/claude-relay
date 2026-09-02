# claude-relay

Self-hosted replacement for Claude Code's "remote control": a Telegram bot on your Mac
relays messages into Claude Code sessions living in tmux, streams their output back, and
turns permission prompts into Allow / Deny buttons. The same sessions stay fully usable
from a terminal (`tmux attach -t claude-relay`).

No inbound ports, no web UI, no cloud. Telegram long-polling out, `tmux send-keys` in.

```
Phone ──Telegram──> api.telegram.org <──long-poll── relay (Node, launchd)
                                                      ├─ tmux session "claude-relay", one window per Claude session
                                                      ├─ 127.0.0.1:48761/hook  <── Claude Code hooks (hook.sh)
                                                      ├─ ~/.claude-relay/inbox/<session>/   files from the phone
                                                      └─ ~/.claude-relay/logs/
```

## Requirements

- macOS, tmux ≥ 3.x (`/opt/homebrew/bin/tmux`), Node ≥ 20 (`/opt/homebrew/bin/node`; the
  nvm default of 18 is too old), Claude Code ≥ 2.1 (`/opt/homebrew/bin/claude`), `curl`, `jq`.
- A Telegram bot token from @BotFather and your numeric Telegram user id.
- The **company** Claude config dir (`~/.claude-work`, what the `cw` alias uses) must be logged in.

## Setup

```bash
git clone git@github.com:patrickmarshall/claude-relay.git ~/Documents/patrickmarshall/claude-relay
cd ~/Documents/patrickmarshall/claude-relay
PATH=/opt/homebrew/bin:$PATH npm install
mkdir -p ~/.claude-relay && cp config.example.json ~/.claude-relay/config.json && chmod 600 ~/.claude-relay/config.json
```

Edit `~/.claude-relay/config.json`:

| key | meaning |
|---|---|
| `telegramToken` | bot token. The relay refuses to start if the file is group/world readable. |
| `allowedUserIds` | numeric Telegram ids. Usernames are never used. Anyone else is dropped silently and logged. |
| `claudeConfigDir` | `~/.claude-work`. Personal config is deliberately unsupported. |
| `claudeBin` | absolute path to the real binary (the `claude` alias in `.zshrc` is not visible to tmux). |
| `repos` | alias → absolute path. `/new <alias>` only accepts these; free-form paths are rejected. |
| `permissionTimeoutSec` | unanswered permission prompts are denied after this. |
| `autoAllow` | opt-in "allow tool X for 1h" button. Off by default. `Bash/Write/Edit/MultiEdit/NotebookEdit` can never be auto-allowed. |

To find your user id: send the bot any message, then run `scripts/whoami.sh` (with the relay stopped).

Run in the foreground first:

```bash
PATH=/opt/homebrew/bin:$PATH npm run dev
```

Then install as a launchd agent (builds `dist/`, writes the plist, loads it, keeps it alive, wraps it in `caffeinate -i`):

```bash
scripts/install-launchd.sh
```

`scripts/install-launchd.sh --uninstall` removes it. After pulling changes, run the install script again.

## Commands

| command | behaviour |
|---|---|
| plain text | sent to the active session. Multi-line messages are pasted as one block. Rejected while a permission prompt is pending. |
| photo / document | saved to `~/.claude-relay/inbox/<session>/`, then `Attached file: <path>` + caption is injected. |
| `/new <alias>` | create a session for a configured repo, make it active. |
| `/ls` | sessions with state and idle time; `*` marks your active one. |
| `/use <name>` | switch active session. |
| `/status [name]` | details incl. pending permission and live auto-allow rules. |
| `/tail [name] [n]` | last n pane lines (default 40, max 200). |
| `/stop [name]` | send Escape (interrupt the current turn). |
| `/kill <name>` | Ctrl-C twice, close the window, forget the session. Asks for confirmation. |
| `/restart <name>` | recreate the window and `claude --resume <id>` (falls back to `--continue`). |
| `/pause` / `/resume` | stop/start forwarding your plain text. Output still streams. |
| `/inbox [name]`, `/inbox clear [name]` | list / delete inbox files (with confirmation). |
| `/rules`, `/rules clear` | show `permissions.allow/deny` from the company settings.json plus live auto-allow rules. |
| `/reload` | re-read `repos` and `autoAllow` from config. Token and allowlist are never reloaded. |

Output from every session is delivered, prefixed `[name]`, as normal wrapped text (≤ 4000 chars per message);
box-drawing lines are dropped and table rows flattened. `/tail` is the only monospace view. Relay-launched sessions
get an appended system prompt telling Claude the reader is on a phone via Telegram (no tables, short lines), so a
session created before that change needs `/restart <name>` to pick it up.
The relay posts `🟢 relay up` on boot and `🔴 relay stopping` on SIGTERM; tmux sessions survive both.

## How permissions work

1. Claude Code runs `scripts/hook.sh` for `PermissionRequest`, `Notification`, `Stop`, `UserPromptSubmit`,
   `SessionStart`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SessionEnd`. The hooks are passed via
   `claude --settings ~/.claude-relay/claude-hooks.json` (generated at boot), so they only exist in relay-launched
   sessions and nothing in `~/.claude-work/settings.json` is touched.
2. `hook.sh` POSTs the payload plus its tmux window name to `127.0.0.1:<hookPort>/hook`. It always exits 0 in ≤ 2 s.
3. On `PermissionRequest` the relay sends `[session] 🔐 Bash` + a ≤300-char summary with ✅ Allow / ❌ Deny buttons.
   Full tool input goes only to `~/.claude-relay/logs/permissions.log` (mode 600).
4. A tap answers the prompt in tmux (`answerPrompt()` in `src/permissions.ts` is the single place that knows the keys).
   The message is edited with the outcome and who decided. No tap before `permissionTimeoutSec` → Deny.
   Answering at the terminal is detected from the next hook event and the message says so.

Pre-approve routine tools the native way, in `~/.claude-work/settings.json` (the relay only reads it for `/rules`):

```json
{
  "permissions": {
    "allow": ["Read", "Glob", "Grep", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(ls:*)"],
    "deny":  ["Bash(git push:*)", "Bash(rm -rf:*)", "Bash(sudo:*)"]
  }
}
```

## Keeping the Mac awake

launchd runs the relay under `caffeinate -i`, which prevents idle sleep only while the relay runs and only on power.
Also: keep the laptop plugged in, System Settings → Energy → enable "Prevent automatic sleeping on power adapter when
the display is off", and keep the lid open when on battery. Wi-Fi must stay up for Telegram long-polling.

## Rotating the token

Get a new token from @BotFather (`/revoke`), put it in `~/.claude-relay/config.json`, then
`launchctl kickstart -k gui/$(id -u)/com.patrickmarshall.claude-relay`.

## Security notes

- Auth middleware runs before anything else; unknown ids never get a reply.
- The hook listener binds `127.0.0.1` only, accepts only `POST /hook`, bodies ≤ 64 KB.
- The relay executes only `tmux`; Claude is started by tmux from a fixed command line. No shell, no eval, no free paths.
- Text is sent with `send-keys -l` (literal) so nothing is interpreted as a key name; Enter is sent once at the end.
- 20 inbound messages/min per user; excess dropped with one warning.
- `config.json`, `state.json`, `permissions.log` are mode 600. The token is redacted from logs.

## Layout

```
src/index.ts        boot, hook → state machine wiring, shutdown
src/config.ts       config load/validate, 0600 check, /reload
src/tmux.ts         thin tmux wrapper (the only external command)
src/sessions.ts     registry, active session per user, state.json, create/kill/restart
src/pane.ts         pure parsing of captured panes (chrome, dialogs, idle/working)
src/watcher.ts      per-window poller → buffered output to Telegram
src/hooks.ts        localhost hook listener
src/permissions.ts  pending prompts, buttons, timeout, auto-allow, audit log
src/inbox.ts        file downloads
src/telegram.ts     bot, auth, commands
scripts/hook.sh     installed into claude-hooks.json
scripts/install-launchd.sh, launchd/*.plist.template
docs/prompt-samples.md   real pane captures the parsers are tuned against
```
