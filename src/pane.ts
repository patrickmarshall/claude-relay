/**
 * Pure functions that interpret a captured Claude Code pane.
 * Everything that depends on the exact TUI rendering lives here so it can be
 * tuned in one place against docs/prompt-samples.md.
 */

export interface DialogInfo {
  /** Tool name parsed from the dialog title, if recognisable. */
  tool?: string;
  /** The dialog body lines (without borders). */
  lines: string[];
}

export interface PaneAnalysis {
  /** Transcript lines above the input box / dialog, right-trimmed. */
  content: string[];
  /** Permission dialog currently displayed, if any. */
  dialog?: DialogInfo;
  /** Folder-trust dialog is displayed. */
  trustPrompt: boolean;
  /** Empty input box visible and nothing running. */
  idle: boolean;
  /** A spinner / "esc to interrupt" hint is visible. */
  working: boolean;
}

const SEPARATOR_RE = /^─{10,}\s*$/;
const BOX_TOP_RE = /^\s*╭─/;
const BOX_BOTTOM_RE = /^\s*╰─/;
const INPUT_RE = /^❯(\s|$)/;
const WORKING_RE = /esc to interrupt|\(\d+s\s*·/;
const STATUS_RE = /\? for shortcuts|for agents|·\s*\/effort\s*$|Auto-update failed|^\s*[⏸⏵⏵⏸]\s/;
const SPINNER_RE = /^\s*[✻✶✳✢·✽∗*]\s+\S.*(\bfor \d+s\b|…|\(\d+s)/;
const PERMISSION_DIALOG_RE = /Do you want to (proceed|allow|make this edit|create|run)|Yes, and don't ask again|❯\s*1\.\s*Yes|Allow (once|always)/i;
const TRUST_RE = /Is this a project you created or one you trust|Yes, I trust this folder/;

/** Lines that are UI noise even inside the transcript area. */
export const NOISE_RES: RegExp[] = [SPINNER_RE, WORKING_RE, STATUS_RE];

const WELCOME_BOX_RE = /Claude Code v|Tips for getting started|Welcome back|Accessing workspace/;

function rtrim(s: string): string {
  return s.replace(/\s+$/, '');
}

function parseDialogTool(lines: string[]): string | undefined {
  const head = lines.slice(0, 3).join(' ');
  const m = head.match(/\b(Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob|WebFetch|WebSearch|Agent|Task)\b/);
  if (m) return m[1];
  if (/Create file|Write file/i.test(head)) return 'Write';
  if (/Edit file/i.test(head)) return 'Edit';
  if (/Fetch/i.test(head)) return 'WebFetch';
  return undefined;
}

/** Removes bordered boxes (╭…╰) whose body matches `pred`. */
export function dropBoxes(lines: string[], pred: (body: string) => boolean): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (BOX_TOP_RE.test(lines[i] ?? '')) {
      let j = i + 1;
      while (j < lines.length && !BOX_BOTTOM_RE.test(lines[j] ?? '') && j - i < 60) j++;
      if (j < lines.length && BOX_BOTTOM_RE.test(lines[j] ?? '')) {
        const body = lines.slice(i, j + 1).join('\n');
        if (!pred(body)) out.push(...lines.slice(i, j + 1));
        i = j + 1;
        continue;
      }
    }
    out.push(lines[i] ?? '');
    i++;
  }
  return out;
}

export function analyzePane(rawLines: string[]): PaneAnalysis {
  const lines = rawLines.map(rtrim);
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') end--;
  const tail = lines.slice(Math.max(0, end - 60), end);
  const tailText = tail.join('\n');
  const working = WORKING_RE.test(tailText);
  const trustPrompt = TRUST_RE.test(tailText);

  // 1. Input box: two separators, `❯` between them, status line(s) below.
  let chromeStart = -1;
  let idle = false;
  for (let i = end - 1, seps = 0; i >= Math.max(0, end - 40); i--) {
    const l = lines[i] ?? '';
    if (SEPARATOR_RE.test(l)) {
      seps++;
      if (seps === 2) {
        chromeStart = i;
        break;
      }
    }
  }
  if (chromeStart >= 0) {
    const inputLines = lines.slice(chromeStart + 1, end).filter((l) => INPUT_RE.test(l));
    idle = !working && inputLines.some((l) => /^❯\s*$/.test(l));
  }

  // 2. Permission dialog: a bordered box at the bottom, no input box.
  let dialog: DialogInfo | undefined;
  for (let i = end - 1; i >= Math.max(0, end - 40); i--) {
    if (!BOX_BOTTOM_RE.test(lines[i] ?? '')) continue;
    let top = i - 1;
    while (top >= 0 && !BOX_TOP_RE.test(lines[top] ?? '') && i - top < 60) top--;
    if (top < 0 || !BOX_TOP_RE.test(lines[top] ?? '')) break;
    const body = lines.slice(top + 1, i).map((l) => l.replace(/^\s*│\s?/, '').replace(/\s*│\s*$/, ''));
    const bodyText = body.join('\n');
    if (PERMISSION_DIALOG_RE.test(bodyText) && !TRUST_RE.test(bodyText)) {
      dialog = { tool: parseDialogTool(body), lines: body };
      if (chromeStart < 0 || top < chromeStart) chromeStart = top;
    }
    break;
  }
  // Some dialogs are not boxed: fall back to text markers in the tail.
  if (!dialog && !trustPrompt && PERMISSION_DIALOG_RE.test(tailText)) {
    const idx = tail.findIndex((l) => /Do you want to|❯\s*1\./.test(l));
    const start = Math.max(0, end - 60 + Math.max(0, idx - 12));
    dialog = { tool: parseDialogTool(tail.slice(Math.max(0, idx - 12))), lines: lines.slice(start, end) };
    if (chromeStart < 0 || start < chromeStart) chromeStart = start;
  }
  if (trustPrompt && chromeStart < 0) {
    const idx = lines.findIndex((l) => /Accessing workspace/.test(l));
    chromeStart = idx >= 0 ? idx : Math.max(0, end - 20);
  }

  let content = lines.slice(0, chromeStart >= 0 ? chromeStart : end);
  // Trailing spinner / hint lines just above the chrome are not transcript.
  while (content.length && (content[content.length - 1] === '' || NOISE_RES.some((re) => re.test(content[content.length - 1] ?? '')))) content.pop();
  content = dropBoxes(content, (body) => WELCOME_BOX_RE.test(body));
  while (content.length && content[0] === '') content.shift();
  return { content, dialog, trustPrompt, idle, working };
}

/** Transcript lines → text for Telegram: noise removed, blank runs collapsed. */
export function cleanTranscript(lines: string[]): string {
  const out: string[] = [];
  for (const raw of lines) {
    const l = rtrim(raw);
    if (NOISE_RES.some((re) => re.test(l))) continue;
    if (l === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(l);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
