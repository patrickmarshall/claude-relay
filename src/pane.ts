/**
 * Pure functions that interpret a captured Claude Code pane.
 * Everything that depends on the exact TUI rendering lives here so it can be
 * tuned in one place against docs/prompt-samples.md (Claude Code 2.1.216).
 */

export interface DialogInfo {
  /** Tool name parsed from the dialog title, if recognisable. */
  tool?: string;
  /** The dialog lines (title, arguments, question, options). */
  lines: string[];
}

export interface PaneAnalysis {
  /** Transcript lines above the input box / dialog, right-trimmed. */
  content: string[];
  /** Permission dialog currently displayed, if any. */
  dialog?: DialogInfo;
  /** Folder-trust dialog is displayed. */
  trustPrompt: boolean;
  /** Input box visible and nothing running. */
  idle: boolean;
  /** "esc to interrupt" (status line) or a spinner is visible. */
  working: boolean;
}

const SEPARATOR_RE = /^─{10,}\s*$/;
const BOX_TOP_RE = /^\s*╭─/;
const BOX_BOTTOM_RE = /^\s*╰─/;
const INPUT_RE = /^❯(\s|$)/;
/** Status line while a turn is running: "⏸ manual mode on · esc to interrupt · ← for agents". */
const WORKING_RE = /esc to interrupt/;
const STATUS_RE = /\? for shortcuts|for agents|·\s*\/effort\s*$|Auto-update failed|^\s*[⏸⏵]\s/;
/** "✻ Brewed for 0s", "✳ Generating…", "✽ Fiddle-faddling… (4s · ↓ 19 tokens)", "Running 1 shell command · 20s…" */
const SPINNER_RE = /^\s*[✻✶✳✢·✽∗*]\s+\S.*(\bfor \d+s\b|…)|^\s*Running \d+ .*…\s*$/;
const TIP_RE = /^\s*⎿\s+Tip:/;
const DIALOG_QUESTION_RE = /^\s*Do you want to (proceed|allow|make this edit|create|run|continue)/i;
const DIALOG_HINT_RE = /Esc to cancel|Tab to amend|ctrl\+e to explain/;
const DIALOG_OPTION_RE = /^\s*❯?\s*\d\.\s+(Yes|No|Allow|Deny)/;
const TRUST_RE = /Is this a project you created or one you trust|Yes, I trust this folder/;

/** Lines that are UI noise even inside the transcript area. */
export const NOISE_RES: RegExp[] = [SPINNER_RE, WORKING_RE, STATUS_RE, TIP_RE];

const WELCOME_BOX_RE = /Claude Code v|Tips for getting started|Welcome back|Accessing workspace/;

function rtrim(s: string): string {
  return s.replace(/\s+$/, '');
}

/** The dialog title is its first non-empty line, e.g. "Bash command", "Edit file", "Read file". */
export function parseDialogTool(lines: string[]): string | undefined {
  const title = lines.find((l) => l.trim() !== '')?.trim() ?? '';
  const m = title.match(/^(Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob|WebFetch|WebSearch|Agent|Task)\b/);
  if (m) return m[1];
  if (/^(Create|Write) file/i.test(title)) return 'Write';
  if (/^Edit file/i.test(title)) return 'Edit';
  if (/^Read file/i.test(title)) return 'Read';
  if (/^Fetch/i.test(title)) return 'WebFetch';
  if (/^Search/i.test(title)) return 'WebSearch';
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
  const tailStart = Math.max(0, end - 60);
  const tail = lines.slice(tailStart, end);
  const tailText = tail.join('\n');
  const trustPrompt = TRUST_RE.test(tailText);

  let chromeStart = -1;
  let dialog: DialogInfo | undefined;

  // 1. Permission dialog (unboxed): "<Tool> …" title, question, numbered options, hint line.
  //    It sits below a single separator and replaces the input box.
  const qIdx = tail.findIndex((l) => DIALOG_QUESTION_RE.test(l));
  const hasOptions = tail.some((l) => DIALOG_OPTION_RE.test(l));
  const hasHint = tail.some((l) => DIALOG_HINT_RE.test(l));
  if (!trustPrompt && qIdx >= 0 && (hasOptions || hasHint)) {
    let top = qIdx;
    while (top > 0 && !SEPARATOR_RE.test(tail[top - 1] ?? '') && qIdx - top < 30) top--;
    const sepIdx = top > 0 && SEPARATOR_RE.test(tail[top - 1] ?? '') ? top - 1 : top;
    let bottom = end - tailStart;
    for (let i = qIdx; i < tail.length; i++) if (DIALOG_HINT_RE.test(tail[i] ?? '')) { bottom = i + 1; break; }
    const body = tail.slice(top, bottom);
    dialog = { tool: parseDialogTool(body), lines: body };
    chromeStart = tailStart + sepIdx;
  }

  // 2. Input box: two separators with `❯` between them, status line below.
  let inputBox = false;
  if (!dialog) {
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
    if (chromeStart >= 0) inputBox = lines.slice(chromeStart + 1, end).some((l) => INPUT_RE.test(l));
  }

  // 3. Trust prompt (first start in a new cwd).
  if (trustPrompt && chromeStart < 0) {
    const idx = lines.findIndex((l) => /Accessing workspace/.test(l));
    chromeStart = idx >= 0 ? idx : Math.max(0, end - 20);
  }

  const chrome = chromeStart >= 0 ? lines.slice(chromeStart, end).join('\n') : '';
  const working = WORKING_RE.test(chrome) || (chromeStart >= 0 && SPINNER_RE.test(lines.slice(Math.max(0, chromeStart - 6), chromeStart).join('\n')) && !/\bfor \d+s\b/.test(lines.slice(Math.max(0, chromeStart - 6), chromeStart).join('\n')));
  const idle = inputBox && !working;

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
