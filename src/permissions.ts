import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from './config.js';
import { escapeHtml, shortId, summarizeToolInput } from './format.js';
import type { Logger } from './log.js';
import { analyzePane } from './pane.js';
import { LOG_DIR, PERMISSIONS_LOG } from './paths.js';
import type { PendingPermission, Session, SessionManager } from './sessions.js';
import { tmux } from './tmux.js';

export type Decision = 'allow' | 'deny';
export type DecisionSource = `telegram:${number}` | 'timeout' | 'auto-allow' | 'terminal' | 'gone';

export interface InlineButton { text: string; callback_data: string }
export interface Notifier {
  broadcast(html: string, keyboard?: InlineButton[][]): Promise<Array<{ chatId: number; messageId: number }>>;
  edit(chatId: number, messageId: number, html: string): Promise<void>;
}

export interface AutoAllowRule { session: string; tool: string; expiresAt: number }

export class PermissionError extends Error {}

export class PermissionManager {
  /** In memory only, never persisted. */
  private rules = new Map<string, AutoAllowRule>();

  constructor(
    private readonly cfg: Config,
    private readonly sessions: SessionManager,
    private readonly notifier: Notifier,
    private readonly log: Logger,
  ) {
    mkdirSync(LOG_DIR, { recursive: true });
    if (!existsSync(PERMISSIONS_LOG)) writeFileSync(PERMISSIONS_LOG, '', { mode: 0o600 });
    chmodSync(PERMISSIONS_LOG, 0o600);
  }

  // ---------- incoming prompt ----------

  /** A session is waiting on a tool. Idempotent per tool_use_id. */
  async onRequest(session: Session, tool: string, input: unknown, toolUseId: string | undefined, via: 'hook' | 'pane'): Promise<void> {
    if (session.pending) {
      if (toolUseId && session.pending.toolUseId === toolUseId) return;
      if (via === 'pane') return; // hook already registered something; pane is only a fallback
      // A new request while one is pending means the old one was answered at the terminal.
      await this.resolveExternally(session, 'terminal');
    }
    const summary = summarizeToolInput(tool, input);
    const rule = this.liveRule(session.name, tool);
    if (rule) {
      this.audit({ session: session.name, tool, summary, input, decision: 'allow', source: 'auto-allow' });
      await this.answerPrompt(session, 'allow');
      await this.notifier.broadcast(`<b>[${escapeHtml(session.name)}]</b> ⏱ auto-allowed ${escapeHtml(tool)}: <code>${escapeHtml(summary)}</code>`);
      return;
    }
    const pending: PendingPermission = { id: shortId(), tool, summary, input, toolUseId, createdAt: Date.now(), via, messages: [] };
    session.pending = pending;
    this.sessions.setState(session.name, 'waiting_permission');
    this.audit({ session: session.name, tool, summary, input, decision: 'pending', source: via });

    const keyboard: InlineButton[][] = [[
      { text: '✅ Allow', callback_data: `p|${session.name}|${pending.id}|a` },
      { text: '❌ Deny', callback_data: `p|${session.name}|${pending.id}|d` },
    ]];
    if (this.cfg.autoAllow.enabled && !this.cfg.autoAllow.excludedTools.includes(tool)) {
      keyboard.push([{ text: `⏱ Allow ${tool} for ${Math.round(this.cfg.autoAllow.ttlSec / 60)}m`, callback_data: `p|${session.name}|${pending.id}|u` }]);
    }
    pending.messages = await this.notifier.broadcast(this.promptHtml(session.name, tool, summary), keyboard);
    pending.timer = setTimeout(() => void this.onTimeout(session.name, pending.id), this.cfg.permissionTimeoutSec * 1000);
  }

  private promptHtml(name: string, tool: string, summary: string): string {
    return `<b>[${escapeHtml(name)}]</b> 🔐 <b>${escapeHtml(tool)}</b>\n<code>${escapeHtml(summary)}</code>`;
  }

  // ---------- decisions ----------

  /** Telegram tap. Validates session + promptId before any key is sent. */
  async decide(sessionName: string, promptId: string, action: 'a' | 'd' | 'u', userId: number): Promise<string> {
    const session = this.sessions.get(sessionName);
    if (!session) throw new PermissionError('session no longer exists');
    const p = session.pending;
    if (!p || p.id !== promptId) throw new PermissionError('this prompt is no longer pending');
    if (session.state === 'dead') throw new PermissionError('session is dead');
    const source: DecisionSource = `telegram:${userId}`;
    if (action === 'u') {
      if (!this.cfg.autoAllow.enabled) throw new PermissionError('auto-allow is disabled in config');
      if (this.cfg.autoAllow.excludedTools.includes(p.tool)) throw new PermissionError(`${p.tool} can never be auto-allowed`);
      this.addRule(session.name, p.tool);
    }
    const decision: Decision = action === 'd' ? 'deny' : 'allow';
    await this.finish(session, p, decision, source, action === 'u' ? ` + auto-allow ${p.tool} ${Math.round(this.cfg.autoAllow.ttlSec / 60)}m` : '');
    return decision;
  }

