import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { CONFIG_PATH } from './paths.js';

export interface AutoAllowConfig {
  enabled: boolean;
  ttlSec: number;
  excludedTools: string[];
}

export interface Config {
  telegramToken: string;
  allowedUserIds: number[];
  claudeConfigDir: string;
  claudeBin: string;
  tmuxSession: string;
  hookPort: number;
  repos: Record<string, string>;
  permissionTimeoutSec: number;
  outputPollMs: number;
  inboxMaxBytes: number;
  autoAllow: AutoAllowConfig;
}

export const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;
const DEFAULT_EXCLUDED = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

export class ConfigError extends Error {}

function expandHome(p: string): string {
  return p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p === '~' ? homedir() : p;
}

function num(v: unknown, name: string, def: number, min = 1): number {
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) throw new ConfigError(`${name} must be a number >= ${min}`);
  return v;
}

export function parseRepos(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('repos must be an object of alias -> absolute path');
  const out: Record<string, string> = {};
  for (const [alias, p] of Object.entries(raw as Record<string, unknown>)) {
    if (!ALIAS_RE.test(alias)) throw new ConfigError(`repo alias "${alias}" must match ${ALIAS_RE}`);
    if (typeof p !== 'string') throw new ConfigError(`repos.${alias} must be a string path`);
    const abs = expandHome(p);
    if (!isAbsolute(abs)) throw new ConfigError(`repos.${alias} must be an absolute path`);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new ConfigError(`repos.${alias}: directory does not exist: ${abs}`);
    out[alias] = abs;
  }
  return out;
}

export function parseAutoAllow(raw: unknown): AutoAllowConfig {
  const a = (raw ?? {}) as Record<string, unknown>;
  const excluded = a.excludedTools === undefined ? DEFAULT_EXCLUDED : a.excludedTools;
  if (!Array.isArray(excluded) || !excluded.every((t) => typeof t === 'string')) throw new ConfigError('autoAllow.excludedTools must be a string array');
  return {
    enabled: a.enabled === true,
    ttlSec: num(a.ttlSec, 'autoAllow.ttlSec', 3600),
    // Always keep the hard-coded dangerous set excluded, whatever the file says.
    excludedTools: Array.from(new Set([...DEFAULT_EXCLUDED, ...(excluded as string[])])),
  };
}

function parse(raw: Record<string, unknown>): Config {
  if (typeof raw.telegramToken !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(raw.telegramToken)) {
    throw new ConfigError('telegramToken missing or malformed');
  }
  if (!Array.isArray(raw.allowedUserIds) || raw.allowedUserIds.length === 0 ||
      !raw.allowedUserIds.every((id) => Number.isInteger(id) && (id as number) > 0)) {
    throw new ConfigError('allowedUserIds must be a non-empty array of positive integers (numeric Telegram user IDs)');
  }
  if (typeof raw.claudeConfigDir !== 'string') throw new ConfigError('claudeConfigDir missing');
  const claudeConfigDir = expandHome(raw.claudeConfigDir);
  if (!existsSync(claudeConfigDir)) throw new ConfigError(`claudeConfigDir does not exist: ${claudeConfigDir}`);
  const tmuxSession = typeof raw.tmuxSession === 'string' && raw.tmuxSession ? raw.tmuxSession : 'claude-relay';
  if (!/^[A-Za-z0-9_-]+$/.test(tmuxSession)) throw new ConfigError('tmuxSession must be [A-Za-z0-9_-]');
  return {
    telegramToken: raw.telegramToken,
    allowedUserIds: raw.allowedUserIds as number[],
    claudeConfigDir,
    claudeBin: typeof raw.claudeBin === 'string' && raw.claudeBin ? expandHome(raw.claudeBin) : 'claude',
    tmuxSession,
    hookPort: num(raw.hookPort, 'hookPort', 48761, 1024),
    repos: parseRepos(raw.repos),
    permissionTimeoutSec: num(raw.permissionTimeoutSec, 'permissionTimeoutSec', 600, 10),
    outputPollMs: num(raw.outputPollMs, 'outputPollMs', 700, 200),
    inboxMaxBytes: num(raw.inboxMaxBytes, 'inboxMaxBytes', 20_000_000, 1),
    autoAllow: parseAutoAllow(raw.autoAllow),
  };
}

function readRaw(path: string): Record<string, unknown> {
  if (!existsSync(path)) throw new ConfigError(`config not found: ${path}`);
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new ConfigError(`${path} is group/world readable (mode ${mode.toString(8)}); run: chmod 600 ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`config is not valid JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object') throw new ConfigError('config must be a JSON object');
  return raw as Record<string, unknown>;
}

export function loadConfig(path = CONFIG_PATH): Config {
  return parse(readRaw(path));
}

/** `/reload`: only repos and autoAllow are re-read. Token and allowlist never change at runtime. */
export function reloadConfig(cfg: Config, path = CONFIG_PATH): { repos: string[]; autoAllow: AutoAllowConfig } {
  const raw = readRaw(path);
  const repos = parseRepos(raw.repos);
  const autoAllow = parseAutoAllow(raw.autoAllow);
  cfg.repos = repos;
  cfg.autoAllow = autoAllow;
  return { repos: Object.keys(repos), autoAllow };
}
