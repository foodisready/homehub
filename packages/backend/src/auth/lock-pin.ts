/**
 * A PIN for a shared screen: a wall tablet signed in as "Kitchen tablet" locks, by hand or after a
 * few idle minutes, and opens again with a short PIN instead of the account's password.
 *
 * The PIN belongs to the login, kept here hashed like a password (bcrypt), never in the browser.
 * Wrong guesses are slowed: after 5, a minute's wait, doubling with each further miss up to 15
 * minutes, until a right one. Counts are kept in memory, so a restart clears them.
 *
 * A wrong PIN is a 403, not a 401: the app reads a 401 as a lapsed sign-in and would sign the screen out.
 *
 * Forgetting it: sign out from the lock screen, sign in again with the password, and remove or
 * change the PIN with the password instead of the old PIN.
 */
import bcrypt from 'bcrypt';
import { getDb } from '../db';
import { findUserById } from './auth.service';

const ROUNDS = 10;
const PIN = /^\d{4,8}$/;
const FREE_TRIES = 5;
const FIRST_WAIT_MS = 60_000;
const MAX_WAIT_MS = 15 * 60_000;

export class LockPinError extends Error {
  constructor(message: string, readonly status = 400, readonly retryAfterSeconds?: number) { super(message); }
}

/** Stored as "<digits>:<bcrypt hash>": the screen shows how many digits to enter, as a phone does. */
const stored = (userId: number) =>
  (getDb().prepare('SELECT lock_pin FROM users WHERE id = ?').get(userId) as { lock_pin: string | null } | undefined)?.lock_pin ?? null;
const hashOf = (userId: number) => stored(userId)?.replace(/^\d:/, '') ?? null;

export const hasPin = (userId: number) => !!stored(userId);
/** How many digits the PIN has; null without one. */
export const pinLength = (userId: number): number | null => {
  const v = stored(userId);
  return v ? Number(/^(\d):/.exec(v)?.[1] ?? 4) : null;
};

interface Misses { count: number; until: number }
const misses = new Map<number, Misses>();
export function clearMissesForTests(): void { misses.clear(); }

/** Checks the PIN, slowing guesses down. Throws LockPinError when it's wrong or it's too soon. */
export async function checkPin(userId: number, pin: unknown, now = Date.now()): Promise<void> {
  const hash = hashOf(userId);
  if (!hash) throw new LockPinError('No PIN is set', 404);
  const m = misses.get(userId);
  if (m && m.until > now) {
    throw new LockPinError('Too many wrong tries. Wait, then try again.', 429, Math.ceil((m.until - now) / 1000));
  }
  if (typeof pin === 'string' && PIN.test(pin) && await bcrypt.compare(pin, hash)) {
    misses.delete(userId);
    return;
  }
  const count = (m?.count ?? 0) + 1;
  const wait = count < FREE_TRIES ? 0 : Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (count - FREE_TRIES));
  misses.set(userId, { count, until: now + wait });
  throw new LockPinError(
    wait ? `Wrong PIN. Wait ${Math.round(wait / 60_000)} min before trying again.` : `Wrong PIN. ${FREE_TRIES - count} ${FREE_TRIES - count === 1 ? 'try' : 'tries'} left before a wait.`,
    403, wait ? Math.ceil(wait / 1000) : undefined,
  );
}

/** The current PIN, or the account's password, proves it's theirs to change or remove. */
async function proveOwner(userId: number, current: unknown, password: unknown): Promise<void> {
  if (!hasPin(userId)) return;
  if (typeof password === 'string' && password) {
    const user = findUserById(userId) as { password_hash?: string } | undefined;
    if (user?.password_hash && await bcrypt.compare(password, user.password_hash)) return;
    throw new LockPinError('That password isn’t right', 403);
  }
  await checkPin(userId, current);
}

export async function setPin(userId: number, pin: unknown, current?: unknown, password?: unknown): Promise<void> {
  if (typeof pin !== 'string' || !PIN.test(pin)) throw new LockPinError('A PIN is 4 to 8 digits');
  if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) {
    throw new LockPinError('Choose a PIN that’s harder to guess than repeated or consecutive digits');
  }
  await proveOwner(userId, current, password);
  getDb().prepare('UPDATE users SET lock_pin = ? WHERE id = ?').run(`${pin.length}:${await bcrypt.hash(pin, ROUNDS)}`, userId);
  misses.delete(userId);
}

export async function removePin(userId: number, current?: unknown, password?: unknown): Promise<void> {
  if (!hasPin(userId)) return;
  await proveOwner(userId, current, password);
  getDb().prepare('UPDATE users SET lock_pin = NULL WHERE id = ?').run(userId);
  misses.delete(userId);
}
