import { execa } from 'execa';

const TMUX_BIN = process.env.TMUX_BIN ?? 'tmux';
const BUFFER_NAME = 'claude-relay';

export class TmuxError extends Error {
  constructor(message: string, public readonly args: string[]) {
    super(message);
  }
}

export interface WindowInfo {
  id: string;
  name: string;
  dead: boolean;
  command: string;
}

export interface PaneInfo {
  dead: boolean;
  command: string;
}

async function run(args: string[], input?: string): Promise<string> {
  const r = await execa(TMUX_BIN, args, { reject: false, input, stripFinalNewline: true });
  if (r.exitCode !== 0) throw new TmuxError(`tmux ${args[0]} failed: ${r.stderr || r.stdout || `exit ${r.exitCode}`}`, args);
  return r.stdout;
}

/** Exact-match target for a window inside a session (`=` prevents prefix matching). */
export function windowTarget(session: string, window: string): string {
  return `=${session}:=${window}`;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const tmux = {
  async hasSession(session: string): Promise<boolean> {
    const r = await execa(TMUX_BIN, ['has-session', '-t', `=${session}`], { reject: false });
    return r.exitCode === 0;
  },

  /** Creates a detached session with a placeholder window so the session is never empty. */
  async newSession(session: string): Promise<void> {
    await run(['new-session', '-d', '-s', session, '-n', '_relay', '-x', '160', '-y', '50']);
  },

  async listWindows(session: string): Promise<WindowInfo[]> {
    const out = await run(['list-windows', '-t', `=${session}`, '-F', '#{window_id}|#{window_name}|#{pane_dead}|#{pane_current_command}']);
    if (!out) return [];
    return out.split('\n').map((line) => {
      const [id, name, dead, command] = line.split('|');
      return { id: id ?? '', name: name ?? '', dead: dead === '1', command: command ?? '' };
    });
  },

  async windowExists(session: string, window: string): Promise<boolean> {
    return (await this.listWindows(session)).some((w) => w.name === window);
  },

  /**
   * Creates a window that runs `command` directly (no interactive shell in front of it).
   * `remain-on-exit` is on so a crashed claude leaves its last screen for /tail.
   */
  async newWindow(session: string, window: string, cwd: string, command: string): Promise<void> {
    await run(['new-window', '-d', '-t', `=${session}`, '-n', window, '-c', cwd, command]);
    const t = windowTarget(session, window);
    await run(['set-option', '-w', '-t', t, 'allow-rename', 'off']);
    await run(['set-option', '-w', '-t', t, 'automatic-rename', 'off']);
    await run(['set-option', '-w', '-t', t, 'remain-on-exit', 'on']);
  },

  async killWindow(target: string): Promise<void> {
    await run(['kill-window', '-t', target]);
  },

  async paneInfo(target: string): Promise<PaneInfo> {
    const out = await run(['display-message', '-p', '-t', target, '#{pane_dead}|#{pane_current_command}']);
    const [dead, command] = out.split('|');
    return { dead: dead === '1', command: command ?? '' };
  },

  /** Literal text: nothing is interpreted as a key name. Single line only (callers strip newlines). */
  async sendText(target: string, text: string): Promise<void> {
    if (text.length === 0) return;
    await run(['send-keys', '-t', target, '-l', '--', text]);
  },

  /** Named keys, e.g. 'Enter', 'Escape', 'C-c', 'Down'. */
  async sendKeys(target: string, ...keys: string[]): Promise<void> {
    await run(['send-keys', '-t', target, '--', ...keys]);
  },

  /** Multi-line text via bracketed paste so the TUI treats it as one pasted block, not N submits. */
  async pasteText(target: string, text: string): Promise<void> {
    await run(['load-buffer', '-b', BUFFER_NAME, '-'], text);
    await run(['paste-buffer', '-p', '-d', '-b', BUFFER_NAME, '-t', target]);
  },

  /** Visible pane plus `historyLines` of scrollback, wrapped lines joined. No escape sequences. */
  async capturePane(target: string, historyLines = 0): Promise<string[]> {
    const args = ['capture-pane', '-p', '-J', '-t', target];
    if (historyLines > 0) args.push('-S', `-${historyLines}`);
    const out = await run(args);
    return out.split('\n');
  },
};
export type Tmux = typeof tmux;
