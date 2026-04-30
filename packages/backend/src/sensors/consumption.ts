/**
 * Consumption rollups bucketed by hour/day/month.
 *
 * Phase 1 strategy: sum closed `flow_events.total_m3` keyed by the event's
 * end time. Active events are excluded; their volume rolls in once they
 * close. Events that span bucket boundaries are attributed to the bucket
 * they ended in — acceptable approximation since events are typically
 * minutes-to-hours, not days.
 *
 * Per-event volume comes from the totalizer delta (start vs end), so this
 * is more accurate than integrating instantaneous rate readings.
 */

import { getDb } from '../db';

export type Bucket = 'hour' | 'day' | 'month';

export interface ConsumptionBucket {
  bucket:     string;   // ISO-ish: 'YYYY-MM-DD HH:00' / 'YYYY-MM-DD' / 'YYYY-MM'
  m3:         number;
  gallons:    number;
  eventCount: number;
}

const M3_TO_GAL = 264.172;

const BUCKET_FORMAT: Record<Bucket, string> = {
  hour:  '%Y-%m-%d %H:00',
  day:   '%Y-%m-%d',
  month: '%Y-%m',
};

export function getConsumptionBuckets(
  sensorId:  number,
  bucket:    Bucket,
  fromIso:   string | null,
  toIso:     string | null,
): ConsumptionBucket[] {
  const fmt = BUCKET_FORMAT[bucket];
  const params: (string | number)[] = [fmt, sensorId];

  let where = "WHERE sensor_id = ? AND status = 'closed' AND total_m3 IS NOT NULL";
  if (fromIso) { where += ' AND end_time >= ?'; params.push(toSqliteTs(fromIso)); }
  if (toIso)   { where += ' AND end_time <  ?'; params.push(toSqliteTs(toIso));   }

  const rows = getDb().prepare(`
    SELECT strftime(?, end_time) AS bucket,
           SUM(total_m3)         AS m3,
           COUNT(*)              AS event_count
    FROM flow_events
    ${where}
    GROUP BY bucket
    ORDER BY bucket
  `).all(...params) as { bucket: string; m3: number; event_count: number }[];

  return rows.map((r) => ({
    bucket:     r.bucket,
    m3:         r.m3,
    gallons:    r.m3 * M3_TO_GAL,
    eventCount: r.event_count,
  }));
}

function toSqliteTs(iso: string): string {
  // Accept ISO ('2026-04-30T12:00:00Z') or already-sqlite ('2026-04-30 12:00:00').
  return iso.replace('T', ' ').replace('Z', '');
}
