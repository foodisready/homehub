import { getDb } from '../db';

/**
 * Whether Away mode is on, and what it covers, read straight from the settings table.
 * Kept free of other imports so the thermostat schedule, water sensor, check-ins and
 * reminders can all ask without importing Away mode's own logic (home/away.ts).
 */

export const AWAY_STATE_KEY = 'away_state';
export const AWAY_SETTINGS_KEY = 'away_settings';

function read<T>(key: string): T | null {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  } catch {
    return null;
  }
}

/** Away mode is on. */
export function awayActive(): boolean {
  return read<{ since?: string }>(AWAY_STATE_KEY)?.since !== undefined;
}

/** While away: any water flow starting after Away mode began counts as a leak. Its start, or null. */
export function awayWatchesWaterSince(): string | null {
  const since = read<{ since?: string }>(AWAY_STATE_KEY)?.since;
  if (!since || read<{ water?: boolean }>(AWAY_SETTINGS_KEY)?.water === false) return null;
  return since;
}

/**
 * Check-ins and spoken reminders wait while away, and after Away mode ends early to warm
 * the house up, until the day back. `from`: when the check's window or the reminder starts;
 * anything starting before the day back is skipped.
 */
export function awayPausesFamily(from = Date.now()): boolean {
  if (read<{ family?: boolean }>(AWAY_SETTINGS_KEY)?.family === false) return false;
  if (awayActive()) return true;
  const until = read<string>('away_family_until');
  return !!until && Date.parse(until) > from;
}
