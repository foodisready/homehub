import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { getDb } from '../db';
import { logger } from '../logger';
import { type SensorRow, type FlowEventRow } from '../sensors/flow-store';
import { getConsumptionBuckets, type Bucket } from '../sensors/consumption';
import { realInvoker } from '../sensors/shutoff-runtime';

export const sensorsRouter = Router();

function toPublicSensor(row: SensorRow) {
  return {
    id:                 row.id,
    sensorId:           row.sensor_id,
    type:               row.type,
    alias:              row.alias,
    config:             row.config ? safeJson(row.config) : null,
    firstSeenMac:       row.first_seen_mac,
    lastSeenAt:         row.last_seen_at,
    lastRssi:           row.last_rssi,
    lastUptimeSec:      row.last_uptime_sec,
    lastSignalQuality:  row.last_signal_quality,
    firmwareVersion:    row.firmware_version,
    pendingState:       row.pending_state,
    snoozedUntil:       row.snoozed_until,
    staleSince:         row.stale_since,
    lastIp:             row.last_ip,
    lastMeterReachable: row.last_meter_reachable === null ? null : row.last_meter_reachable === 1,
    createdAt:          row.created_at,
  };
}

function toPublicEvent(row: FlowEventRow) {
  return {
    id:                  row.id,
    sensorId:            row.sensor_id,
    startTime:           row.start_time,
    endTime:             row.end_time,
    peakRate:            row.peak_rate,
    avgRate:             row.avg_rate,
    totalM3:             row.total_m3,
    status:              row.status,
    alertLevel:          row.alert_level,
    shutoffStatus:       row.shutoff_status,
    shutoffFiredAt:      row.shutoff_fired_at,
    shutoffCompletedAt:  row.shutoff_completed_at,
  };
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

// GET /api/sensors
sensorsRouter.get('/', (_req: Request, res: Response) => {
  const rows = getDb().prepare('SELECT * FROM sensors ORDER BY alias').all() as SensorRow[];
  res.json(rows.map(toPublicSensor));
});

// GET /api/sensors/:id
sensorsRouter.get('/:id', (req: Request, res: Response) => {
  const row = getDb().prepare('SELECT * FROM sensors WHERE id = ?').get(req.params.id) as SensorRow | undefined;
  if (!row) return res.status(404).json({ error: 'Sensor not found', code: 'NOT_FOUND' });
  res.json(toPublicSensor(row));
});

// POST /api/sensors — admin only
sensorsRouter.post('/', requireAdmin, (req: Request, res: Response) => {
  const { sensorId, type = 'flow', alias, config } = req.body as {
    sensorId?: string; type?: string; alias?: string; config?: unknown;
  };
  if (!sensorId?.trim() || !alias?.trim()) {
    return res.status(400).json({ error: '`sensorId` and `alias` are required', code: 'VALIDATION_ERROR' });
  }

  try {
    const result = getDb().prepare(`
      INSERT INTO sensors (sensor_id, type, alias, config)
      VALUES (?, ?, ?, ?)
    `).run(sensorId, type, alias, config ? JSON.stringify(config) : null);

    const row = getDb().prepare('SELECT * FROM sensors WHERE id = ?').get(result.lastInsertRowid) as SensorRow;
    logger.info({ sensorKey: sensorId, alias }, 'Sensor created');
    res.status(201).json(toPublicSensor(row));
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('UNIQUE')) {
      return res.status(409).json({ error: 'sensorId already exists', code: 'CONFLICT' });
    }
    throw err;
  }
});

// PUT /api/sensors/:id — admin only (alias + full config replace)
sensorsRouter.put('/:id', requireAdmin, (req: Request, res: Response) => {
  const { alias, config } = req.body as { alias?: string; config?: unknown };
  const db = getDb();
  const row = db.prepare('SELECT * FROM sensors WHERE id = ?').get(req.params.id) as SensorRow | undefined;
  if (!row) return res.status(404).json({ error: 'Sensor not found', code: 'NOT_FOUND' });

  db.prepare('UPDATE sensors SET alias = COALESCE(?, alias), config = ? WHERE id = ?')
    .run(alias ?? null, config ? JSON.stringify(config) : row.config, req.params.id);

  const updated = db.prepare('SELECT * FROM sensors WHERE id = ?').get(req.params.id) as SensorRow;
  res.json(toPublicSensor(updated));
});

// PUT /api/sensors/:id/config — admin only (config-only update; bumps version)
sensorsRouter.put('/:id/config', requireAdmin, (req: Request, res: Response) => {
  const incoming = req.body as Record<string, unknown>;
  const db = getDb();
  const row = db.prepare('SELECT * FROM sensors WHERE id = ?').get(req.params.id) as SensorRow | undefined;
  if (!row) return res.status(404).json({ error: 'Sensor not found', code: 'NOT_FOUND' });

  const current = row.config ? (safeJson(row.config) as Record<string, unknown>) ?? {} : {};
  const merged: Record<string, unknown> = { ...current, ...incoming };
  merged.version = (typeof current.version === 'number' ? current.version : 0) + 1;

  db.prepare('UPDATE sensors SET config = ? WHERE id = ?')
    .run(JSON.stringify(merged), req.params.id);

  const updated = db.prepare('SELECT * FROM sensors WHERE id = ?').get(req.params.id) as SensorRow;
  res.json(toPublicSensor(updated));
});

