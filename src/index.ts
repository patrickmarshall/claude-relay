import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { ConfigError, loadConfig, reloadConfig, type Config } from './config.js';
import { escapeHtml, formatOutput } from './format.js';
import { startHookServer, type HookEvent } from './hooks.js';
import { Inbox } from './inbox.js';
import { log } from './log.js';
import type { PaneAnalysis } from './pane.js';
import { HOOK_SCRIPT, HOOKS_SETTINGS_PATH, RELAY_DIR } from './paths.js';
import { PermissionManager } from './permissions.js';
import { SessionManager, type Session } from './sessions.js';
import { createBot } from './telegram.js';
import { tmux } from './tmux.js';
import { Watcher } from './watcher.js';

/** Hook events forwarded to the relay. Generated into ~/.claude-relay/claude-hooks.json at boot. */
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'];

/**
 * Pane-based dialog detection: creates a pending prompt if the hook never fired, and resolves a pending
 * prompt when the dialog disappears (a terminal-side Escape fires no hook at all). Verified against
 * docs/prompt-samples.md; set CLAUDE_RELAY_PANE_DIALOGS=0 to disable.
 */
const PANE_DIALOG_DETECTION = process.env.CLAUDE_RELAY_PANE_DIALOGS !== '0';
const PANE_FALLBACK_DELAY_MS = 1000;

function writeHooksSettings(): void {
  const hooks: Record<string, unknown> = {};
  for (const ev of HOOK_EVENTS) {
    hooks[ev] = [{ hooks: [{ type: 'command', command: `"${HOOK_SCRIPT}" ${ev}`, timeout: 3 }] }];
  }
  mkdirSync(RELAY_DIR, { recursive: true });
  writeFileSync(HOOKS_SETTINGS_PATH, JSON.stringify({ hooks }, null, 2), { mode: 0o600 });
  chmodSync(HOOKS_SETTINGS_PATH, 0o600);
}

