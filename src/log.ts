import { mkdirSync } from 'node:fs';
import { pino, multistream, destination, type DestinationStream } from 'pino';
import { LOG_DIR, RELAY_LOG } from './paths.js';

mkdirSync(LOG_DIR, { recursive: true });

const LEVEL = process.env.LOG_LEVEL ?? 'info';
const streams: Array<{ stream: DestinationStream; level: string }> = [
  { stream: destination({ dest: RELAY_LOG, sync: true, mkdir: true }), level: LEVEL },
];
if (process.stdout.isTTY || process.env.LOG_STDOUT) {
  streams.push({ stream: process.stdout, level: LEVEL });
}

export const log = pino(
  {
    level: LEVEL,
    // Belt and braces: the token must never reach a log line.
    redact: { paths: ['telegramToken', '*.telegramToken', 'token', '*.token'], censor: '[redacted]' },
  },
  multistream(streams),
);
export type Logger = typeof log;
