import { describe, expect, it } from 'vitest';
import { analyzePane, cleanTranscript } from '../src/pane.js';
import { newLinesSince } from '../src/watcher.js';

const SEP = '─'.repeat(120);

describe('analyzePane', () => {
  it('detects idle input box and strips chrome', () => {
    const lines = ['❯ hello', '', '⏺ Hi there!', '', '✻ Brewed for 3s', '', SEP, '❯ ', SEP, '  ⏸ manual mode on · ? for shortcuts · ← for agents', ''];
    const a = analyzePane(lines);
    expect(a.idle).toBe(true);
    expect(a.working).toBe(false);
    expect(a.content).toEqual(['❯ hello', '', '⏺ Hi there!']);
  });
  it('detects working', () => {
    const lines = ['⏺ working', '✻ Thinking… (4s · ↓ 120 tokens · esc to interrupt)', SEP, '❯ ', SEP, '  ? for shortcuts'];
    const a = analyzePane(lines);
    expect(a.working).toBe(true);
    expect(a.idle).toBe(false);
    expect(a.content).toEqual(['⏺ working']);
  });
  it('detects trust prompt', () => {
    const a = analyzePane([' Accessing workspace:', ' /x', ' Quick safety check: Is this a project you created or one you trust?', ' ❯ 1. Yes, I trust this folder', '   2. No, exit']);
    expect(a.trustPrompt).toBe(true);
    expect(a.dialog).toBeUndefined();
  });
  it('detects a boxed permission dialog', () => {
    const lines = ['⏺ Bash(touch x)', '╭' + '─'.repeat(60) + '╮', '│ Bash command' + ' '.repeat(47) + '│', '│ touch x' + ' '.repeat(52) + '│', '│ Do you want to proceed?' + ' '.repeat(36) + '│', '│ ❯ 1. Yes' + ' '.repeat(50) + '│', '│   2. No' + ' '.repeat(51) + '│', '╰' + '─'.repeat(60) + '╯'];
    const a = analyzePane(lines);
    expect(a.dialog?.tool).toBe('Bash');
    expect(a.content).toEqual(['⏺ Bash(touch x)']);
  });
  it('drops the welcome box', () => {
    const a = analyzePane(['╭───╮', '│ Claude Code v2 │', '╰───╯', '', '⏺ hi', SEP, '❯ ', SEP]);
    expect(a.content).toEqual(['⏺ hi']);
  });
});

describe('cleanTranscript', () => {
  it('removes noise and collapses blanks', () => {
    expect(cleanTranscript(['a', '', '', '✻ Brewed for 1s', '', 'b', ''])).toBe('a\n\nb');
  });
});

describe('newLinesSince', () => {
  it('returns lines after the anchor', () => {
    const flushed = ['1', '2', '3', '4', '5', '6', '7', ''];
    const doc = ['2', '3', '4', '5', '6', '7', '', '8', '9'];
    expect(newLinesSince(flushed, doc)).toEqual(['', '8', '9']);
  });
  it('falls back to shorter anchors', () => {
    const flushed = ['a', 'b', 'c', 'd', 'e', 'f', 'a long enough line'];
    const doc = ['zzz', 'a long enough line', 'new'];
    expect(newLinesSince(flushed, doc)).toEqual(['new']);
  });
  it('returns null when nothing matches', () => {
    expect(newLinesSince(['some long line here'], ['other'])).toBeNull();
  });
  it('returns whole doc when nothing flushed', () => {
    expect(newLinesSince([], ['x'])).toEqual(['x']);
  });
});
