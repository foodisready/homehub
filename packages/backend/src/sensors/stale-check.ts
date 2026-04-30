/**
 * Stale-sensor detection.
 *
 * Without this, a dead ESP32 would silently stop reporting and the
 * leak engine would never escalate (no readings, no events). Users
 * would have no way of knowing the safety system is offline.
 *
 * Approach:
 *   - A periodic checker (every 60s) loops all sensors
 *   - Threshold: max(5 × idlePollIntervalMs, MIN_THRESHOLD_MS)
 *   - First time a sensor exceeds the threshold → mark stale, notify
 *   - Recovery (a fresh reading arrives) is handled in routes/internal.ts
 *     where stale_since is cleared and notifyStaleRecovery() fires
 *
 * Sensors that have never reported (last_seen_at IS NULL) are not
 * considered stale — they're unprovisioned, not failed.
 */

import { getDb } from '../db';
import { logger } from '../logger';
import { sendPushToAll } from '../push/push.service';

const MIN_THRESHOLD_MS  = 3 * 60_000;    // 3 min — never alert sooner than this
const MAX_THRESHOLD_MS  = 30 * 60_000;   // 30 min — never wait longer than this

interface SensorMin {
  id:           number;
  alias:        string;
  config:       string | null;
  last_seen_at: string | null;
  stale_since:  string | null;
}

export interface StaleEvaluation {
  isStale:     boolean;
  thresholdMs: number;
  ageMs:       number | null;       // null when last_seen_at is null
}

/**
 * Pure logic — given a sensor row and "now", decide if it's stale.
 * Sensors that have never reported are NOT stale (return isStale=false).
 */
export function evaluateStale(sensor: SensorMin, now: number): StaleEvaluation {
  const thresholdMs = thresholdFor(sensor.config);

  if (!sensor.last_seen_at) {
    return { isStale: false, thresholdMs, ageMs: null };
  }

  const lastSeenMs = parseSqliteUtc(sensor.last_seen_at);
  const ageMs = now - lastSeenMs;
  return { isStale: ageMs > thresholdMs, thresholdMs, ageMs };
}

/**
 * Run a check across all sensors. Returns the number of sensors that
 * transitioned idle→stale on this run. Side effects: DB updates +
 * push notifications on transitions.
 */
export function checkAllSensors(now = Date.now()): number {
  const db = getDb();
  const sensors = db.prepare(
    'SELECT id, alias, config, last_seen_at, stale_since FROM sensors',
  ).all() as SensorMin[];

  let newStaleCount = 0;

  for (const s of sensors) {
    const { isStale, thresholdMs, ageMs } = evaluateStale(s, now);
    const wasStale = !!s.stale_since;

    if (isStale && !wasStale) {
      db.prepare("UPDATE sensors SET stale_since = datetime('now') WHERE id = ?").run(s.id);
      logger.warn(
        { sensorId: s.id, alias: s.alias, ageMs, thresholdMs },
        'Sensor went stale',
      );
      notifyStaleEntry(s.id, s.alias, ageMs ?? 0);
      newStaleCount++;
    } else if (!isStale && wasStale) {
      // Belt-and-suspenders: ingestion already clears stale_since on each
      // reading. If a sensor's last_seen_at moves forward without us seeing
      // the request (e.g. manual SQL), this catches the recovery anyway.
      db.prepare('UPDATE sensors SET stale_since = NULL WHERE id = ?').run(s.id);
      notifyStaleRecovery(s.id, s.alias);
    }
  }

  return newStaleCount;
}

export function notifyStaleEntry(sensorRowId: number, alias: string, ageMs: number): void {
  const minutes = Math.round(ageMs / 60_000);
  sendPushToAll(
    `⚠️ ${alias} — sensor offline`,
    `No readings for ${minutes} min. Leak detection is paused for this sensor.`,
    { kind: 'sensor_stale', sensorId: sensorRowId },
  );
}

export function notifyStaleRecovery(sensorRowId: number, alias: string): void {
  sendPushToAll(
    `${alias} — sensor back online`,
    'Readings resumed. Leak detection is active.',
    { kind: 'sensor_stale_recovery', sensorId: sensorRowId },
  );
}

function thresholdFor(configJson: string | null): number {
  if (!configJson) return MIN_THRESHOLD_MS;
  try {
    const cfg = JSON.parse(configJson) as { idlePollIntervalMs?: number };
    if (typeof cfg.idlePollIntervalMs === 'number' && cfg.idlePollIntervalMs > 0) {
      return clamp(cfg.idlePollIntervalMs * 5, MIN_THRESHOLD_MS, MAX_THRESHOLD_MS);
    }
  } catch { /* fall through */ }
  return MIN_THRESHOLD_MS;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function parseSqliteUtc(s: string): number {
  return new Date(s.replace(' ', 'T') + 'Z').getTime();
}
