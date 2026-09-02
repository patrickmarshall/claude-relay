// CSI / OSC / simple escape sequences.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Telegram hard limit is 4096 chars of the *final* message; leave room for the prefix and <pre> tags. */
export const TG_CHUNK = 3800;

/** Splits already-escaped text on line boundaries so every chunk is <= max chars. Over-long lines are hard-split. */
export function chunkLines(text: string, max = TG_CHUNK): string[] {
  const chunks: string[] = [];
  let cur = '';
  const push = () => { if (cur.length) chunks.push(cur); cur = ''; };
  for (const rawLine of text.split('\n')) {
    let line = rawLine;
    while (line.length > max) {
      push();
      chunks.push(line.slice(0, max));
      line = line.slice(max);
    }
    const candidate = cur.length ? `${cur}\n${line}` : line;
    if (candidate.length > max) {
      push();
      cur = line;
    } else {
      cur = candidate;
    }
  }
  push();
  return chunks;
}

/** `[name]` + <pre> block(s), ready for parse_mode=HTML. */
export function formatOutput(session: string, text: string): string[] {
  return chunkLines(escapeHtml(text)).map((c) => `<b>[${escapeHtml(session)}]</b>\n<pre>${c}</pre>`);
}

const MAX_SUMMARY = 300;

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** One-line rendering of the key argument of a tool call. Full input goes to the audit log only. */
export function summarizeToolInput(tool: string, input: unknown): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  let s: string | undefined;
  const str = (k: string) => (typeof obj[k] === 'string' ? (obj[k] as string) : undefined);
  switch (tool) {
    case 'Bash': s = str('command'); break;
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': s = str('file_path') ?? str('notebook_path'); break;
    case 'Grep': case 'Glob': s = [str('pattern'), str('path')].filter(Boolean).join('  in '); break;
    case 'WebFetch': s = str('url'); break;
    case 'WebSearch': s = str('query'); break;
    case 'Agent': case 'Task': s = str('description') ?? str('prompt'); break;
    default: break;
  }
  if (s === undefined) {
    try { s = JSON.stringify(input); } catch { s = String(input); }
  }
  s = oneLine(s ?? '');
  return s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY - 1)}…` : s;
}

export function sanitizeFilename(name: string, fallback = 'file'): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  let clean = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (clean.length > 120) clean = clean.slice(-120);
  return clean || fallback;
}

export function timestampForFile(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function fmtAge(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${m % 60 ? `${m % 60}m` : ''}` : `${Math.floor(h / 24)}d`;
}

export function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}
