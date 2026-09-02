import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Markup, Telegraf, type Context } from 'telegraf';
import { message, callbackQuery } from 'telegraf/filters';
import type { Config } from './config.js';
import { escapeHtml, fmtAge, formatOutput, shortId } from './format.js';
import { Inbox, InboxError } from './inbox.js';
import type { Logger } from './log.js';
import { PermissionError, PermissionManager, type InlineButton, type Notifier } from './permissions.js';
import { NAME_RE, SessionError, SessionManager } from './sessions.js';
import { tmux } from './tmux.js';
import type { Watcher } from './watcher.js';

const RATE_LIMIT_PER_MIN = 20;
const CONFIRM_TTL_MS = 60_000;

export interface BotDeps {
  cfg: Config;
  sessions: SessionManager;
  watcher: Watcher;
  perms: () => PermissionManager;
  inbox: Inbox;
  log: Logger;
  reload(): string;
}

const HELP = `<b>claude-relay</b>
plain text → active session
photo/document → saved to inbox, path injected

/new &lt;alias&gt; — new session for a configured repo
/ls — list sessions (* = active)
/use &lt;name&gt; — switch active session
/status [name] — details + pending permission
/tail [name] [n] — last n pane lines (default 40, max 200)
/stop [name] — Escape (interrupt current turn)
/kill &lt;name&gt; — end session (asks to confirm)
/restart &lt;name&gt; — recreate window, resume conversation
/pause · /resume — stop/start forwarding plain text
/inbox [name] · /inbox clear [name]
/rules · /rules clear — permission allow list + live auto-allow rules
/reload — re-read repos and autoAllow from config
/help`;

