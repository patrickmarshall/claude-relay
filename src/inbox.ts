import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Telegram } from 'telegraf';
import type { Config } from './config.js';
import { sanitizeFilename, timestampForFile } from './format.js';
import { INBOX_DIR } from './paths.js';
import { NAME_RE } from './sessions.js';

export class InboxError extends Error {}

export interface InboxEntry { name: string; size: number; mtime: number }

export class Inbox {
  constructor(private readonly cfg: Config, private readonly telegram: Telegram) {}

  dir(session: string): string {
    if (!NAME_RE.test(session)) throw new InboxError('bad session name');
    return join(INBOX_DIR, session);
  }

  /** Downloads a Telegram file into the session inbox. Never trusts caller-supplied paths. */
  async save(session: string, fileId: string, declaredSize: number | undefined, originalName: string | undefined): Promise<string> {
    if (declaredSize !== undefined && declaredSize > this.cfg.inboxMaxBytes) {
      throw new InboxError(`file too large (${declaredSize} > ${this.cfg.inboxMaxBytes} bytes)`);
    }
    const link = await this.telegram.getFileLink(fileId);
    const res = await fetch(link.href);
    if (!res.ok) throw new InboxError(`Telegram refused download (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > this.cfg.inboxMaxBytes) throw new InboxError('file too large');
    const dir = this.dir(session);
    mkdirSync(dir, { recursive: true });
    const name = `${timestampForFile()}-${sanitizeFilename(originalName ?? 'file', 'file')}`;
    const path = join(dir, name);
    writeFileSync(path, buf, { mode: 0o600 });
    return path;
  }

  list(session: string): InboxEntry[] {
    const dir = this.dir(session);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .map((name) => {
        const st = statSync(join(dir, name));
        return { name, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);
  }

  clear(session: string): number {
    const entries = this.list(session);
    rmSync(this.dir(session), { recursive: true, force: true });
    return entries.length;
  }
}