// DELETE /api/sensors/:id — admin only
sensorsRouter.delete('/:id', requireAdmin, (req: Request, res: Response) => {
  const result = getDb().prepare('DELETE FROM sensors WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Sensor not found', code: 'NOT_FOUND' });
  res.status(204).end();
});

// GET /api/sensors/:id/readings?from=&to=&limit=
sensorsRouter.get('/:id/readings', (req: Request, res: Response) => {
  const from  = strQuery(req.query.from);
  const to    = strQuery(req.query.to);
  const limit = clampInt(req.query.limit, 1000, 1, 10_000);

  const params: (string | number)[] = [String(req.params.id)];
  let where = 'WHERE sensor_id = ?';
  if (from) { where += ' AND recorded_at >= ?'; params.push(from.replace('T', ' ').replace('Z', '')); }
  if (to)   { where += ' AND recorded_at <  ?'; params.push(to.replace('T', ' ').replace('Z', '')); }
  params.push(limit);

  const rows = getDb().prepare(`
    SELECT id, sensor_id, rate_m3h, total_m3, signal_quality, recorded_at
    FROM flow_readings
    ${where}
    ORDER BY recorded_at DESC
    LIMIT ?
  `).all(...params) as Array<{
    id: number; sensor_id: number; rate_m3h: number; total_m3: number | null;
    signal_quality: number | null; recorded_at: string;
  }>;

  res.json(rows.map((r) => ({
    id: r.id, sensorId: r.sensor_id, rateM3h: r.rate_m3h,
    totalM3: r.total_m3, signalQuality: r.signal_quality, recordedAt: r.recorded_at,
  })));
});

// GET /api/sensors/:id/events?status=&limit=
sensorsRouter.get('/:id/events', (req: Request, res: Response) => {
  const status = strQuery(req.query.status);
  const limit  = clampInt(req.query.limit, 100, 1, 1000);

  const params: (string | number)[] = [String(req.params.id)];
  let where = 'WHERE sensor_id = ?';
  if (status === 'active' || status === 'closed') {
    where += ' AND status = ?'; params.push(status);
  }
  params.push(limit);

  const rows = getDb().prepare(`
    SELECT * FROM flow_events
    ${where}
    ORDER BY start_time DESC
    LIMIT ?
  `).all(...params) as FlowEventRow[];

  res.json(rows.map(toPublicEvent));
});

// GET /api/sensors/:id/events/:eventId
sensorsRouter.get('/:id/events/:eventId', (req: Request, res: Response) => {
  const row = getDb().prepare('SELECT * FROM flow_events WHERE id = ? AND sensor_id = ?')
    .get(req.params.eventId, req.params.id) as FlowEventRow | undefined;
  if (!row) return res.status(404).json({ error: 'Event not found', code: 'NOT_FOUND' });
  res.json(toPublicEvent(row));
});

// POST /api/sensors/:id/events/:eventId/ack
sensorsRouter.post('/:id/events/:eventId/ack', (req: Request, res: Response) => {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ error: 'Unauthenticated', code: 'UNAUTHORIZED' });

  const event = getDb().prepare('SELECT * FROM flow_events WHERE id = ? AND sensor_id = ?')
    .get(req.params.eventId, req.params.id) as FlowEventRow | undefined;
  if (!event) return res.status(404).json({ error: 'Event not found', code: 'NOT_FOUND' });

  const { reason } = req.body as { reason?: string };
  getDb().prepare('INSERT INTO flow_event_acks (event_id, user_id, reason) VALUES (?, ?, ?)')
    .run(event.id, userId, reason ?? null);

  logger.info({ eventId: event.id, userId, reason }, 'Flow event acknowledged');
  res.status(201).json({ acked: true });
});

// GET /api/sensors/:id/consumption?bucket=hour|day|month&from=&to=
sensorsRouter.get('/:id/consumption', (req: Request, res: Response) => {
  const bucketParam = strQuery(req.query.bucket) ?? 'day';
  if (bucketParam !== 'hour' && bucketParam !== 'day' && bucketParam !== 'month') {
    return res.status(400).json({ error: 'bucket must be hour, day, or month', code: 'VALIDATION_ERROR' });
  }
  const sensorId = Number(req.params.id);
  if (!Number.isInteger(sensorId)) {
    return res.status(400).json({ error: 'sensor id must be an integer', code: 'VALIDATION_ERROR' });
  }

  const buckets = getConsumptionBuckets(
    sensorId,
    bucketParam as Bucket,
    strQuery(req.query.from) ?? null,
    strQuery(req.query.to)   ?? null,
  );
  res.json(buckets);
});

