import { getDb } from '../db';
import { logger } from '../logger';

/**
 * Pause automations on this HomeHub, for example a development copy running
 * against the same devices as the real one. While paused, HomeHub doesn't act
 * on its own: no schedules, motion rules, "Turn off after" timers, camera
 * motion snapshots or automatic water shutoff. Switching by hand, Chat and
 * scenes run by hand still work.
 *
 * The setting belongs to this HomeHub only: backups leave it out, and a
 * restore keeps this HomeHub's value.
 */

export const PAUSE_KEY = 'automations_paused';

export function automationsPaused(): boolean {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(PAUSE_KEY) as { value: string } | undefined;
    return row?.value === '1';
  } catch {
    return false;
  }
}

export function setAutomationsPaused(paused: boolean): void {
  const db = getDb();
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(PAUSE_KEY, paused ? '1' : '0');
  if (!paused) {
    // Timers that ran out while paused just end: firing them all on resume
    // would switch things off with no warning.
    const ended = db.prepare(`
      UPDATE devices SET override_state = NULL, override_until = NULL, timer_off_at = NULL
       WHERE timer_off_at <= datetime('now')
    `).run().changes;
    if (ended) logger.info({ ended }, 'Timers that ended while automations were paused were cleared');
  }
  logger.warn(paused ? 'Automations paused on this HomeHub' : 'Automations resumed');
}
