import crypto from 'crypto';
import { getDb } from './index';
import { BackupError } from './backup-error';
import { HIDDEN, applyBackup, parseBackup, snapshot } from './json-backup';
import { serverRole } from '../system/role';
import { otherAnswering } from '../discovery/local-name';
import { logger } from '../logger';

/**
 * Keeps a backup HomeHub's copy of the home up to date with the active one.
 *
 * The two are paired once: the active HomeHub makes a pairing code, and it's
 * typed into the backup. From then on the backup asks the active one for its
 * settings every hour, on the home network, and restores them if anything
 * changed. Only a backup fetches, and only an active HomeHub hands its settings
 * out, so an active HomeHub is never overwritten.
 *
 * The copy is the same as a JSON backup and is restored the same way: accounts
 * already on the backup keep their passwords; things a backup leaves out (Matter
 * pairings, the Wyze sign-in, energy history) stay as they are. If the active
 * HomeHub can't be reached, or hands out an empty home, the backup keeps the
 * copy it has.
 *
 * Both sides keep their part in `settings`, under keys that never travel in a
 * backup (json-backup's THIS_HOMEHUB_ONLY).
 */

/** On the active HomeHub: a hash of the pairing code, when it was made, and the last time a backup fetched. */
export const SERVE_KEY = 'backup_sync_serve';
/** On the backup: the pairing code, where the active HomeHub is, and how the last sync went. */
export const FOLLOW_KEY = 'backup_sync_follow';

export const SYNC_EVERY_MS = 60 * 60 * 1000;
const FIRST_SYNC_MS = 2 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
/** A pairing code: 20 letters and digits, without ones easily confused (0/O, 1/I/L, U/V). */
const ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ23456789';
const CODE_LENGTH = 20;
/** Wrong codes allowed in a row before the active HomeHub stops answering for a while. */
const MAX_FAILURES = 10;
const LOCKOUT_MS = 10 * 60 * 1000;

interface ServeState { hash: string; pairedAt: string; last: { at: string; address: string } | null }
export interface FollowState {
  code: string;
  /** Where the active HomeHub was last reached: an IP address, with :port if not HomeHub's usual one. */
  address: string;
  pairedAt: string;
  checkedAt: string | null;
  copiedAt: string | null;
  error: string | null;
  /** The settings last copied, to tell when nothing has changed. */
  hash: string | null;
}

function read<T>(key: string): T | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.value) as T; } catch { return null; }
}
function write(key: string, value: unknown): void {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}
function remove(key: string): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
}

/** Uppercase, without spaces or dashes, so a code can be typed however it's grouped. */
export const normaliseCode = (code: string): string => code.toUpperCase().replace(/[\s-]/g, '');
const hashCode = (code: string): string => crypto.createHash('sha256').update(normaliseCode(code)).digest('hex');
const group = (code: string): string => code.match(/.{1,4}/g)!.join('-');

// ── The active HomeHub ──────────────────────────────────────────────

/** A new pairing code, replacing any earlier one: the backup that had it stops syncing. Shown once. */
export function makePairingCode(): { code: string } {
  if (serverRole() !== 'active') throw new BackupError('Only the active HomeHub makes pairing codes. Enter the code on the backup.', 409);
  const bytes = crypto.randomBytes(CODE_LENGTH);
  const code = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  write(SERVE_KEY, { hash: hashCode(code), pairedAt: new Date().toISOString(), last: null } satisfies ServeState);
  logger.info('Backup sync: new pairing code made');
  return { code: group(code) };
}

export function unpair(): void {
  remove(SERVE_KEY);
  logger.info('Backup sync: pairing removed');
}

let failures = 0;
let lockedUntil = 0;

/** For tests. */
export function resetLockout(): void { failures = 0; lockedUntil = 0; }

/**
 * The active HomeHub's settings for its paired backup, or why not. `key` is the
 * code from the request's Authorization header; `from` is who asked.
 */
