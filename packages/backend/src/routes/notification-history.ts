import { Router, Request, Response } from 'express';
import { getDb } from '../db';

/**
 * GET /api/notifications/history
 *
 * Audit feed of dispatches that fired (push/email/sms/voice). The schema
 * already records every send in `notification_dispatches`; this route
 * joins it with flow_events, sensors, and users so the UI gets a single
 * row per dispatch with everything needed to render — no N+1 fetches.
 *
 * Query params (all optional):
 *   ?channel=push|email|sms|voice
 *   ?level=1|2|3
 *   ?since=<ISO>          fired at or after
 *   ?sensorId=<id>        scope to one sensor
 *   ?limit=<n>            default 100, max 500
 *
 * Default order: most recent first.
 */
export const notificationHistoryRouter = Router();

interface DispatchJoinRow {
  id:           number;
  event_id:     number;
  channel:      string;
  level:        number;
  sent_at:      string;
  acked_at:     string | null;
  user_id:      number | null;
  user_name:    string | null;
  sensor_id:    number | null;
  sensor_key:   string | null;
  sensor_alias: string | null;
  alert_level:  number;
  event_status: string;
  event_start:  string;
  event_end:    string | null;
}

function toPublic(row: DispatchJoinRow) {
  return {
    id:           row.id,
    eventId:      row.event_id,
    channel:      row.channel,
    level:        row.level,
    sentAt:       row.sent_at,
    ackedAt:      row.acked_at,
    userId:       row.user_id,
    userName:     row.user_name,
    sensorId:     row.sensor_id,
    sensorKey:    row.sensor_key,
    sensorAlias:  row.sensor_alias,
    eventStatus:  row.event_status,
    eventStart:   row.event_start,
    eventEnd:     row.event_end,
    eventAlertLevel: row.alert_level,
  };
}

notificationHistoryRouter.get('/', (req: Request, res: Response) => {
  const channel  = strQuery(req.query.channel);
  const levelRaw = strQuery(req.query.level);
  const since    = strQuery(req.query.since);
  const sensorIdRaw = strQuery(req.query.sensorId);
  const limit    = clampInt(req.query.limit, 100, 1, 500);

  if (channel !== undefined && !['push','email','sms','voice'].includes(channel)) {
    return res.status(400).json({ error: 'invalid channel', code: 'VALIDATION_ERROR' });
  }
  let level: number | undefined;
  if (levelRaw !== undefined) {
    level = Number(levelRaw);
    if (!Number.isInteger(level) || level < 1 || level > 3) {
      return res.status(400).json({ error: 'level must be 1, 2, or 3', code: 'VALIDATION_ERROR' });
    }
  }
  let sensorId: number | undefined;
  if (sensorIdRaw !== undefined) {
    sensorId = Number(sensorIdRaw);
    if (!Number.isInteger(sensorId) || sensorId <= 0) {
      return res.status(400).json({ error: 'sensorId must be a positive integer', code: 'VALIDATION_ERROR' });
    }
  }

  const params: (string | number)[] = [];
  let where = 'WHERE 1=1';
  if (channel)            { where += ' AND nd.channel = ?';   params.push(channel); }
  if (level !== undefined){ where += ' AND nd.level = ?';     params.push(level); }
  if (since)              { where += ' AND nd.sent_at >= ?';  params.push(since.replace('T', ' ').replace('Z', '')); }
  if (sensorId !== undefined) { where += ' AND s.id = ?';     params.push(sensorId); }

  const rows = getDb().prepare(`
    SELECT
      nd.id            AS id,
      nd.event_id      AS event_id,
      nd.channel       AS channel,
      nd.level         AS level,
      nd.sent_at       AS sent_at,
      nd.acked_at      AS acked_at,
      nd.user_id       AS user_id,
      u.name           AS user_name,
      s.id             AS sensor_id,
      s.sensor_id      AS sensor_key,
      s.alias          AS sensor_alias,
      fe.alert_level   AS alert_level,
      fe.status        AS event_status,
      fe.start_time    AS event_start,
      fe.end_time      AS event_end
    FROM notification_dispatches nd
    LEFT JOIN flow_events fe ON fe.id = nd.event_id
    LEFT JOIN sensors      s ON s.id = fe.sensor_id
    LEFT JOIN users        u ON u.id = nd.user_id
    ${where}
    ORDER BY nd.sent_at DESC
    LIMIT ?
  `).all(...params, limit) as DispatchJoinRow[];

  res.json(rows.map(toPublic));
});

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function strQuery(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}