class RateLimiter {
  private hits = new Map<number, number[]>();
  private warned = new Map<number, number>();
  allow(userId: number): 'ok' | 'drop' | 'warn' {
    const now = Date.now();
    const arr = (this.hits.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (arr.length >= RATE_LIMIT_PER_MIN) {
      this.hits.set(userId, arr);
      const w = this.warned.get(userId) ?? 0;
      if (now - w > 60_000) {
        this.warned.set(userId, now);
        return 'warn';
      }
      return 'drop';
    }
    arr.push(now);
    this.hits.set(userId, arr);
    return 'ok';
  }
}

/** Serialises sends per chat and honours Telegram 429 retry_after once. */
class SendQueue {
  private chains = new Map<number, Promise<unknown>>();
  constructor(private readonly log: Logger) {}
  run<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(chatId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(async () => {
      try {
        return await fn();
      } catch (e) {
        const retry = (e as { response?: { parameters?: { retry_after?: number } } })?.response?.parameters?.retry_after;
        if (typeof retry === 'number' && retry <= 30) {
          this.log.warn({ chatId, retry }, 'telegram 429; retrying');
          await new Promise((r) => setTimeout(r, (retry + 0.5) * 1000));
          return await fn();
        }
        throw e;
      }
    });
    this.chains.set(chatId, next);
    return next;
  }
}

function args(ctx: Context): string[] {
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  return text.split(/\s+/).slice(1).filter(Boolean);
}

function userErr(e: unknown): string | undefined {
  if (e instanceof SessionError || e instanceof PermissionError || e instanceof InboxError) return e.message;
  return undefined;
}

export function createBot(deps: BotDeps): { bot: Telegraf; notifier: Notifier } {
  const { cfg, sessions, watcher, inbox, log } = deps;
  const bot = new Telegraf(cfg.telegramToken, { handlerTimeout: 60_000 });
  const allowed = new Set(cfg.allowedUserIds);
  const limiter = new RateLimiter();
  const queue = new SendQueue(log);
  const paused = new Set<number>();
  const confirms = new Map<string, { action: 'kill' | 'inboxclear'; name: string; userId: number; expiresAt: number }>();

  // 1. Auth first. Unknown IDs are dropped silently and logged.
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id || !allowed.has(id)) {
      log.warn({ userId: id, updateType: ctx.updateType }, 'unauthorized update dropped');
      return;
    }
    const verdict = limiter.allow(id);
    if (verdict === 'drop') return;
    if (verdict === 'warn') {
      await ctx.reply(`⚠️ rate limit: max ${RATE_LIMIT_PER_MIN} messages/min, dropping extras`).catch(() => undefined);
      return;
    }
    try {
      await next();
    } catch (e) {
      const msg = userErr(e);
      if (msg) await ctx.reply(`⚠️ ${msg}`).catch(() => undefined);
      else {
        log.error({ err: e, userId: id }, 'handler failed');
        await ctx.reply('⚠️ internal error, see relay.log').catch(() => undefined);
      }
    }
  });

  const html = (ctx: Context, text: string, extra: object = {}) =>
    ctx.reply(text, { parse_mode: 'HTML', ...extra });

  const notifier: Notifier = {
    async broadcast(text, keyboard) {
      const out: Array<{ chatId: number; messageId: number }> = [];
      for (const chatId of cfg.allowedUserIds) {
        try {
          const m = await queue.run(chatId, () =>
            bot.telegram.sendMessage(chatId, text, {
              parse_mode: 'HTML',
              ...(keyboard ? Markup.inlineKeyboard(keyboard.map((row) => row.map((b) => Markup.button.callback(b.text, b.callback_data)))) : {}),
            }));
          out.push({ chatId, messageId: m.message_id });
        } catch (e) {
          log.warn({ err: e, chatId }, 'broadcast failed');
        }
      }
      return out;
    },
    async edit(chatId, messageId, text) {
      await queue.run(chatId, () => bot.telegram.editMessageText(chatId, messageId, undefined, text, { parse_mode: 'HTML' }));
    },
  };

  const resolveTarget = (ctx: Context, name?: string) => {
    if (name) {
      if (!NAME_RE.test(name)) throw new SessionError('bad session name');
      return sessions.require(name);
    }
    const s = sessions.getActive(ctx.from!.id);
    if (!s) throw new SessionError('no active session. /new <alias> or /use <name>');
    return s;
  };

  const stateIcon = (st: string) =>
    ({ starting: '🟡', idle: '🟢', working: '🔵', waiting_permission: '🔐', dead: '💀' } as Record<string, string>)[st] ?? '·';

  // ---------- commands ----------
  bot.start((ctx) => html(ctx, HELP));
  bot.help((ctx) => html(ctx, HELP));

  bot.command('new', async (ctx) => {
    const [alias] = args(ctx);
    if (!alias) throw new SessionError(`usage: /new <alias>. Known: ${Object.keys(cfg.repos).join(', ') || '(none configured)'}`);
    const s = await sessions.create(alias);
    sessions.setActive(ctx.from.id, s.name);
    await html(ctx, `🟡 created <b>${escapeHtml(s.name)}</b> → <code>${escapeHtml(s.cwd)}</code>\nnow active`);
  });

  bot.command('ls', async (ctx) => {
    const list = sessions.list();
    if (list.length === 0) return html(ctx, `no sessions. /new &lt;alias&gt; — known: ${escapeHtml(Object.keys(cfg.repos).join(', ') || '(none)')}`);
    const now = Date.now();
    const lines = list.map((s) => {
      const star = sessions.isActiveFor(ctx.from.id, s.name) ? '*' : ' ';
      return `${star} ${stateIcon(s.state)} <b>${escapeHtml(s.name)}</b>  ${escapeHtml(s.repo)}  ${s.state}  ${fmtAge(now - s.lastActivityAt)}`;
    });
    return html(ctx, lines.join('\n'));
  });

  bot.command('use', async (ctx) => {
    const [name] = args(ctx);
    if (!name || !NAME_RE.test(name)) throw new SessionError('usage: /use <name>');
    const s = sessions.setActive(ctx.from.id, name);
    await html(ctx, `active → <b>${escapeHtml(s.name)}</b> (${s.state})`);
  });

  bot.command('status', async (ctx) => {
    const s = resolveTarget(ctx, args(ctx)[0]);
    const now = Date.now();
    const lines = [
      `${stateIcon(s.state)} <b>${escapeHtml(s.name)}</b> — ${s.state}`,
      `repo: ${escapeHtml(s.repo)}  <code>${escapeHtml(s.cwd)}</code>`,
      `created ${fmtAge(now - s.createdAt)} ago · last activity ${fmtAge(now - s.lastActivityAt)} ago`,
      `claude session: <code>${escapeHtml(s.claudeSessionId ?? 'unknown yet')}</code>`,
      `active for you: ${sessions.isActiveFor(ctx.from.id, s.name) ? 'yes' : 'no'} · forwarding: ${paused.has(ctx.from.id) ? 'paused' : 'on'}`,
    ];
    if (s.pending) {
      lines.push(`🔐 pending: <b>${escapeHtml(s.pending.tool)}</b> <code>${escapeHtml(s.pending.summary)}</code> (${fmtAge(now - s.pending.createdAt)}, via ${s.pending.via})`);
    }
    const rules = deps.perms().listRules().filter((r) => r.session === s.name);
    if (rules.length) lines.push(`⏱ auto-allow: ${rules.map((r) => `${escapeHtml(r.tool)} until ${new Date(r.expiresAt).toLocaleTimeString()}`).join(', ')}`);
    await html(ctx, lines.join('\n'));
  });

  bot.command('tail', async (ctx) => {
    const a = args(ctx);
    let name: string | undefined;
    let n = 40;
    for (const x of a) {
      if (/^\d+$/.test(x)) n = Math.min(200, Math.max(1, Number(x)));
      else name = x;
    }
    const s = resolveTarget(ctx, name);
    const lines = await tmux.capturePane(sessions.target(s.name), 200);
    const tail = lines.slice(-n).join('\n').replace(/\n+$/, '') || '(empty)';
    for (const chunk of formatOutput(s.name, tail)) await html(ctx, chunk);
  });

  bot.command('stop', async (ctx) => {
    const s = resolveTarget(ctx, args(ctx)[0]);
    await sessions.interrupt(s.name);
    await html(ctx, `⎋ sent Escape to <b>${escapeHtml(s.name)}</b>`);
  });

  const askConfirm = async (ctx: Context, action: 'kill' | 'inboxclear', name: string, prompt: string) => {
    const nonce = shortId();
    confirms.set(nonce, { action, name, userId: ctx.from!.id, expiresAt: Date.now() + CONFIRM_TTL_MS });
    await html(ctx, prompt, Markup.inlineKeyboard([
      Markup.button.callback('✅ confirm', `c|${nonce}`),
      Markup.button.callback('✖ cancel', `x|${nonce}`),
    ]));
  };

  bot.command('kill', async (ctx) => {
    const [name] = args(ctx);
    if (!name) throw new SessionError('usage: /kill <name>');
    const s = sessions.require(name);
    await askConfirm(ctx, 'kill', s.name, `kill <b>${escapeHtml(s.name)}</b> (${s.state})? The tmux window will be closed.`);
  });

  bot.command('restart', async (ctx) => {
    const [name] = args(ctx);
    if (!name) throw new SessionError('usage: /restart <name>');
    const s = sessions.require(name);
    watcher.forget(s.name);
    const { resumed } = await sessions.restart(s.name);
    await html(ctx, `🔄 restarted <b>${escapeHtml(s.name)}</b> (${resumed ? '--resume ' + escapeHtml(s.claudeSessionId ?? '') : '--continue'})`);
  });

  bot.command('pause', async (ctx) => {
    paused.add(ctx.from.id);
    await ctx.reply('⏸ forwarding paused (output still streams). /resume to continue');
  });
  bot.command('resume', async (ctx) => {
    paused.delete(ctx.from.id);
    await ctx.reply('▶️ forwarding resumed');
  });

  bot.command('inbox', async (ctx) => {
    const a = args(ctx);
    if (a[0] === 'clear') {
      const s = resolveTarget(ctx, a[1]);
      const n = inbox.list(s.name).length;
      if (n === 0) return html(ctx, `inbox for <b>${escapeHtml(s.name)}</b> is already empty`);
      return askConfirm(ctx, 'inboxclear', s.name, `delete ${n} file(s) in the inbox of <b>${escapeHtml(s.name)}</b>?`);
    }
    const s = resolveTarget(ctx, a[0]);
    const entries = inbox.list(s.name);
    if (entries.length === 0) return html(ctx, `inbox for <b>${escapeHtml(s.name)}</b> is empty`);
    const dir = inbox.dir(s.name);
    return html(ctx, `<code>${escapeHtml(dir)}</code>\n${entries.map((e) => `• ${escapeHtml(e.name)} (${Math.round(e.size / 1024)} KB)`).join('\n')}`);
  });

  bot.command('rules', async (ctx) => {
    const perms = deps.perms();
    if (args(ctx)[0] === 'clear') {
      const n = perms.clearRules();
      return ctx.reply(`cleared ${n} auto-allow rule(s)`);
    }
    let allow: string[] = [];
    let deny: string[] = [];
    try {
      const st = JSON.parse(readFileSync(join(cfg.claudeConfigDir, 'settings.json'), 'utf8')) as { permissions?: { allow?: string[]; deny?: string[] } };
      allow = st.permissions?.allow ?? [];
      deny = st.permissions?.deny ?? [];
    } catch (e) {
      log.warn({ err: e }, 'could not read company settings.json');
    }
    const live = perms.listRules();
    const lines = [
      `<b>permissions.allow</b> (${escapeHtml(join(cfg.claudeConfigDir, 'settings.json'))})`,
      allow.length ? allow.map((r) => `• <code>${escapeHtml(r)}</code>`).join('\n') : '(none)',
      `<b>permissions.deny</b>`,
      deny.length ? deny.map((r) => `• <code>${escapeHtml(r)}</code>`).join('\n') : '(none)',
      `<b>auto-allow</b> ${cfg.autoAllow.enabled ? 'enabled' : 'disabled'} · excluded: ${escapeHtml(cfg.autoAllow.excludedTools.join(', '))}`,
      live.length ? live.map((r) => `• [${escapeHtml(r.session)}] ${escapeHtml(r.tool)} until ${new Date(r.expiresAt).toLocaleTimeString()}`).join('\n') : '(no live rules)',
    ];
    return html(ctx, lines.join('\n'));
  });

  bot.command('reload', async (ctx) => {
    await html(ctx, escapeHtml(deps.reload()));
  });

  // ---------- callbacks ----------
  bot.on(callbackQuery('data'), async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split('|');
    try {
      if (parts[0] === 'p' && parts.length === 4) {
        const [, name, promptId, action] = parts;
        if (!NAME_RE.test(name!) || !/^[a-z0-9]{1,12}$/.test(promptId!) || !['a', 'd', 'u'].includes(action!)) throw new PermissionError('bad callback');
        const decision = await deps.perms().decide(name!, promptId!, action as 'a' | 'd' | 'u', ctx.from.id);
        await ctx.answerCbQuery(decision === 'allow' ? 'allowed' : 'denied');
        return;
      }
      if ((parts[0] === 'c' || parts[0] === 'x') && parts.length === 2) {
        const c = confirms.get(parts[1]!);
        confirms.delete(parts[1]!);
        if (!c || c.userId !== ctx.from.id || c.expiresAt < Date.now()) {
          await ctx.answerCbQuery('expired');
          await ctx.editMessageText('✖ expired').catch(() => undefined);
          return;
        }
        if (parts[0] === 'x') {
          await ctx.answerCbQuery('cancelled');
          await ctx.editMessageText('✖ cancelled').catch(() => undefined);
          return;
        }
        if (c.action === 'kill') {
          watcher.forget(c.name);
          await sessions.kill(c.name);
          await ctx.answerCbQuery('killed');
          await ctx.editMessageText(`💀 killed ${c.name}`).catch(() => undefined);
        } else {
          const n = inbox.clear(c.name);
          await ctx.answerCbQuery('cleared');
          await ctx.editMessageText(`🗑 deleted ${n} file(s) from inbox of ${c.name}`).catch(() => undefined);
        }
        return;
      }
      await ctx.answerCbQuery('unknown action');
    } catch (e) {
      const msg = userErr(e);
      await ctx.answerCbQuery(msg ?? 'error', { show_alert: Boolean(msg) }).catch(() => undefined);
      if (!msg) log.error({ err: e }, 'callback failed');
    }
  });

  // ---------- input ----------
  const forwardText = async (ctx: Context, text: string) => {
    const uid = ctx.from!.id;
    if (paused.has(uid)) return ctx.reply('⏸ paused — /resume first');
    const s = sessions.getActive(uid);
    if (!s) return ctx.reply('no active session. /new <alias> or /use <name>');
    if (s.state === 'waiting_permission') return ctx.reply(`🔐 [${s.name}] answer the pending permission prompt first (/status)`);
    if (s.state === 'dead') return ctx.reply(`💀 [${s.name}] is dead. /restart ${s.name} or /kill ${s.name}`);
    watcher.suppressEcho(s.name);
    await sessions.sendInput(s.name, text);
    return undefined;
  };

  bot.on(message('text'), async (ctx) => {
    if (ctx.message.text.startsWith('/')) return ctx.reply('unknown command, /help');
    await forwardText(ctx, ctx.message.text);
    return undefined;
  });

  const handleFile = async (ctx: Context, fileId: string, size: number | undefined, originalName: string | undefined, caption: string | undefined) => {
    const uid = ctx.from!.id;
    const s = sessions.getActive(uid);
    if (!s) return ctx.reply('no active session. /new <alias> or /use <name>');
    if (s.state === 'dead') return ctx.reply(`💀 [${s.name}] is dead`);
    const path = await inbox.save(s.name, fileId, size, originalName);
    const text = caption?.trim() ? `Attached file: ${path}\n${caption.trim()}` : `Attached file: ${path}`;
    if (paused.has(uid) || s.state === 'waiting_permission') {
      return html(ctx, `saved <code>${escapeHtml(path)}</code> (not injected: ${paused.has(uid) ? 'paused' : 'permission pending'})`);
    }
    watcher.suppressEcho(s.name);
    await sessions.sendInput(s.name, text);
    return html(ctx, `📎 [${escapeHtml(s.name)}] <code>${escapeHtml(path)}</code>`);
  };

  bot.on(message('photo'), async (ctx) => {
    const best = ctx.message.photo[ctx.message.photo.length - 1]!;
    await handleFile(ctx, best.file_id, best.file_size, 'photo.jpg', ctx.message.caption);
  });
  bot.on(message('document'), async (ctx) => {
    const d = ctx.message.document;
    await handleFile(ctx, d.file_id, d.file_size, d.file_name, ctx.message.caption);
  });

  bot.catch((err, ctx) => {
    log.error({ err, updateType: ctx.updateType }, 'telegraf error');
  });

  return { bot, notifier };
}
