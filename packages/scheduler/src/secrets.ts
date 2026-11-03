import fs from 'fs';
import path from 'path';

/**
 * A secret the backend shares with this service: from .env if set there,
 * otherwise from the file the backend made in the data volume. The backend
 * starts first (compose waits for it), so the file is there by now.
 */
export function readSecret(key: string): string {
  const fromEnv = process.env[key];
  if (fromEnv && fromEnv.trim() && !fromEnv.startsWith('change-me')) return fromEnv;
  const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), '../backend/data/db.sqlite');
  const dir = process.env.HOMEHUB_SECRETS_DIR || path.join(path.dirname(dbPath), 'secrets');
  try {
    return fs.readFileSync(path.join(dir, key), 'utf8').trim();
  } catch {
    return '';
  }
}
