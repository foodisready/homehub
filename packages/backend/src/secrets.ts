import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Secrets HomeHub makes for itself, so nobody has to generate and paste them
 * into .env. Each lives in its own file in the data volume's `secrets`
 * folder, made on first start and kept from then on. The scheduler, the MCP
 * server, Watchtower and the Wyze bridge read the same files.
 *
 * A value set in the environment (.env) always wins, so existing installs
 * keep the secrets they have. Values still set to the `change-me` examples
 * count as unset.
 */

export const MANAGED_SECRETS = [
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'INTERNAL_API_KEY',
  'MCP_SECRET',
  'WATCHTOWER_HTTP_API_TOKEN',
  'WYZE_BRIDGE_API_KEY',
] as const;
export type ManagedSecret = typeof MANAGED_SECRETS[number];

export const isSet = (value: string | undefined): value is string =>
  !!value && value.trim() !== '' && !value.startsWith('change-me');

export function secretsDir(): string {
  if (process.env.HOMEHUB_SECRETS_DIR) return process.env.HOMEHUB_SECRETS_DIR;
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'db.sqlite');
  return path.join(path.dirname(dbPath), 'secrets');
}

/**
 * The Wyze camera bridge runs with HomeHub unless HOMEHUB_CAMERA_BRIDGE=0 in
 * .env leaves it out. (Settings can also turn cameras off in HomeHub; the
 * bridge then stays running but idle.)
 */
export const cameraBridgeInstalled = (): boolean =>
  !/^(0|off|false|no)$/i.test((process.env.HOMEHUB_CAMERA_BRIDGE ?? '').trim());

/** The file's value, making it first if needed. Two processes starting at once both end up with the same value. */
function readOrCreate(dir: string, key: ManagedSecret): string {
  const file = path.join(dir, key);
  let empty = false;
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
    empty = true;   // an empty file never becomes an empty secret
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const value = crypto.randomBytes(32).toString('hex');
  try {
    // 0640: the scheduler and MCP server run as the same user; Watchtower and the bridge as root.
    // 'wx' fails if another process made the file meanwhile; then use theirs.
    fs.writeFileSync(file, value + '\n', { mode: 0o640, flag: empty ? 'w' : 'wx' });
    if (empty) fs.chmodSync(file, 0o640);
    return value;
  } catch (err) {
    const theirs = (err as NodeJS.ErrnoException).code === 'EEXIST' ? fs.readFileSync(file, 'utf8').trim() : '';
    if (theirs) return theirs;
    throw err;
  }
}

/**
 * Fill each managed secret into process.env from .env or its file. Must run
 * before any module that reads a secret when it loads (auth reads the JWT
 * secrets at import). Returns the names made on this start.
 */
export function loadSecrets(): { created: ManagedSecret[] } {
  const dir = secretsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  const created: ManagedSecret[] = [];
  for (const key of MANAGED_SECRETS) {
    if (isSet(process.env[key])) continue;
    const existed = fs.existsSync(path.join(dir, key));
    const value = readOrCreate(dir, key);
    if (!existed) created.push(key);
    // The bridge's key is made either way, so adding the bridge back later just works,
    // but HomeHub only uses it while the bridge is part of the install.
    if (key === 'WYZE_BRIDGE_API_KEY' && !cameraBridgeInstalled()) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
  return { created };
}