async function main(): Promise<void> {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      log.fatal(e.message);
      process.stderr.write(`config error: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
  writeHooksSettings();

  const sessions = new SessionManager(cfg, log);
  const { reattached, dropped } = await sessions.init();

  let perms!: PermissionManager;
  const dialogSeenAt = new Map<string, number>();
  /** PermissionRequest carries no tool_use_id; the preceding PreToolUse does. */
  const lastToolUse = new Map<string, { id: string; tool: string }>();

  const watcher = new Watcher(cfg, sessions, log, {
    async onOutput(session, text) {
      for (const chunk of formatOutput(session.name, text)) await notifier.broadcast(chunk);
    },
    async onPane(session, a: PaneAnalysis) {
      // Folder trust prompt: repos come only from config, i.e. the owner already trusts them.
      if (a.trustPrompt && session.state === 'starting') {
        log.info({ session: session.name }, 'accepting folder trust prompt');
        await tmux.sendKeys(sessions.target(session.name), 'Enter');
        await notifier.broadcast(`<b>[${escapeHtml(session.name)}]</b> accepted the folder trust prompt for <code>${escapeHtml(session.cwd)}</code>`);
        return;
      }
      // Keep the state machine honest when no hook fires (e.g. after a terminal-side Escape).
      if (!session.pending) {
        if (a.idle && session.state === 'working') sessions.setState(session.name, 'idle');
        else if (a.working && session.state === 'idle') sessions.setState(session.name, 'working');
      }
      if (!PANE_DIALOG_DETECTION) return;
      const now = Date.now();
      if (a.dialog) {
        const first = dialogSeenAt.get(session.name) ?? now;
        dialogSeenAt.set(session.name, first);
        if (!session.pending && now - first >= PANE_FALLBACK_DELAY_MS) {
          log.warn({ session: session.name }, 'permission dialog visible but no hook fired; using pane fallback');
          await perms.onRequest(session, a.dialog.tool ?? 'Unknown', { dialog: a.dialog.lines.join('\n') }, undefined, 'pane');
        }
      } else {
        dialogSeenAt.delete(session.name);
        if (session.pending && now - session.pending.createdAt > 3000) {
          await perms.resolveExternally(session, 'terminal');
        }
      }
    },
    async onDead(session) {
      if (session.deadNotified) return;
      session.deadNotified = true;
      if (session.pending) await perms.resolveExternally(session, 'gone');
      await notifier.broadcast(`<b>[${escapeHtml(session.name)}]</b> 💀 claude exited. /tail ${escapeHtml(session.name)} to see why, /restart or /kill`);
    },
  });

  const inboxHolder: { inbox?: Inbox } = {};
  const { bot, notifier } = createBot({
    cfg,
    sessions,
    watcher,
    perms: () => perms,
    get inbox() { return inboxHolder.inbox!; },
    log,
    reload() {
      const r = reloadConfig(cfg);
      return `reloaded. repos: ${r.repos.join(', ') || '(none)'} · autoAllow: ${r.autoAllow.enabled ? 'enabled' : 'disabled'} (ttl ${r.autoAllow.ttlSec}s)`;
    },
  });
  inboxHolder.inbox = new Inbox(cfg, bot.telegram);
  perms = new PermissionManager(cfg, sessions, notifier, log);

  const onHook = (e: HookEvent) => void handleHook(e).catch((err) => log.error({ err, event: e.event }, 'hook handling failed'));
  async function handleHook(e: HookEvent): Promise<void> {
    if (e.tmuxSession !== cfg.tmuxSession) return;
    const session = sessions.get(e.window);
    if (!session) {
      log.debug({ window: e.window, event: e.event }, 'hook for unregistered window ignored');
      return;
    }
    const p = e.payload;
    const ev = p.hook_event_name ?? e.event;
    log.debug({ session: session.name, ev, tool: p.tool_name, nt: p.notification_type }, 'hook');
    sessions.touch(session.name);
    switch (ev) {
      case 'SessionStart':
        if (p.session_id) sessions.setClaudeSessionId(session.name, p.session_id);
        if (session.state === 'starting') sessions.setState(session.name, 'idle');
        break;
      case 'UserPromptSubmit':
        if (session.pending) await perms.resolveExternally(session, 'terminal');
        sessions.setState(session.name, 'working');
        break;
      case 'PreToolUse':
        if (p.tool_use_id) lastToolUse.set(session.name, { id: p.tool_use_id, tool: p.tool_name ?? '' });
        if (session.pending && session.pending.toolUseId && session.pending.toolUseId !== p.tool_use_id) {
          await perms.resolveExternally(session, 'terminal');
        }
        if (session.state !== 'waiting_permission') sessions.setState(session.name, 'working');
        break;
      case 'PermissionRequest':
        await perms.onRequest(session, p.tool_name ?? 'Unknown', p.tool_input, p.tool_use_id ?? lastToolUse.get(session.name)?.id, 'hook');
        break;
      case 'Notification':
        if (p.notification_type === 'permission_prompt') {
          if (!session.pending) {
            // PermissionRequest did not reach us; use what the notification carries.
            const last = lastToolUse.get(session.name);
            const tool = (p.message ?? '').match(/permission to use (\S+)/)?.[1] ?? (last?.tool || 'Unknown');
            await perms.onRequest(session, tool, { message: p.message }, last?.id, 'hook');
          }
        } else if (p.notification_type === 'idle_prompt') {
          if (!session.pending) sessions.setState(session.name, 'idle');
        }
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        if (session.pending && session.pending.toolUseId === p.tool_use_id) await perms.resolveExternally(session, 'terminal');
        if (session.state !== 'waiting_permission') sessions.setState(session.name, 'working');
        break;
      case 'Stop':
        if (session.pending) await perms.resolveExternally(session, 'terminal');
        sessions.setState(session.name, 'idle');
        // Give the TUI a moment to finish rendering, then flush.
        setTimeout(() => void watcher.flushNow(session.name), 400);
        break;
      case 'SessionEnd':
        log.info({ session: session.name, reason: p.reason ?? p.end_reason }, 'claude session ended');
        break;
      default:
        break;
    }
  }

  const hookServer = await startHookServer(cfg.hookPort, log, onHook);
  watcher.start();

  // Telegraf's launch() promise only settles when polling stops; don't await it.
  bot.launch({ dropPendingUpdates: true }, () => log.info('telegram bot launched')).catch((e) => {
    log.fatal({ err: e }, 'telegram polling died');
    process.exit(1);
  });
  log.info({ reattached, dropped }, 'relay up');
  await notifier.broadcast(`🟢 relay up — ${reattached.length} session(s) reattached${dropped.length ? `, dropped: ${escapeHtml(dropped.join(', '))}` : ''}`);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'relay stopping');
    watcher.stop();
    hookServer.close();
    await notifier.broadcast('🔴 relay stopping (sessions keep running in tmux)').catch(() => undefined);
    bot.stop(signal);
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  log.fatal({ err: e }, 'relay crashed');
  process.stderr.write(`fatal: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
