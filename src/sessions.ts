import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { ALIAS_RE, type Config } from './config.js';
import type { Logger } from './log.js';
import { HOOKS_SETTINGS_PATH, RELAY_DIR, STATE_PATH } from './paths.js';
import { shellQuote, tmux, windowTarget } from './tmux.js';

export type SessionState = 'starting' | 'idle' | 'working' | 'waiting_permission' | 'dead';

export interface PendingPermission {
  id: string;
  tool: string;
  summary: string;
  input: unknown;
  toolUseId?: string;
  createdAt: number;
  via: 'hook' | 'pane';
  messages: Array<{ chatId: number; messageId: number }>;
  timer?: NodeJS.Timeout;
}

export interface Session {
  name: string;
  repo: string;
  cwd: string;
  state: SessionState;
  claudeSessionId?: string;
  createdAt: number;
  lastActivityAt: number;
  pending?: PendingPermission;
  deadNotified?: boolean;
}

interface PersistedSession {
  name: string;
  repo: string;
  cwd: string;
  claudeSessionId?: string;
  createdAt: number;
}
interface PersistedState {
  sessions: PersistedSession[];
  active: Record<string, string>;
}

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export class SessionError extends Error {}

export class SessionManager {
  readonly sessions = new Map<string, Session>();
  private active = new Map<number, string>();

  constructor(private readonly cfg: Config, private readonly log: Logger) {}

  target(name: string): string {
    return windowTarget(this.cfg.tmuxSession, name);
  }

  /** Ensures the tmux session exists and reattaches windows recorded in state.json. */
  async init(): Promise<{ reattached: string[]; dropped: string[] }> {
    mkdirSync(RELAY_DIR, { recursive: true });
    if (!(await tmux.hasSession(this.cfg.tmuxSession))) {
      await tmux.newSession(this.cfg.tmuxSession);
      this.log.info({ session: this.cfg.tmuxSession }, 'created tmux session');
    }
    const persisted = this.loadState();
    const windows = await tmux.listWindows(this.cfg.tmuxSession);
    const reattached: string[] = [];
    const dropped: string[] = [];
    for (const p of persisted.sessions) {
      const w = windows.find((x) => x.name === p.name);
      if (!w || w.dead) {
        dropped.push(p.name);
        if (w) await tmux.killWindow(this.target(p.name)).catch(() => undefined);
        continue;
      }
      this.sessions.set(p.name, { ...p, state: 'idle', lastActivityAt: Date.now() });
      reattached.push(p.name);
    }
    for (const [uid, name] of Object.entries(persisted.active)) {
      if (this.sessions.has(name)) this.active.set(Number(uid), name);
    }
    this.persist();
    this.log.info({ reattached, dropped }, 'session registry loaded');
    return { reattached, dropped };
  }

  get(name: string): Session | undefined {
    return this.sessions.get(name);
  }

  /** Throws a user-facing error if the session is unknown. */
  require(name: string): Session {
    const s = this.sessions.get(name);
    if (!s) throw new SessionError(`no session named "${name}" (see /ls)`);
    return s;
  }

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  getActive(userId: number): Session | undefined {
    const name = this.active.get(userId);
    return name ? this.sessions.get(name) : undefined;
  }

  setActive(userId: number, name: string): Session {
    const s = this.require(name);
    this.active.set(userId, name);
    this.persist();
    return s;
  }

  isActiveFor(userId: number, name: string): boolean {
    return this.active.get(userId) === name;
  }

  findByClaudeSessionId(id: string): Session | undefined {
    return [...this.sessions.values()].find((s) => s.claudeSessionId === id);
  }

  setState(name: string, state: SessionState): void {
    const s = this.sessions.get(name);
    if (!s || s.state === state) return;
    this.log.debug({ session: name, from: s.state, to: state }, 'state');
    s.state = state;
    s.lastActivityAt = Date.now();
  }

  touch(name: string): void {
    const s = this.sessions.get(name);
    if (s) s.lastActivityAt = Date.now();
  }

  setClaudeSessionId(name: string, id: string): void {
    const s = this.sessions.get(name);
    if (!s || s.claudeSessionId === id) return;
    s.claudeSessionId = id;
    this.persist();
  }

  private launchCommand(resume?: { id?: string; continue?: boolean }): string {
    const parts = [
      'env',
      `CLAUDE_CONFIG_DIR=${shellQuote(this.cfg.claudeConfigDir)}`,
      `CLAUDE_RELAY_PORT=${this.cfg.hookPort}`,
      shellQuote(this.cfg.claudeBin),
      '--settings', shellQuote(HOOKS_SETTINGS_PATH),
    ];
    if (resume?.id) parts.push('--resume', shellQuote(resume.id));
    else if (resume?.continue) parts.push('--continue');
    return parts.join(' ');
  }

  private pickName(alias: string): string {
    if (!this.sessions.has(alias)) return alias;
    for (let i = 2; i < 100; i++) {
      const n = `${alias}-${i}`;
      if (!this.sessions.has(n)) return n;
    }
    throw new SessionError(`too many sessions for ${alias}`);
  }

