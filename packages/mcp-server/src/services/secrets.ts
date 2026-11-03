import fs from 'fs';
import path from 'path';

/**
 * A secret shared with the HomeHub backend: from .env if set there,
 * otherwise from the file the backend made in its data volume (mounted
 * read-only here). Read on each use, so it's found even if this server
 * started first.
 */
export function readSecret(key: string): string {
  const fromEnv = process.env[key];
  if (fromEnv && fromEnv.trim() && !fromEnv.startsWith('change-me')) return fromEnv;
  const dir = process.env.HOMEHUB_SECRETS_DIR || path.resolve(process.cwd(), '../backend/data/secrets');
  try {
    return fs.readFileSync(path.join(dir, key), 'utf8').trim();
  } catch {
    return '';
  }
}