export function serveSnapshot(key: string | undefined, from: string, now = Date.now()): { status: number; body: unknown } {
  if (now < lockedUntil) return { status: 429, body: { error: 'Too many wrong pairing codes. Try again in a few minutes.' } };
  const state = read<ServeState>(SERVE_KEY);
  const given = Buffer.from(hashCode(key ?? ''), 'hex');
  const ok = !!state && !!key && crypto.timingSafeEqual(given, Buffer.from(state.hash, 'hex'));
  if (!ok) {
    if (++failures >= MAX_FAILURES) {
      lockedUntil = now + LOCKOUT_MS;
      failures = 0;
      logger.warn({ from }, 'Backup sync: too many wrong pairing codes; not answering for 10 minutes');
    }
    return { status: 401, body: { error: 'Wrong pairing code', code: 'BAD_PAIRING_CODE' } };
  }
  failures = 0;
  if (serverRole() !== 'active') {
    return { status: 409, body: { error: "This HomeHub isn't the active one", code: 'NOT_ACTIVE' } };
  }
  write(SERVE_KEY, { ...state!, last: { at: new Date(now).toISOString(), address: from } } satisfies ServeState);
  return { status: 200, body: snapshot('Copied to the backup HomeHub') };
}

// ── The backup ──────────────────────────────────────────────────────

export type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number; text(): Promise<string>;
}>;

const defaultPort = (): string => process.env.PORT || '3000';

function urlFor(address: string): string {
  const withPort = /:\d+$/.test(address) ? address : `${address}:${defaultPort()}`;
  return `http://${withPort}/sync/snapshot`;
}

/** Where the active HomeHub is now: as seen answering for homehub.local, or where it was last reached. */
function activeAddress(saved: string): string {
  return otherAnswering()?.address ?? saved;
}

let running: Promise<FollowState | null> | null = null;

/**
 * Fetch the active HomeHub's settings and restore them here if they changed.
 * Only on a backup that's been paired. Never throws: the outcome is kept in the
 * follow state, which is returned.
 */
export function syncNow(fetcher: Fetcher = fetch as unknown as Fetcher): Promise<FollowState | null> {
  if (!running) running = sync(fetcher).finally(() => { running = null; });
  return running;
}

