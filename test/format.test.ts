import { describe, expect, it } from 'vitest';
import { chunkLines, escapeHtml, formatOutput, formatPre, sanitizeFilename, stripAnsi, summarizeToolInput } from '../src/format.js';

describe('format', () => {
  it('strips ansi', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m \x1b]0;title\x07x')).toBe('red x');
  });
  it('escapes html', () => {
    expect(escapeHtml('<a & b>')).toBe('&lt;a &amp; b&gt;');
  });
  it('chunks on line boundaries and hard-splits long lines', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(100)}`);
    const chunks = chunkLines(lines.join('\n'), 1000);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunks.join('\n')).toBe(lines.join('\n'));
    const long = chunkLines('y'.repeat(2500), 1000);
    expect(long).toHaveLength(3);
  });
  it('formats output as plain text and tail as pre', () => {
    expect(formatOutput('app', 'a < b')[0]).toBe('<b>[app]</b>\na &lt; b');
    expect(formatPre('app', 'a < b')[0]).toBe('<b>[app]</b>\n<pre>a &lt; b</pre>');
  });
  it('summarises tool input', () => {
    expect(summarizeToolInput('Bash', { command: 'git   push\norigin' })).toBe('git push origin');
    expect(summarizeToolInput('Read', { file_path: '/x/y.ts' })).toBe('/x/y.ts');
    expect(summarizeToolInput('Grep', { pattern: 'foo', path: '/src' })).toBe('foo in /src');
    expect(summarizeToolInput('Other', { a: 1 })).toBe('{"a":1}');
    expect(summarizeToolInput('Bash', { command: 'x'.repeat(500) }).length).toBe(300);
  });
  it('sanitises filenames', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('my photo (1).PNG')).toBe('my_photo__1_.PNG');
    expect(sanitizeFilename('.hidden')).toBe('hidden');
    expect(sanitizeFilename('')).toBe('file');
  });
});
