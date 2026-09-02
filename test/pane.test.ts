import { describe, expect, it } from 'vitest';
import { analyzePane, cleanTranscript } from '../src/pane.js';
import { newLinesSince } from '../src/watcher.js';

const SEP = '─'.repeat(120);
const STATUS_IDLE = '  ⏸ manual mode on · ? for shortcuts · ← for agents';
const STATUS_WORKING = '  ⏸ manual mode on · esc to interrupt · ← for agents';

describe('analyzePane', () => {
  it('detects idle input box and strips chrome', () => {
    const lines = ['❯ hello', '', '⏺ Hi there!', '', '✻ Brewed for 3s', '', SEP, '❯ ', SEP, STATUS_IDLE, ''];
    const a = analyzePane(lines);
    expect(a.idle).toBe(true);
    expect(a.working).toBe(false);
    expect(a.content).toEqual(['❯ hello', '', '⏺ Hi there!']);
  });
  it('treats a greyed suggestion in the input box as idle', () => {
    const a = analyzePane(['⏺ pong', SEP, '❯ yes, create hello.txt', SEP, STATUS_IDLE]);
    expect(a.idle).toBe(true);
    expect(a.content).toEqual(['⏺ pong']);
  });
  it('detects working from the status line and hides spinner, tip and effort lines', () => {
    const lines = ['❯ Yes, run: touch hello.txt', '', '  Running 1 shell command · 20s…', '  ⎿  $ touch hello.txt', '', '✽ Fiddle-faddling… (4s · ↓ 19 tokens)', '  ⎿  Tip: Ask Claude to create subagents', ' '.repeat(100) + '● high · /effort', SEP, '❯ ', SEP, STATUS_WORKING];
    const a = analyzePane(lines);
    expect(a.working).toBe(true);
    expect(a.idle).toBe(false);
    expect(a.dialog).toBeUndefined();
    expect(a.content).toEqual(['❯ Yes, run: touch hello.txt', '', '  Running 1 shell command · 20s…', '  ⎿  $ touch hello.txt']);
  });
  it('detects trust prompt', () => {
    const a = analyzePane([' Accessing workspace:', ' /x', ' Quick safety check: Is this a project you created or one you trust?', ' ❯ 1. Yes, I trust this folder', '   2. No, exit']);
    expect(a.trustPrompt).toBe(true);
    expect(a.dialog).toBeUndefined();
  });
  it('detects the real unboxed Bash permission dialog', () => {
    const lines = [
      '❯ Yes, run: touch hello.txt', '', '  Running 1 shell command…', '  ⎿  $ touch hello.txt', '',
      SEP, ' Bash command', '', '   touch hello.txt', '   Create empty hello.txt file', '', ' Do you want to proceed?',
      ' ❯ 1. Yes', '   2. Yes, and always allow access to repo/ from this project', '   3. No', '', ' Esc to cancel · Tab to amend · ctrl+e to explain',
    ];
    const a = analyzePane(lines);
    expect(a.dialog?.tool).toBe('Bash');
    expect(a.dialog?.lines[0]).toBe(' Bash command');
    expect(a.idle).toBe(false);
    expect(a.content).toEqual(['❯ Yes, run: touch hello.txt', '', '  Running 1 shell command…', '  ⎿  $ touch hello.txt']);
  });
  it('drops the welcome box', () => {
    const a = analyzePane(['╭───╮', '│ Claude Code v2 │', '╰───╯', '', '⏺ hi', SEP, '❯ ', SEP, STATUS_IDLE]);
    expect(a.content).toEqual(['⏺ hi']);
  });
});

describe('cleanTranscript', () => {
  it('removes noise and collapses blanks', () => {
    expect(cleanTranscript(['a', '', '', '✻ Brewed for 1s', '', 'b', '  ⎿  Tip: x', ''])).toBe('a\n\nb');
  });
  it('drops box drawing and flattens table rows', () => {
    const lines = ['  ┌──────────┬──────────┐', '  │ Image    │ image, imageURL │', '  ├──────────┼──────────┤', '  │ Sizing   │ Fixed width │', '  └──────────┴──────────┘'];
    expect(cleanTranscript(lines)).toBe('Image | image, imageURL\nSizing | Fixed width');
  });
});

describe('newLinesSince', () => {
  it('returns lines after the anchor', () => {
    const flushed = ['line one', 'line two', 'line three', ''];
    const doc = ['line two', 'line three', '', 'line four', 'line five'];
    expect(newLinesSince(flushed, doc)).toEqual(['line four', 'line five']);
  });
  it('falls back to earlier anchors', () => {
    const flushed = ['a', 'b', 'c', 'd', 'e', 'f', 'a long enough line'];
    const doc = ['zzz', 'a long enough line', 'new'];
    expect(newLinesSince(flushed, doc)).toEqual(['new']);
  });
  it('survives rewritten transient lines and skips unchanged ones', () => {
    const flushed = ['❯ Yes, run: touch hello.txt', '', '  Running 1 shell command · 20s…', '  ⎿  $ touch hello.txt'];
    const doc = ['❯ Yes, run: touch hello.txt', '', '  Ran 1 shell command', '', '⏺ Done — created hello.txt.'];
    expect(newLinesSince(flushed, doc)).toEqual(['  Ran 1 shell command', '', '⏺ Done — created hello.txt.']);
    const doc2 = ['❯ Yes, run: touch hello.txt', '', '  Running 1 shell command · 20s…', '  ⎿  $ touch hello.txt', '', 'more'];
    expect(newLinesSince(flushed, doc2)).toEqual(['', 'more']);
  });
  it('returns null when nothing matches', () => {
    expect(newLinesSince(['some long line here'], ['other'])).toBeNull();
  });
  it('returns whole doc when nothing flushed', () => {
    expect(newLinesSince([], ['x'])).toEqual(['x']);
  });
});