async function sync(fetcher: Fetcher): Promise<FollowState | null> {
  const state = read<FollowState>(FOLLOW_KEY);
  if (!state || serverRole() !== 'backup') return state;
  const address = activeAddress(state.address);
  const done = (patch: Partial<FollowState>): FollowState => {
    const next = { ...state, ...patch, checkedAt: new Date().toISOString() };
    write(FOLLOW_KEY, next);
    return next;
  };

  let text: string;
  try {
    const res = await fetcher(urlFor(address), {
      headers: { Authorization: `Bearer ${normaliseCode(state.code)}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    text = await res.text();
    if (res.status === 401) {
      return done({ error: "The active HomeHub didn't accept the pairing code. Make a new code on it and enter it here." });
    }
    if (res.status === 409) {
      return done({ error: `The HomeHub at ${address} isn't the active one any more. Pair this backup with the active HomeHub.` });
    }
    if (res.status === 429) return done({ error: 'The active HomeHub is refusing for a few minutes after wrong pairing codes.' });
    if (res.status !== 200) return done({ error: `The active HomeHub answered with an error (${res.status}).` });
  } catch (err) {
    logger.info({ err: (err as Error).message, address }, 'Backup sync: active HomeHub not reachable');
    return done({ error: `Can't reach the active HomeHub at ${address}. This HomeHub keeps the copy it has.` });
  }

  try {
    const data = parseBackup(text);
    if (text.includes(JSON.stringify(HIDDEN))) throw new BackupError('The copy has hidden passwords in it');
    const hash = crypto.createHash('sha256').update(JSON.stringify(data.tables)).digest('hex');
    if (hash === state.hash) return done({ address, error: null });
    const here = (getDb().prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n;
    if ((data.tables.devices ?? []).length === 0 && here > 0) {
      return done({ address, error: 'The active HomeHub has no devices, so its copy was not taken. If that is right, restore a backup here by hand.' });
    }
    const result = applyBackup(data);
    logger.info({ address, counts: result.counts, accountsAdded: result.accounts.added }, 'Backup sync: copied the active HomeHub');
    onCopied();
    return done({ address, hash, copiedAt: new Date().toISOString(), error: null });
  } catch (err) {
    logger.warn({ err, address }, 'Backup sync: copy not restored');
    return done({ address, error: `The active HomeHub's copy couldn't be restored: ${(err as Error).message}` });
  }
}

/** What happens after a copy is restored: set by the app, so this module stays free of the scheduler and device polling. */
let onCopied: () => void = () => undefined;
export function whenCopied(fn: () => void): void { onCopied = fn; }

/** Pair this backup with the active HomeHub and copy it straight away. Throws if that first copy fails. */
export async function follow(code: string, address?: string, fetcher?: Fetcher): Promise<FollowState | null> {
  if (serverRole() !== 'backup') {
    throw new BackupError('Only a backup HomeHub copies from the active one. Make this HomeHub a backup first, in Settings → Preferences → This server.', 409);
  }
  const clean = normaliseCode(code ?? '');
  if (clean.length !== CODE_LENGTH || [...clean].some((c) => !ALPHABET.includes(c))) {
    throw new BackupError(`A pairing code is ${CODE_LENGTH} letters and digits, like ABCD-EFGH-JKMN-PQRS-TWXY`);
  }
  const typed = address?.trim();
  if (typed && !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(typed)) throw new BackupError('The address should look like 192.168.1.20');
  const found = typed || otherAnswering()?.address;
  if (!found) {
    throw new BackupError("Can't see the active HomeHub on the network. Enter its address, such as 192.168.1.20.");
  }
  write(FOLLOW_KEY, {
    code: clean, address: found, pairedAt: new Date().toISOString(),
    checkedAt: null, copiedAt: null, error: null, hash: null,
  } satisfies FollowState);
  const first = await syncNow(fetcher);
  // Paired only once the first copy worked, so a mistyped code or address can just be typed again.
  if (first?.error && !first.copiedAt) {
    remove(FOLLOW_KEY);
    throw new BackupError(first.error);
  }
  return first;
}

export function stopFollowing(): void {
  remove(FOLLOW_KEY);
  logger.info('Backup sync: stopped copying from the active HomeHub');
}

export interface SyncStatus {
  role: string;
  /** On the active HomeHub: whether a backup is paired, and when it last fetched. */
  serving: { pairedAt: string; last: { at: string; address: string } | null } | null;
  /** On a backup: where it copies from and how the last sync went. The code itself is never shown. */
  following: Omit<FollowState, 'code' | 'hash'> | null;
  /** The address of the active HomeHub seen on the network, for a backup about to pair. */
  activeSeen: string | null;
  everyMinutes: number;
}

export function syncStatus(): SyncStatus {
  const serve = read<ServeState>(SERVE_KEY);
  const f = read<FollowState>(FOLLOW_KEY);
  return {
    role: serverRole(),
    serving: serve ? { pairedAt: serve.pairedAt, last: serve.last } : null,
    following: f ? { address: f.address, pairedAt: f.pairedAt, checkedAt: f.checkedAt, copiedAt: f.copiedAt, error: f.error } : null,
    activeSeen: otherAnswering()?.address ?? null,
    everyMinutes: SYNC_EVERY_MS / 60_000,
  };
}

export function startBackupSync(): void {
  setTimeout(() => { void syncNow(); }, FIRST_SYNC_MS).unref();
  setInterval(() => { void syncNow(); }, SYNC_EVERY_MS).unref();
}
