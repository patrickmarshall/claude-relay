import type { Config } from './config.js';
import type { Logger } from './log.js';
import { analyzePane, cleanTranscript, type PaneAnalysis } from './pane.js';
import type { Session, SessionManager } from './sessions.js';
import { tmux } from './tmux.js';

const HISTORY_LINES = 400;
const SIZE_FLUSH_CHARS = 1500;
const QUIET_FLUSH_MS = 2000;
const ECHO_WINDOW_MS = 15_000;
const RESYNC_TAIL = 30;

interface WindowState {
  flushed: string[];
  lastDoc: string[];
  lastChangeAt: number;
  echoUntil: number;
  echoBudget: number;
  initialized: boolean;
}

export interface WatcherHandlers {
  onOutput(session: Session, text: string): Promise<void>;
  onPane(session: Session, analysis: PaneAnalysis): Promise<void>;
  onDead(session: Session): Promise<void>;
}

/**
 * Finds transcript lines in `doc` that come after the last flushed content by
 * locating the tail of `flushed` inside `doc`. Returns null when no anchor matches.
 */
export function newLinesSince(flushed: string[], doc: string[]): string[] | null {
  let end = flushed.length;
  while (end > 0 && (flushed[end - 1] ?? '').trim() === '') end--;
  if (end === 0) return doc;
  for (const k of [6, 3, 1]) {
    const start = Math.max(0, end - k);
    const anchor = flushed.slice(start, end);
    if (anchor.length < k && k !== 1) continue;
    if (k === 1 && (anchor[0] ?? '').trim().length < 8) continue;
    for (let i = doc.length - anchor.length; i >= 0; i--) {
      let ok = true;
      for (let j = 0; j < anchor.length; j++) {
        if (doc[i + j] !== anchor[j]) { ok = false; break; }
      }
      if (ok) return doc.slice(i + anchor.length);
    }
  }
  return null;
}

/** Polls every tmux window, streams new transcript text, and reports pane state. */
export class Watcher {
  private st = new Map<string, WindowState>();
  private timer?: NodeJS.Timeout;
  private polling = false;

  constructor(
    private readonly cfg: Config,
    private readonly sessions: SessionManager,
    private readonly log: Logger,
    private readonly handlers: WatcherHandlers,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.poll(), this.cfg.outputPollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Call right after the relay itself sent input so its echo line is not streamed back. */
  suppressEcho(name: string): void {
    const s = this.state(name);
    s.echoUntil = Date.now() + ECHO_WINDOW_MS;
    s.echoBudget += 1;
  }

  /** Force a flush (e.g. on the Stop hook). */
  async flushNow(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (!session || session.state === 'dead') return;
    const s = this.state(name);
    await this.flush(session, s, s.lastDoc, 0);
  }

  forget(name: string): void {
    this.st.delete(name);
  }

  private state(name: string): WindowState {
    let s = this.st.get(name);
    if (!s) {
      s = { flushed: [], lastDoc: [], lastChangeAt: Date.now(), echoUntil: 0, echoBudget: 0, initialized: false };
      this.st.set(name, s);
    }
    return s;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const newlyDead = await this.sessions.refreshLiveness();
      for (const d of newlyDead) await this.handlers.onDead(d).catch((e) => this.log.error({ err: e }, 'onDead failed'));
      for (const session of this.sessions.list()) {
        if (session.state === 'dead') continue;
        await this.pollOne(session).catch((e) => this.log.warn({ err: e, session: session.name }, 'poll failed'));
      }
      for (const name of [...this.st.keys()]) if (!this.sessions.get(name)) this.st.delete(name);
    } finally {
      this.polling = false;
    }
  }

  private async pollOne(session: Session): Promise<void> {
    const raw = await tmux.capturePane(this.sessions.target(session.name), HISTORY_LINES);
    const analysis = analyzePane(raw);
    const s = this.state(session.name);
    const doc = analysis.content;
    const now = Date.now();
    if (!s.initialized) {
      // Never dump pre-existing history on (re)attach.
      s.flushed = doc;
      s.lastDoc = doc;
      s.initialized = true;
      s.lastChangeAt = now;
    } else if (!sameLines(doc, s.lastDoc)) {
      s.lastDoc = doc;
      s.lastChangeAt = now;
    }
    await this.handlers.onPane(session, analysis);

    const pending = newLinesSince(s.flushed, doc);
    const pendingChars = pending === null ? Infinity : pending.join('\n').length;
    if (pendingChars === 0) return;
    if (pendingChars >= SIZE_FLUSH_CHARS && doc.length > 2) {
      await this.flush(session, s, doc, 2);
    } else if (now - s.lastChangeAt >= QUIET_FLUSH_MS) {
      await this.flush(session, s, doc, 0);
    }
  }

  private async flush(session: Session, s: WindowState, doc: string[], keepTail: number): Promise<void> {
    const upto = doc.length - keepTail;
    if (upto <= 0) return;
    const slice = doc.slice(0, upto);
    let fresh = newLinesSince(s.flushed, slice);
    let resynced = false;
    if (fresh === null) {
      fresh = slice.slice(-RESYNC_TAIL);
      resynced = true;
      this.log.warn({ session: session.name }, 'watcher lost anchor; resyncing');
    }
    s.flushed = slice;
    if (Date.now() < s.echoUntil && s.echoBudget > 0) {
      const idx = fresh.findIndex((l) => /^❯\s+\S/.test(l));
      if (idx >= 0) {
        fresh = [...fresh.slice(0, idx), ...fresh.slice(idx + 1)];
        s.echoBudget -= 1;
      }
    }
    const text = cleanTranscript(fresh);
    if (!text) return;
    await this.handlers.onOutput(session, resynced ? `… (resynced)\n${text}` : text);
  }
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
