import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { tmux, windowTarget } from '../src/tmux.js';

const S = `relay-vitest-${process.pid}`;

describe('tmux wrapper', () => {
  beforeAll(async () => {
    await tmux.newSession(S);
  });
  afterAll(async () => {
    await execa('tmux', ['kill-session', '-t', `=${S}`], { reject: false });
  });

  it('creates windows and lists them', async () => {
    expect(await tmux.hasSession(S)).toBe(true);
    await tmux.newWindow(S, 'w1', '/tmp', 'cat');
    const wins = await tmux.listWindows(S);
    expect(wins.map((w) => w.name)).toContain('w1');
    expect(await tmux.windowExists(S, 'w1')).toBe(true);
    expect(await tmux.windowExists(S, 'w')).toBe(false); // exact match, no prefix
  });

  it('sends literal text and captures it', async () => {
    const t = windowTarget(S, 'w1');
    await tmux.sendText(t, 'hello C-c Enter ; world');
    await tmux.sendKeys(t, 'Enter');
    await new Promise((r) => setTimeout(r, 300));
    const lines = await tmux.capturePane(t, 50);
    expect(lines.filter((l) => l === 'hello C-c Enter ; world')).toHaveLength(2); // typed + echoed by cat
  });

  it('pastes multi-line text as one block', async () => {
    const t = windowTarget(S, 'w1');
    await tmux.pasteText(t, 'line one\nline two');
    await tmux.sendKeys(t, 'Enter');
    await new Promise((r) => setTimeout(r, 300));
    const lines = (await tmux.capturePane(t, 50)).join('\n');
    expect(lines).toContain('line one');
    expect(lines).toContain('line two');
  });

  it('reports dead panes and kills windows', async () => {
    const t = windowTarget(S, 'w1');
    await tmux.sendKeys(t, 'C-c');
    await new Promise((r) => setTimeout(r, 800));
    expect((await tmux.paneInfo(t)).dead).toBe(true);
    await tmux.killWindow(t);
    expect(await tmux.windowExists(S, 'w1')).toBe(false);
  });
});
