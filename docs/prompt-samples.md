# Prompt samples (Phase 0 captures)

Environment verified 2026-09-02:

| item | value |
|---|---|
| Claude Code | 2.1.216 at `/opt/homebrew/bin/claude` (the `claude` shell alias is a decoy; `cw` = `CLAUDE_CONFIG_DIR=~/.claude-work command claude`) |
| company config dir | `~/.claude-work` |
| tmux | 3.7b at `/opt/homebrew/bin/tmux` (prefix C-b, tmux-resurrect/continuum installed) |
| node | 24.18.0 at `/opt/homebrew/bin/node` (nvm default is 18.20.4 — too old, launchd must use Homebrew node) |
| resume | `claude --resume <session_id>` (`-r`), or `--continue` for the most recent conversation in the cwd. The id comes from the `SessionStart` hook payload (`session_id`) and is the transcript filename under `<configDir>/projects/<cwd-slug>/<id>.jsonl`. |

## Hook events (verified in the 2.1.216 binary and with a live session)

Hooks are supplied with `claude --settings <file>` (merged with user settings; no prompt shown). Every hook is a
`command` with `timeout: 3`; `hook.sh` always exits 0 with empty stdout so the prompt falls through to the TUI.

| need | event | key payload fields |
|---|---|---|
| permission needed | `PermissionRequest` (matcher = tool name) | `session_id, cwd, tool_name, tool_input, tool_use_id, permission_mode` |
| prompt shown (secondary) | `Notification` with `notification_type: "permission_prompt"` | `message` ("Claude needs your permission to use Bash") |
| turn finished | `Stop` | `session_id, last_assistant_message` |
| idle for a while | `Notification` with `notification_type: "idle_prompt"` | |
| user typed a prompt (terminal or relay) | `UserPromptSubmit` | `prompt, prompt_id` |
| session id for /restart | `SessionStart` | `session_id, source (startup/resume/...), model` |
| tool ran (prompt answered at terminal) | `PostToolUse` / `PostToolUseFailure` | `tool_use_id` |

Captured `SessionStart` payload:

```json
{"session_id":"bbbdbeaf-2cae-4ef2-a94d-4474e05258ee","transcript_path":"/Users/patrickmarshall/.claude-work/projects/<cwd-slug>/bbbdbeaf-….jsonl","cwd":"…/scratchpad/repo","hook_event_name":"SessionStart","source":"startup","model":"claude-opus-4-8[1m]"}
```

`UserPromptSubmit` keys: `cwd, hook_event_name, permission_mode, prompt, prompt_id, session_id, transcript_path`.

Inside a hook, `tmux display-message -p -t "$TMUX_PANE" '#S:#W'` yields e.g. `relay-test:t1`, which is how the
relay maps a payload to a session.

## Folder trust prompt (first start in a new cwd)

```
 Accessing workspace:

 /private/tmp/…/scratchpad/repo

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
```

Answered with `Enter`. The relay auto-accepts this for sessions in `starting` state (repos come only from config).

## Idle prompt box

```
                                                                                                       ● high · /effort
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts · ← for agents
```

Transcript lines above the box: user prompts render as `❯ <text>`, assistant output as `⏺ …`, the finished-turn
spinner as `✻ Brewed for 0s`.

## Login expired (seen when the work account token had lapsed)

```
❯ Run this exact shell command and nothing else: touch hello.txt

⏺ Login expired · Please run /login

✻ Brewed for 0s
```

## Permission dialog

_PENDING: capture after `/login` in the work config. Record exact box text, option labels, which keys answer it,
and whether `1` confirms immediately or needs Enter. `answerPrompt()` in `src/permissions.ts` currently sends `1`,
then `Enter` only if the dialog is still visible; deny sends `Escape`._

## Multi-line paste (verified)

`printf "line one\nline two\nline three" | tmux load-buffer -b rt -; tmux paste-buffer -p -d -b rt -t <win>` inserts:

```
❯ line one
  line two
  line three
```

without submitting; a following `Enter` submits the whole block. `send-keys -l` with a newline would submit at
the newline, so the relay pastes any multi-line message and sends `Enter` once. `C-u` clears one line of the input.
