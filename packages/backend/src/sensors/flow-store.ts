/**
 * DB adapter for the flow engine. Applies a `FlowDecision` against
 * better-sqlite3 in a transaction. Pure-DB layer — no socket/notification
 * side effects (those happen in the route after the transaction commits).
 */

import { getDb } from '../db';
import {
  evaluateFlowReading,
  resolveFlowConfig,
  type AlertLevel,
  type FlowConfig,
  type FlowDecision,
  type FlowReading,
} from './flow-engine';

export interface SensorRow {
  id:                     number;
  sensor_id:              string;
  type:                   string;
  alias:                  string;
  config:                 string | null;
  first_seen_mac:         string | null;
  last_seen_at:           string | null;
  last_rssi:              number | null;
  last_uptime_sec:        number | null;
  last_signal_quality:    number | null;
  firmware_version:       string | null;
  pending_state:          'idle' | 'flowing';
  pending_count:          number;
  snoozed_until:          string | null;
  stale_since:            string | null;
  last_ip:                string | null;
  /** SQLite stores INTEGER, comes back as 0/1/null. */
  last_meter_reachable:   number | null;
  created_at:             string;
}

export interface FlowEventRow {
  id:                    number;
  sensor_id:             number;
  start_time:            string;
  end_time:              string | null;
  peak_rate:             number;
  avg_rate:              number | null;
  total_m3:              number | null;
  total_m3_start:        number | null;
  status:                'active' | 'closed';
  alert_level:           AlertLevel;
  shutoff_status:        'not_fired' | 'fired' | 'verified' | 'failed';
  shutoff_fired_at:      string | null;
  shutoff_completed_at:  string | null;
}

export function getSensorByKey(sensorKey: string): SensorRow | undefined {
  return getDb()
    .prepare('SELECT * FROM sensors WHERE sensor_id = ?')
    .get(sensorKey) as SensorRow | undefined;
}

export function getActiveEvent(sensorRowId: number): FlowEventRow | undefined {
  return getDb()
    .prepare("SELECT * FROM flow_events WHERE sensor_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1")
    .get(sensorRowId) as FlowEventRow | undefined;
}

export function parseSensorConfig(configJson: string | null): FlowConfig {
  if (!configJson) return resolveFlowConfig(null);
  try {
    return resolveFlowConfig(JSON.parse(configJson) as Partial<FlowConfig>);
  } catch {
    return resolveFlowConfig(null);
  }
}

export interface IngestResult {
  decision:  FlowDecision;
  /** Row id of the resulting active event, if any (newly opened or pre-existing). */
  eventId:   number | null;
  /** Final alert level for the active event (or 0 if no event). */
  level:     AlertLevel;
  /** Was a new event opened on this reading? */
  opened:    boolean;
  /** Was the event closed on this reading? */
  closed:    boolean;
  /** Did alert level change on this reading? */
  levelChanged: boolean;
}

/**
 * Apply a reading: insert into `flow_readings`, run the engine, and persist
 * any state/event transitions atomically. Caller emits sockets and
 * notifications based on the returned summary.
 */
export function ingestReading(
  sensorRow: SensorRow,
  reading:   FlowReading,
  tOffsetMs: number,
): IngestResult {
  const db = getDb();
  const config = parseSensorConfig(sensorRow.config);

  // Reconstruct recorded_at from receivedAt - tOffsetMs (fix C).
  const recordedAtIso = reading.recordedAt.toISOString().replace('T', ' ').replace('Z', '');

  return db.transaction((): IngestResult => {
    db.prepare(`
      INSERT INTO flow_readings (sensor_id, rate_m3h, total_m3, signal_quality, t_offset_ms, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      sensorRow.id,
      reading.rate,
      reading.totalM3,
      reading.signalQuality,
      tOffsetMs,
      recordedAtIso,
    );

    const active = getActiveEvent(sensorRow.id);
    const decision = evaluateFlowReading({
      config,
      state: {
        pendingState: sensorRow.pending_state,
        pendingCount: sensorRow.pending_count,
        snoozedUntil: sensorRow.snoozed_until ? new Date(sensorRow.snoozed_until + 'Z') : null,
      },
      activeEvent: active
        ? {
            id:           active.id,
            startTime:    new Date(active.start_time.replace(' ', 'T') + 'Z'),
            peakRate:     active.peak_rate,
            alertLevel:   active.alert_level,
            totalM3Start: active.total_m3_start,
          }
        : null,
      reading,
    });

    let eventId       = active?.id ?? null;
    let level         = (active?.alert_level ?? 0) as AlertLevel;
    let opened        = false;
    let closed        = false;
    let levelChanged  = false;

    if (decision.openEvent) {
      const r = db.prepare(`
        INSERT INTO flow_events (sensor_id, start_time, peak_rate, alert_level, total_m3_start, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(
        sensorRow.id,
        recordedAtIso,
        decision.openEvent.rate,
        decision.openEvent.alertLevel,
        decision.openEvent.totalM3,
      );
      eventId      = Number(r.lastInsertRowid);
      level        = decision.openEvent.alertLevel;
      opened       = true;
      levelChanged = level > 0;
    }

    if (decision.updateEvent) {
      db.prepare(`
        UPDATE flow_events
           SET peak_rate   = ?,
               alert_level = ?
         WHERE id = ?
      `).run(decision.updateEvent.peakRate, decision.updateEvent.alertLevel, decision.updateEvent.eventId);
      level        = decision.updateEvent.alertLevel;
      levelChanged = decision.updateEvent.levelChanged;
    }

    if (decision.closeEvent && active) {
      const totalM3 =
        decision.closeEvent.totalM3End != null && active.total_m3_start != null
          ? decision.closeEvent.totalM3End - active.total_m3_start
          : null;
      const durationH =
        (decision.closeEvent.endTime.getTime() - new Date(active.start_time.replace(' ', 'T') + 'Z').getTime())
        / 3_600_000;
      const avgRate = totalM3 != null && durationH > 0 ? totalM3 / durationH : null;

      db.prepare(`
        UPDATE flow_events
           SET end_time = ?,
               total_m3 = ?,
               avg_rate = ?,
               status   = 'closed'
         WHERE id = ?
      `).run(recordedAtIso, totalM3, avgRate, decision.closeEvent.eventId);
      closed = true;
    }

    if (decision.pendingStateUpdate) {
      db.prepare(`
        UPDATE sensors
           SET pending_state = ?,
               pending_count = ?
         WHERE id = ?
      `).run(decision.pendingStateUpdate.state, decision.pendingStateUpdate.count, sensorRow.id);
    }

    return { decision, eventId, level, opened, closed, levelChanged };
  })();
}
