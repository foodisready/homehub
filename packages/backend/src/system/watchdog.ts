import { getDb } from '../db';
import { logger } from '../logger';
import { isActiveServer } from './role';

/**
 * An outside watchdog: HomeHub visits a heartbeat address (healthchecks.io, Uptime Kuma, Better
 * Stack…) every few minutes, and that service tells the family when the visits stop. It's the
 * one way to know HomeHub itself is down: a Pi that's lost power, crashed or lost Wi-Fi can't send
 * anything, so a missed check-in would go unnoticed.
 *
 * Only the visit leaves the house: no data. It's made only while HomeHub is working (its database
 * answers), so a backend that's running but broken stops visiting too. A backup server doesn't
 * visit, so the watchdog follows the active one.
 */

const KEY = 'watchdog_url';
export const EVERY_MS = 5 * 60_000;
const FIRST_AFTER_MS = 30_000;
const TIMEOUT_MS = 10_000;
/** The Health page warns when visits have failed for this long. */
export const FAILING_FOR_MS = 15 * 60_000;

export interface WatchdogStatus {
  url: string | null;
  lastAt: string | null;
  lastOk: boolean | null;
  lastError: string | null;
  /** When visits started failing, while they are. */
  failingSince: string | null;
}

let last: { at: number; ok: boolean; error: string | null } | null = null;
let failingSince: number | null = null;

export function watchdogUrl(): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
    return row?.value || null;
  } catch {
    return null;
  }
}

/** The address must be http(s) and short; null or '' removes it. Throws a message to show. */
export function setWatchdogUrl(value: unknown): void {
  if (value === null || value === '') {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(KEY);
    last = null;
    failingSince = null;
    return;
  }
  if (typeof value !== 'string') throw new Error('The address must be text');
  const url = value.trim();
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('That isn’t a web address. Copy the ping URL from the watchdog service.'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('The address must start with https://');
  if (url.length > 500) throw new Error('The address is too long');
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, url);
  last = null;
  failingSince = null;
}

export function watchdogStatus(): WatchdogStatus {
  return {
    url: watchdogUrl(),
    lastAt: last ? new Date(last.at).toISOString() : null,
    lastOk: last?.ok ?? null,
    lastError: last?.error ?? null,
    failingSince: failingSince !== null ? new Date(failingSince).toISOString() : null,
  };
}

/** True while HomeHub's database answers: the part everything else needs. */
function working(): boolean {
  try {
    getDb().prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

/** One visit, now. Returns the result; also kept for the Health page. */
export async function visit(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<{ ok: boolean; error: string | null }> {
  const url = watchdogUrl();
  if (!url) return { ok: false, error: 'No watchdog address set' };
  let result: { ok: boolean; error: string | null };
  if (!working()) {
    result = { ok: false, error: 'HomeHub’s database isn’t answering, so it didn’t check in' };
  } else {
    try {
      const r = await fetchImpl(url, { headers: { 'User-Agent': 'HomeHub' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      await r.arrayBuffer().catch(() => undefined);
      result = r.ok ? { ok: true, error: null } : { ok: false, error: `The watchdog answered ${r.status}${r.status === 404 ? ': check the address' : ''}` };
    } catch (err) {
      const e = err as Error;
      result = { ok: false, error: e.name === 'TimeoutError' ? 'The watchdog didn’t answer in 10 seconds' : `Couldn’t reach the watchdog (${e.message})` };
    }
  }
  last = { at: now, ...result };
  if (result.ok) failingSince = null;
  else failingSince ??= now;
  return result;
}

let timer: NodeJS.Timeout | null = null;

export function startWatchdog(): void {
  if (timer) return;
  const tick = () => {
    if (!isActiveServer() || !watchdogUrl()) return;
    visit().then((r) => { if (!r.ok) logger.warn({ error: r.error }, 'Watchdog check-in failed'); }).catch(() => undefined);
  };
  setTimeout(tick, FIRST_AFTER_MS).unref();
  timer = setInterval(tick, EVERY_MS);
  timer.unref();
}

/** For tests. */
export function resetWatchdogForTests(): void { last = null; failingSince = null; }
