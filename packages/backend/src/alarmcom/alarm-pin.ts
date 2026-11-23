/**
 * The alarm PIN: asked for every time someone disarms the alarm from HomeHub. Alarm.com itself takes
 * no PIN (the signed-in session is enough for it), so this is HomeHub's own lock on disarming.
 *
 * One PIN for the home, set by an admin, kept hashed (bcrypt) as "<digits>:<hash>". Its setting's
 * name contains "pass", so a backup shown on screen hides it. Wrong guesses are slowed for
 * everyone, since it's one PIN: after 5, a minute's wait, doubling with each further miss up to
 * 15 minutes, until a right one. Counts are kept in memory, so a restart clears them; the
 * keypad and the Alarm.com app still work meanwhile.
 */
import bcrypt from 'bcrypt';
import { getDb } from '../db';

const KEY = 'alarmcom_passcode';
const ROUNDS = 10;
export const PIN_PATTERN = /^\d{4,8}$/;
const FREE_TRIES = 5;
const FIRST_WAIT_MS = 60_000;
const MAX_WAIT_MS = 15 * 60_000;

export class AlarmPinError extends Error {
  constructor(message: string, readonly status = 403, readonly retryAfterSeconds?: number) { super(message); }
}

const stored = (): string | null =>
  (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined)?.value || null;

export const hasAlarmPin = (): boolean => !!stored();
export const alarmPinLength = (): number | null => {
  const v = stored();
  return v ? Number(/^(\d):/.exec(v)?.[1] ?? 4) : null;
};

let misses = { count: 0, until: 0 };
export function clearAlarmPinMissesForTests(): void { misses = { count: 0, until: 0 }; }

/** Checks the PIN, slowing guesses down. Throws AlarmPinError when it's wrong, too soon, or unset. */
export async function checkAlarmPin(pin: unknown, now = Date.now()): Promise<void> {
  const v = stored();
  if (!v) throw new AlarmPinError('Set an alarm PIN first: Settings → Integrations → Alarm.com.', 409);
  if (misses.until > now) {
    throw new AlarmPinError('Too many wrong tries. Wait, then try again.', 429, Math.ceil((misses.until - now) / 1000));
  }
  if (typeof pin === 'string' && PIN_PATTERN.test(pin) && await bcrypt.compare(pin, v.replace(/^\d:/, ''))) {
    misses = { count: 0, until: 0 };
    return;
  }
  const count = misses.count + 1;
  const wait = count < FREE_TRIES ? 0 : Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (count - FREE_TRIES));
  misses = { count, until: now + wait };
  throw new AlarmPinError(
    wait ? `Wrong PIN. Wait ${Math.round(wait / 60_000)} min before trying again.`
      : `Wrong PIN. ${FREE_TRIES - count} ${FREE_TRIES - count === 1 ? 'try' : 'tries'} left before a wait.`,
    403,
    wait ? Math.ceil(wait / 1000) : undefined,
  );
}

/** Sets or changes the PIN. Admins only (the route checks). */
export async function setAlarmPin(pin: unknown): Promise<void> {
  if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) throw new AlarmPinError('The PIN must be 4 to 8 digits.', 400);
  if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) {
    throw new AlarmPinError('Choose a PIN that’s harder to guess than repeated or consecutive digits.', 400);
  }
  const hash = await bcrypt.hash(pin, ROUNDS);
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, `${pin.length}:${hash}`);
  misses = { count: 0, until: 0 };
}

export function removeAlarmPin(): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(KEY);
}
