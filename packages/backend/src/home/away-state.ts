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

/** While away: any water flow counts as a leak. */
export function awayWatchesWater(): boolean {
  return awayActive() && read<{ water?: boolean }>(AWAY_SETTINGS_KEY)?.water !== false;
}

/** While away: check-ins and spoken reminders wait. */
export function awayPausesFamily(): boolean {
  return awayActive() && read<{ family?: boolean }>(AWAY_SETTINGS_KEY)?.family !== false;
}
