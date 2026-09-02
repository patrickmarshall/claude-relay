import http from 'node:http';
import type { Logger } from './log.js';

export const MAX_BODY = 64 * 1024;

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  notification_type?: string;
  message?: string;
  prompt?: string;
  last_assistant_message?: string;
  [k: string]: unknown;
}

export interface HookEvent {
  /** Label passed by hook.sh (should equal payload.hook_event_name). */
  event: string;
  /** tmux `#S:#W` of the pane Claude Code is running in. */
  tmuxSession: string;
  window: string;
  payload: HookPayload;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Localhost-only listener for Claude Code hook payloads. Accepts POST /hook only. */
export function startHookServer(port: number, log: Logger, onEvent: (e: HookEvent) => void): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hook') {
      res.writeHead(404).end();
      return;
    }
    const len = Number(req.headers['content-length'] ?? 0);
    if (len > MAX_BODY) {
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const event = String(req.headers['x-relay-event'] ?? '');
      const win = String(req.headers['x-relay-window'] ?? '');
      const [tmuxSession, window] = win.split(':');
      if (!NAME_RE.test(event) || !tmuxSession || !window || !NAME_RE.test(tmuxSession) || !NAME_RE.test(window)) {
        res.writeHead(400).end();
        return;
      }
      let payload: HookPayload = {};
      const body = Buffer.concat(chunks).toString('utf8').trim();
      if (body) {
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed === 'object') payload = parsed as HookPayload;
        } catch {
          res.writeHead(400).end();
          return;
        }
      }
      res.writeHead(204).end();
      try {
        onEvent({ event, tmuxSession, window, payload });
      } catch (e) {
        log.error({ err: e }, 'hook handler threw');
      }
    });
  });
  server.keepAliveTimeout = 1000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      log.info({ port }, 'hook listener up on 127.0.0.1');
      resolve(server);
    });
  });
}
