import { getDb } from '../db';
import { logger } from '../logger';
import { setBridgeStandby } from '../cameras/bridge';
import { otherAnswering, setLocalNameRole } from '../discovery/local-name';

/**
 * This server's part when you have more than one HomeHub on the same home:
 *
 * - **active**: runs everything. Only one should be active at a time.
 * - **backup**: a standby copy. Schedules, motion rules, timers, camera motion
 *   snapshots and automatic water shutoff don't run, the voice and camera
 *   bridges wait, and it answers to <name>-backup.local, not homehub.local.
 *   You can still open it and switch devices by hand.
 * - **dev**: the same, for a development copy. It never takes over.
 *
 * The role belongs to this server alone: backups leave it out and a restore
 * keeps it (json-backup's THIS_HOMEHUB_ONLY). Unset means active, so every
 * existing HomeHub carries on as it was.
 */

export const ROLES = ['active', 'backup', 'dev'] as const;
export type ServerRole = typeof ROLES[number];

export const ROLE_KEY = 'server_role';
/** When this server last became active, for telling which of two is newer. */
export const ACTIVE_SINCE_KEY = 'server_active_since';

function get(key: string): string | null {
  try {
    return (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  } catch {
    return null;
  }
}
function set(key: string, value: string): void {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function serverRole(): ServerRole {
  const v = get(ROLE_KEY);
  return (ROLES as readonly string[]).includes(v ?? '') ? (v as ServerRole) : 'active';
}

export const isActiveServer = (): boolean => serverRole() === 'active';

export interface RoleStatus {
  role: ServerRole;
  activeSince: string | null;
  /**
   * Another computer answering to homehub.local on the home network. On a
   * backup that's the active HomeHub; on the active one, a second HomeHub
   * that also thinks it's active.
   */
  other: { address: string; seenAt: string } | null;
}

export function roleStatus(now = Date.now()): RoleStatus {
  const o = otherAnswering(now);
  return {
    role: serverRole(),
    activeSince: get(ACTIVE_SINCE_KEY),
    other: o ? { address: o.address, seenAt: new Date(o.at).toISOString() } : null,
  };
}

/** Make the bridges and the .local name match the role. Run at startup and on every change. */
export function applyRole(role = serverRole()): void {
  const standby = role !== 'active';
  try { setBridgeStandby(standby); } catch (err) { logger.warn({ err }, 'Could not switch the camera bridge'); }
  setLocalNameRole(role);
}

export function setServerRole(role: unknown): RoleStatus {
  if (!(ROLES as readonly unknown[]).includes(role)) throw new Error(`role must be one of: ${ROLES.join(', ')}`);
  const was = serverRole();
  const next = role as ServerRole;
  if (next === was) return roleStatus();
  set(ROLE_KEY, next);
  if (next === 'active') {
    set(ACTIVE_SINCE_KEY, new Date().toISOString());
    // As when resuming automations: timers that ran out while this was a backup
    // just end, rather than all switching things off at once.
    const ended = getDb().prepare(`
      UPDATE devices SET override_state = NULL, override_until = NULL, timer_off_at = NULL
       WHERE timer_off_at <= datetime('now')
    `).run().changes;
    if (ended) logger.info({ ended }, 'Timers that ended while this was not the active server were cleared');
  }
  applyRole(next);
  logger.warn({ from: was, to: next }, `This HomeHub is now ${next === 'active' ? 'the active server' : `a ${next} server`}`);
  return roleStatus();
}