// POST /api/sensors/:id/snooze?hours=4
sensorsRouter.post('/:id/snooze', (req: Request, res: Response) => {
  const hours = Number(req.query.hours ?? req.body?.hours ?? 4);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 72) {
    return res.status(400).json({ error: 'hours must be 0 < h ≤ 72', code: 'VALIDATION_ERROR' });
  }

  const until = new Date(Date.now() + hours * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').replace('Z', '');
  const result = getDb().prepare('UPDATE sensors SET snoozed_until = ? WHERE id = ?')
    .run(until, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Sensor not found', code: 'NOT_FOUND' });

  logger.info({ sensorId: req.params.id, hours, until }, 'Sensor snoozed');
  res.json({ snoozedUntil: until });
});

// DELETE /api/sensors/:id/snooze
sensorsRouter.delete('/:id/snooze', (req: Request, res: Response) => {
  const result = getDb().prepare('UPDATE sensors SET snoozed_until = NULL WHERE id = ?')
    .run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Sensor not found', code: 'NOT_FOUND' });
  res.status(204).end();
});

// POST /api/sensors/:id/ota — admin only.
// Dispatches an OTA to the device by POSTing the firmware URL to its
// /ota endpoint. Body: { releaseId: number }. The URL we post points
// back at this HomeHub's /firmware/<filename> public route, which the
// device then pulls over LAN.
sensorsRouter.post('/:id/ota', requireAdmin, async (req: Request, res: Response) => {
  const { releaseId } = req.body as { releaseId?: number };
  if (typeof releaseId !== 'number' || !Number.isInteger(releaseId) || releaseId <= 0) {
    return res.status(400).json({ error: '`releaseId` (positive integer) is required', code: 'VALIDATION_ERROR' });
  }

  const sensor = getDb().prepare('SELECT * FROM sensors WHERE id = ?').get(req.params.id) as SensorRow | undefined;
  if (!sensor) return res.status(404).json({ error: 'Sensor not found', code: 'NOT_FOUND' });
  if (!sensor.last_ip) {
    return res.status(409).json({ error: 'Sensor has no last_ip — wait for a reading or check connectivity', code: 'NO_DEVICE_IP' });
  }

  const release = getDb().prepare('SELECT * FROM firmware_releases WHERE id = ?').get(releaseId) as
    { id: number; filename: string; version: string } | undefined;
  if (!release) return res.status(404).json({ error: 'Firmware release not found', code: 'RELEASE_NOT_FOUND' });

  // Build URL the device should fetch. req.protocol is the request's own
  // scheme; req.get('host') is whatever host:port HomeHub was reached at —
  // both come from the admin's browser, so they match the LAN interface
  // the device can also see.
  const homehubUrl = `${req.protocol}://${req.get('host')}/firmware/${release.filename}`;
  const deviceOtaUrl = `http://${sensor.last_ip}/ota`;

  try {
    const r = await fetch(deviceOtaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: homehubUrl }),
      signal: AbortSignal.timeout(10_000),
    });
    const replyBody = await r.text();
    if (!r.ok) {
      logger.warn({ sensorId: sensor.id, ip: sensor.last_ip, status: r.status, replyBody }, 'OTA dispatch rejected by device');
      return res.status(502).json({ error: 'Device rejected OTA', code: 'DEVICE_REJECTED', deviceStatus: r.status, deviceBody: replyBody });
    }
    logger.warn({ sensorId: sensor.id, alias: sensor.alias, version: release.version, ip: sensor.last_ip }, 'OTA dispatched');
    return res.json({ ok: true, dispatchedTo: deviceOtaUrl, firmwareUrl: homehubUrl, version: release.version });
  } catch (err) {
    logger.error({ err, sensorId: sensor.id, ip: sensor.last_ip }, 'OTA dispatch failed');
    return res.status(502).json({ error: 'Could not reach device', code: 'DEVICE_UNREACHABLE', detail: (err as Error).message });
  }
});

// POST /api/sensors/:id/test-shutoff — admin only.
// Manually fires the configured shutoff device WITHOUT touching the engine
// state machine. Used during hardware bring-up to verify the valve actually
// closes from homehub before betting on it during a real L3 event.
sensorsRouter.post('/:id/test-shutoff', requireAdmin, async (req: Request, res: Response) => {
  const row = getDb().prepare('SELECT * FROM sensors WHERE id = ?').get(req.params.id) as SensorRow | undefined;
  if (!row) return res.status(404).json({ error: 'Sensor not found', code: 'NOT_FOUND' });

  const cfg = row.config ? (safeJson(row.config) as { shutoffDeviceId?: number }) : {};
  const deviceId = cfg?.shutoffDeviceId;
  if (typeof deviceId !== 'number' || deviceId <= 0) {
    return res.status(400).json({ error: 'No shutoffDeviceId configured for this sensor', code: 'NO_SHUTOFF_DEVICE' });
  }

  try {
    await realInvoker.closeValve(deviceId);
    logger.warn({ sensorId: row.id, alias: row.alias, deviceId }, 'Manual test-shutoff fired');
    return res.json({ ok: true, deviceId });
  } catch (err) {
    logger.error({ err, deviceId }, 'Manual test-shutoff failed');
    return res.status(503).json({ error: 'Valve actuation failed', code: 'ACTUATION_FAILED', detail: (err as Error).message });
  }
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
