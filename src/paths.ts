import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELAY_DIR = process.env.CLAUDE_RELAY_DIR ?? join(homedir(), '.claude-relay');
export const CONFIG_PATH = join(RELAY_DIR, 'config.json');
export const STATE_PATH = join(RELAY_DIR, 'state.json');
export const INBOX_DIR = join(RELAY_DIR, 'inbox');
export const LOG_DIR = join(RELAY_DIR, 'logs');
export const RELAY_LOG = join(LOG_DIR, 'relay.log');
export const PERMISSIONS_LOG = join(LOG_DIR, 'permissions.log');
/** Generated at boot; passed to `claude --settings` so hooks only exist in relay-launched sessions. */
export const HOOKS_SETTINGS_PATH = join(RELAY_DIR, 'claude-hooks.json');

/** Repo root: works from both src/ (tsx) and dist/ (compiled). */
export const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK_SCRIPT = join(REPO_DIR, 'scripts', 'hook.sh');
