import { mkdirSync } from 'node:fs';
import { pino, multistream, destination, type DestinationStream } from 'pino';
import { LOG_DIR, RELAY_LOG } from './paths.js';

mkdirSync(LOG_DIR, { recursive: true });

const streams: Array<{ stream: DestinationStream }> = [
  { stream: destination({ dest: RELAY_LOG, sync: true, mkdir: true }) },
];
if (process.stdout.isTTY || process.env.LOG_STDOUT) {
  streams.push({ stream: process.stdout });
}

export const log = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    // Belt and braces: the token must never reach a log line.
    redact: { paths: ['telegramToken', '*.telegramToken', 'token', '*.token'], censor: '[redacted]' },
  },
  multistream(streams),
);
export type Logger = typeof log;
