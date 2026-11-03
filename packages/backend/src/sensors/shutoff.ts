/**
 * Auto-shutoff coordinator.
 *
 * Lifecycle for a single flow_event:
 *
 *   not_fired ──(level 3 + shutoffDeviceId set)──► fired
 *   fired ─────(rate drop ≥80% within window)──► verified
 *   fired ─────(no drop after window)──────────► failed → critical alert
 *
 * The actual valve actuation is delegated to an injected `invoker` so this
 * module is testable without real hardware drivers.
 */

import { getDb } from '../db';
import { logger } from '../logger';
import { automationsPaused } from '../automation/pause';

export type ShutoffStatus = 'not_fired' | 'fired' | 'verified' | 'failed';

export const VERIFY_AFTER_MS = 60_000;       // wait this long for the next reading
export const REQUIRED_DROP_FRAC = 0.8;       // rate must drop by ≥80% from peak

export interface ShutoffInvoker {
  /**
   * Close the valve. Resolves on success; throws on driver error.
   * Implementation can call DriverRegistry.setPower(deviceId, false).
   */
  closeValve(deviceId: number): Promise<void>;
}

export interface ShutoffNotifier {
  notifyFailure(eventId: number, sensorRowId: number, sensorAlias: string): void;
  notifySuccess?(eventId: number, sensorRowId: number, sensorAlias: string): void;
}

interface EventRow {
  id:                   number;
  sensor_id:            number;
  peak_rate:            number;
  alert_level:          number;
  status:               'active' | 'closed';
  shutoff_status:       ShutoffStatus;
  shutoff_fired_at:     string | null;
  shutoff_rate_at_fire: number | null;
}

interface SensorRow {
  id:     number;
  alias:  string;
  config: string | null;
}

/**
 * If the event qualifies (level ≥ 3, sensor has shutoffDeviceId, not yet
 * fired), perform the shutoff. Idempotent — safe to call from every reading
 * during an active L3 event.
 */
export async function maybeFireShutoff(
  eventId:    number,
  invoker:    ShutoffInvoker,
  notifier:   ShutoffNotifier,
  options:   { verifyAfterMs?: number } = {},
): Promise<void> {
  const db = getDb();
  const event = db.prepare('SELECT * FROM flow_events WHERE id = ?').get(eventId) as EventRow | undefined;
  if (!event) return;
  if (event.alert_level < 3)            return;
  if (event.shutoff_status !== 'not_fired') return;

  const sensor = db.prepare('SELECT id, alias, config FROM sensors WHERE id = ?')
    .get(event.sensor_id) as SensorRow | undefined;
  if (!sensor) return;

  const cfg = parseConfig(sensor.config);
  const deviceId = cfg.shutoffDeviceId;
  if (typeof deviceId !== 'number' || deviceId <= 0) {
    logger.info({ eventId, sensorRowId: sensor.id }, 'Shutoff skipped — no shutoffDeviceId configured');
    return;
  }

  // Paused: leave it unfired, so the next reading after resuming can still fire it.
  if (automationsPaused()) {
    logger.warn({ eventId, sensorRowId: sensor.id }, 'Shutoff skipped — automations paused on this HomeHub');
    return;
  }

  // Mark fired BEFORE calling the invoker so concurrent readings won't double-fire.
  // If the invoker fails we mark `failed` and notify.
  const claimed = db.prepare(`
    UPDATE flow_events
       SET shutoff_status       = 'fired',
           shutoff_fired_at     = datetime('now'),
           shutoff_rate_at_fire = peak_rate
     WHERE id = ? AND shutoff_status = 'not_fired'
  `).run(eventId);
  if (claimed.changes === 0) return;   // raced — another caller already fired

  logger.warn({ eventId, sensorAlias: sensor.alias, deviceId }, 'Auto-shutoff firing valve');

  try {
    await invoker.closeValve(deviceId);
  } catch (err) {
    logger.error({ err, eventId, deviceId }, 'Auto-shutoff invoker threw — marking failed');
    markFailed(eventId);
    notifier.notifyFailure(eventId, sensor.id, sensor.alias);
    return;
  }

  // Schedule a verification check.
  const after = options.verifyAfterMs ?? VERIFY_AFTER_MS;
  setTimeout(() => {
    try {
      verifyShutoff(eventId, notifier, sensor.alias, sensor.id);
    } catch (err) {
      logger.error({ err, eventId }, 'Shutoff verification threw');
    }
  }, after).unref?.();
}

/**
 * Read the latest flow_reading after the shutoff fire and decide if the
 * valve actually stopped flow. Marks `verified` or `failed` and (on
 * failure) calls the notifier.
 *
 * Exported for tests so they can drive verification synchronously.
 */
export function verifyShutoff(
  eventId:     number,
  notifier:    ShutoffNotifier,
  sensorAlias: string,
  sensorRowId: number,
): ShutoffStatus {
  const db = getDb();
  const event = db.prepare('SELECT * FROM flow_events WHERE id = ?').get(eventId) as EventRow | undefined;
  if (!event)                            return 'not_fired';
  if (event.shutoff_status !== 'fired')  return event.shutoff_status;

  const since = event.shutoff_fired_at;
  if (!since) {
    markFailed(eventId);
    notifier.notifyFailure(eventId, sensorRowId, sensorAlias);
    return 'failed';
  }

  const latest = db.prepare(`
    SELECT rate_m3h, recorded_at
      FROM flow_readings
     WHERE sensor_id = ? AND recorded_at >= ?
     ORDER BY recorded_at DESC
     LIMIT 1
  `).get(event.sensor_id, since) as { rate_m3h: number; recorded_at: string } | undefined;

  const fireRate = event.shutoff_rate_at_fire ?? event.peak_rate;
  const dropOk   = latest !== undefined && latest.rate_m3h <= fireRate * (1 - REQUIRED_DROP_FRAC);

  if (dropOk) {
    db.prepare(`
      UPDATE flow_events
         SET shutoff_status       = 'verified',
             shutoff_completed_at = datetime('now')
       WHERE id = ? AND shutoff_status = 'fired'
    `).run(eventId);
    logger.info({ eventId, sensorAlias, latestRate: latest!.rate_m3h, fireRate },
      'Auto-shutoff verified — flow dropped');
    notifier.notifySuccess?.(eventId, sensorRowId, sensorAlias);
    return 'verified';
  }

  markFailed(eventId);
  logger.error(
    { eventId, sensorAlias, latestRate: latest?.rate_m3h, fireRate },
    'Auto-shutoff FAILED — flow did not drop after valve close',
  );
  notifier.notifyFailure(eventId, sensorRowId, sensorAlias);
  return 'failed';
}

function markFailed(eventId: number): void {
  getDb().prepare(`
    UPDATE flow_events
       SET shutoff_status       = 'failed',
           shutoff_completed_at = datetime('now')
     WHERE id = ? AND shutoff_status = 'fired'
  `).run(eventId);
}

function parseConfig(json: string | null): { shutoffDeviceId?: number } {
  if (!json) return {};
  try { return JSON.parse(json) as { shutoffDeviceId?: number }; } catch { return {}; }
}