  private async onTimeout(sessionName: string, promptId: string): Promise<void> {
    const session = this.sessions.get(sessionName);
    const p = session?.pending;
    if (!session || !p || p.id !== promptId) return;
    await this.finish(session, p, 'deny', 'timeout').catch((e) => this.log.error({ err: e }, 'timeout deny failed'));
  }

  private async finish(session: Session, p: PendingPermission, decision: Decision, source: DecisionSource, suffix = ''): Promise<void> {
    if (p.timer) clearTimeout(p.timer);
    session.pending = undefined;
    await this.answerPrompt(session, decision);
    this.sessions.setState(session.name, decision === 'allow' ? 'working' : 'idle');
    this.audit({ session: session.name, tool: p.tool, summary: p.summary, input: p.input, decision, source });
    const who = source === 'timeout' ? '⏰ denied (timeout)' : decision === 'allow' ? `✅ allowed by ${source}` : `❌ denied by ${source}`;
    await this.editAll(p, `${this.promptHtml(session.name, p.tool, p.summary)}\n${who}${escapeHtml(suffix)}`);
  }

  /** The prompt vanished without a tap: answered at the terminal, or the session died. */
  async resolveExternally(session: Session, source: 'terminal' | 'gone'): Promise<void> {
    const p = session.pending;
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    session.pending = undefined;
    if (session.state === 'waiting_permission') this.sessions.setState(session.name, 'working');
    this.audit({ session: session.name, tool: p.tool, summary: p.summary, input: p.input, decision: 'unknown', source });
    const label = source === 'terminal' ? '⌨️ answered at terminal' : '💀 session gone';
    await this.editAll(p, `${this.promptHtml(session.name, p.tool, p.summary)}\n${label}`);
  }

  private async editAll(p: PendingPermission, html: string): Promise<void> {
    for (const m of p.messages) {
      await this.notifier.edit(m.chatId, m.messageId, html).catch((e) => this.log.warn({ err: e }, 'edit failed'));
    }
  }

  /**
   * THE single place that knows how the Claude Code TUI accepts an answer.
   * Allow: pressing "1" selects "Yes" and confirms immediately (verified). The Enter fallback only fires if the
   * dialog is somehow still on screen 250 ms later.
   * Deny: Escape cancels the request ("Esc to cancel" in the dialog hint); Claude stops and waits for instructions.
   * Verified against Claude Code 2.1.216 — see docs/prompt-samples.md.
   */
  async answerPrompt(session: Session, choice: Decision): Promise<void> {
    const t = this.sessions.target(session.name);
    if (choice === 'deny') {
      await tmux.sendKeys(t, 'Escape');
      return;
    }
    await tmux.sendKeys(t, '1');
    await sleep(250);
    const pane = analyzePane(await tmux.capturePane(t));
    if (pane.dialog) await tmux.sendKeys(t, 'Enter');
  }

  // ---------- auto-allow ----------

  private ruleKey(session: string, tool: string): string {
    return `${session}|${tool}`;
  }

  liveRule(session: string, tool: string): AutoAllowRule | undefined {
    if (!this.cfg.autoAllow.enabled) return undefined;
    const r = this.rules.get(this.ruleKey(session, tool));
    if (!r) return undefined;
    if (r.expiresAt <= Date.now()) {
      this.rules.delete(this.ruleKey(session, tool));
      return undefined;
    }
    return r;
  }

  addRule(session: string, tool: string): AutoAllowRule {
    if (!this.cfg.autoAllow.enabled) throw new PermissionError('auto-allow is disabled');
    if (this.cfg.autoAllow.excludedTools.includes(tool)) throw new PermissionError(`${tool} is excluded from auto-allow`);
    const r = { session, tool, expiresAt: Date.now() + this.cfg.autoAllow.ttlSec * 1000 };
    this.rules.set(this.ruleKey(session, tool), r);
    this.log.info({ session, tool, expiresAt: new Date(r.expiresAt).toISOString() }, 'auto-allow rule added');
    return r;
  }

  listRules(): AutoAllowRule[] {
    const now = Date.now();
    for (const [k, r] of this.rules) if (r.expiresAt <= now) this.rules.delete(k);
    return [...this.rules.values()];
  }

  clearRules(): number {
    const n = this.rules.size;
    this.rules.clear();
    return n;
  }

  // ---------- audit ----------

  private audit(e: { session: string; tool: string; summary: string; input: unknown; decision: string; source: string }): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...e });
    try {
      mkdirSync(dirname(PERMISSIONS_LOG), { recursive: true });
      appendFileSync(PERMISSIONS_LOG, `${line}\n`, { mode: 0o600 });
    } catch (err) {
      this.log.error({ err }, 'permissions.log append failed');
    }
    this.log.info({ session: e.session, tool: e.tool, decision: e.decision, source: e.source }, 'permission');
  }
}