  /** `/new <alias>`: alias must be a configured repo. Free-form paths are never accepted. */
  async create(alias: string): Promise<Session> {
    if (!ALIAS_RE.test(alias)) throw new SessionError('bad alias');
    const cwd = this.cfg.repos[alias];
    if (!cwd) throw new SessionError(`unknown repo alias "${alias}". Known: ${Object.keys(this.cfg.repos).join(', ') || '(none)'}`);
    if (!existsSync(cwd)) throw new SessionError(`repo path for ${alias} no longer exists: ${cwd}`);
    const name = this.pickName(alias);
    if (await tmux.windowExists(this.cfg.tmuxSession, name)) {
      // Stale window not in our registry: don't adopt it silently.
      throw new SessionError(`tmux window "${name}" already exists but is not registered; kill it manually or pick another alias`);
    }
    await tmux.newWindow(this.cfg.tmuxSession, name, cwd, this.launchCommand());
    const now = Date.now();
    const s: Session = { name, repo: alias, cwd, state: 'starting', createdAt: now, lastActivityAt: now };
    this.sessions.set(name, s);
    this.persist();
    this.log.info({ session: name, repo: alias, cwd }, 'session created');
    return s;
  }

  /** Interrupt the current turn. */
  async interrupt(name: string): Promise<void> {
    this.require(name);
    await tmux.sendKeys(this.target(name), 'Escape');
  }

  /**
   * Sends user input to a session. Single-line text goes via literal send-keys;
   * multi-line text via bracketed paste so the TUI sees one block. Enter is sent once at the end.
   */
  async sendInput(name: string, text: string): Promise<void> {
    const s = this.require(name);
    if (s.state === 'dead') throw new SessionError(`${name} is dead; /restart ${name} or /kill ${name}`);
    const t = this.target(name);
    const clean = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    if (clean.includes('\n')) {
      await tmux.pasteText(t, clean);
      await sleep(150);
    } else {
      await tmux.sendText(t, clean);
      await sleep(50);
    }
    await tmux.sendKeys(t, 'Enter');
    s.lastActivityAt = Date.now();
    if (s.state === 'idle' || s.state === 'starting') s.state = 'working';
  }

  private async killWindowGracefully(name: string): Promise<void> {
    const t = this.target(name);
    if (await tmux.windowExists(this.cfg.tmuxSession, name)) {
      const info = await tmux.paneInfo(t).catch(() => ({ dead: true, command: '' }));
      if (!info.dead) {
        await tmux.sendKeys(t, 'C-c').catch(() => undefined);
        await sleep(200);
        await tmux.sendKeys(t, 'C-c').catch(() => undefined);
        await sleep(700);
      }
      await tmux.killWindow(t).catch(() => undefined);
    }
  }

  async kill(name: string): Promise<void> {
    this.require(name);
    await this.killWindowGracefully(name);
    this.remove(name);
    this.log.info({ session: name }, 'session killed');
  }

  remove(name: string): void {
    const s = this.sessions.get(name);
    if (s?.pending?.timer) clearTimeout(s.pending.timer);
    this.sessions.delete(name);
    for (const [uid, n] of this.active) if (n === name) this.active.delete(uid);
    this.persist();
  }

  /** Kill and recreate the window, resuming the same Claude conversation when its id is known. */
  async restart(name: string): Promise<{ resumed: boolean }> {
    const s = this.require(name);
    if (s.pending?.timer) clearTimeout(s.pending.timer);
    s.pending = undefined;
    await this.killWindowGracefully(name);
    const resume = s.claudeSessionId ? { id: s.claudeSessionId } : { continue: true };
    await tmux.newWindow(this.cfg.tmuxSession, name, s.cwd, this.launchCommand(resume));
    s.state = 'starting';
    s.lastActivityAt = Date.now();
    s.deadNotified = false;
    this.log.info({ session: name, resume }, 'session restarted');
    return { resumed: Boolean(s.claudeSessionId) };
  }

  /** Marks sessions whose window vanished or whose pane died. Returns the newly dead ones. */
  async refreshLiveness(): Promise<Session[]> {
    if (this.sessions.size === 0) return [];
    let windows;
    try {
      windows = await tmux.listWindows(this.cfg.tmuxSession);
    } catch (e) {
      this.log.warn({ err: e }, 'list-windows failed');
      return [];
    }
    const newlyDead: Session[] = [];
    for (const s of this.sessions.values()) {
      const w = windows.find((x) => x.name === s.name);
      const alive = w && !w.dead;
      if (!alive && s.state !== 'dead') {
        this.setState(s.name, 'dead');
        if (s.pending?.timer) clearTimeout(s.pending.timer);
        newlyDead.push(s);
      } else if (alive && s.state === 'dead') {
        // e.g. after /restart
        this.setState(s.name, 'starting');
      }
    }
    return newlyDead;
  }

  private loadState(): PersistedState {
    if (!existsSync(STATE_PATH)) return { sessions: [], active: {} };
    try {
      const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as Partial<PersistedState>;
      return {
        sessions: Array.isArray(raw.sessions) ? raw.sessions.filter((s) => s && NAME_RE.test(s.name)) : [],
        active: raw.active && typeof raw.active === 'object' ? raw.active : {},
      };
    } catch (e) {
      this.log.warn({ err: e }, 'state.json unreadable; starting empty');
      return { sessions: [], active: {} };
    }
  }

  persist(): void {
    const data: PersistedState = {
      sessions: [...this.sessions.values()]
        .filter((s) => s.state !== 'dead')
        .map(({ name, repo, cwd, claudeSessionId, createdAt }) => ({ name, repo, cwd, claudeSessionId, createdAt })),
      active: Object.fromEntries([...this.active].map(([uid, n]) => [String(uid), n])),
    };
    const tmp = `${STATE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, STATE_PATH);
  }
}
