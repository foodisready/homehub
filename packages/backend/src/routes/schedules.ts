import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { getDb } from '../db';
import { logger } from '../logger';

export const schedulesRouter = Router();

const SOLAR_EVENTS = ['sunrise', 'sunset', 'dawn', 'dusk', 'goldenHour', 'solarNoon'] as const;
type SolarEvent = typeof SOLAR_EVENTS[number];

export interface ScheduleRow {
  id: number;
  device_id: number;
  label: string;
  trigger_type: 'cron' | 'solar' | 'auto_off';
  cron_expression: string | null;
  solar_event: SolarEvent | null;
  solar_offset_minutes: number;
  duration_minutes: number | null;
  state: number;
  enabled: number;
  created_at: string;
}

function toPublic(row: ScheduleRow & { device_alias?: string }) {
  return {
    id:                 row.id,
    deviceId:           row.device_id,
    deviceAlias:        row.device_alias ?? null,
    label:              row.label,
    triggerType:        row.trigger_type,
    cronExpression:     row.cron_expression,
    solarEvent:         row.solar_event,
    solarOffsetMinutes: row.solar_offset_minutes,
    durationMinutes:    row.duration_minutes,
    state:              row.state === 1,
    enabled:            row.enabled === 1,
    createdAt:          row.created_at,
  };
}

const LIST_SQL = `
  SELECT s.*, d.alias AS device_alias
  FROM schedules s
  JOIN devices d ON d.id = s.device_id
  ORDER BY s.created_at DESC
`;

// GET /api/schedules
schedulesRouter.get('/', (_req: Request, res: Response) => {
  const rows = getDb().prepare(LIST_SQL).all() as (ScheduleRow & { device_alias: string })[];
  res.json(rows.map(toPublic));
});

// GET /api/schedules/:id
schedulesRouter.get('/:id', (req: Request, res: Response) => {
  const row = getDb().prepare(
    'SELECT s.*, d.alias AS device_alias FROM schedules s JOIN devices d ON d.id = s.device_id WHERE s.id = ?'
  ).get(req.params.id) as (ScheduleRow & { device_alias: string }) | undefined;
  if (!row) return res.status(404).json({ error: 'Schedule not found', code: 'NOT_FOUND' });
  res.json(toPublic(row));
});

// POST /api/schedules — admin only
schedulesRouter.post('/', requireAdmin, (req: Request, res: Response) => {
  const {
    deviceId, label, triggerType,
    cronExpression, solarEvent, solarOffsetMinutes = 0, durationMinutes, state,
  } = req.body as {
    deviceId: number; label: string; triggerType: 'cron' | 'solar' | 'auto_off';
    cronExpression?: string; solarEvent?: SolarEvent;
    solarOffsetMinutes?: number; durationMinutes?: number; state: boolean;
  };

  if (!deviceId || !label || !triggerType || typeof state !== 'boolean') {
    return res.status(400).json({ error: 'deviceId, label, triggerType and state are required', code: 'VALIDATION_ERROR' });
  }
  if (triggerType === 'cron' && !cronExpression) {
    return res.status(400).json({ error: 'cronExpression required for cron trigger', code: 'VALIDATION_ERROR' });
  }
  if (triggerType === 'solar' && (!solarEvent || !SOLAR_EVENTS.includes(solarEvent))) {
    return res.status(400).json({ error: `solarEvent must be one of: ${SOLAR_EVENTS.join(', ')}`, code: 'VALIDATION_ERROR' });
  }
  if (triggerType === 'auto_off' && (!durationMinutes || durationMinutes <= 0)) {
    return res.status(400).json({ error: 'durationMinutes (>0) required for auto_off trigger', code: 'VALIDATION_ERROR' });
  }

  const db = getDb();
  const device = db.prepare('SELECT id FROM devices WHERE id = ?').get(deviceId);
  if (!device) return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });

  try {
    const result = db.prepare(`
      INSERT INTO schedules (device_id, label, trigger_type, cron_expression, solar_event, solar_offset_minutes, duration_minutes, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(deviceId, label, triggerType, cronExpression ?? null, solarEvent ?? null, solarOffsetMinutes, durationMinutes ?? null, state ? 1 : 0);

    const created = db.prepare(
      'SELECT s.*, d.alias AS device_alias FROM schedules s JOIN devices d ON d.id = s.device_id WHERE s.id = ?'
    ).get(result.lastInsertRowid) as (ScheduleRow & { device_alias: string });

    notifyScheduler();
    logger.info({ scheduleId: created.id, label, triggerType }, 'Schedule created');
    res.status(201).json(toPublic(created));
  } catch (err: any) {
    throw err;
  }
});

// PUT /api/schedules/:id — admin only
schedulesRouter.put('/:id', requireAdmin, (req: Request, res: Response) => {
  const {
    deviceId, label, triggerType,
    cronExpression, solarEvent, solarOffsetMinutes = 0, durationMinutes, state,
  } = req.body as {
    deviceId: number; label: string; triggerType: 'cron' | 'solar' | 'auto_off';
    cronExpression?: string; solarEvent?: SolarEvent;
    solarOffsetMinutes?: number; durationMinutes?: number; state: boolean;
  };

  if (!deviceId || !label || !triggerType || typeof state !== 'boolean') {
    return res.status(400).json({ error: 'deviceId, label, triggerType and state are required', code: 'VALIDATION_ERROR' });
  }
  if (triggerType === 'cron' && !cronExpression) {
    return res.status(400).json({ error: 'cronExpression required for cron trigger', code: 'VALIDATION_ERROR' });
  }
  if (triggerType === 'solar' && (!solarEvent || !SOLAR_EVENTS.includes(solarEvent))) {
    return res.status(400).json({ error: `solarEvent must be one of: ${SOLAR_EVENTS.join(', ')}`, code: 'VALIDATION_ERROR' });
  }
  if (triggerType === 'auto_off' && (!durationMinutes || durationMinutes <= 0)) {
    return res.status(400).json({ error: 'durationMinutes (>0) required for auto_off trigger', code: 'VALIDATION_ERROR' });
  }

  const db = getDb();
  const device = db.prepare('SELECT id FROM devices WHERE id = ?').get(deviceId);
  if (!device) return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });

  const result = db.prepare(`
    UPDATE schedules
    SET device_id = ?, label = ?, trigger_type = ?, cron_expression = ?,
        solar_event = ?, solar_offset_minutes = ?, duration_minutes = ?, state = ?
    WHERE id = ?
  `).run(deviceId, label, triggerType, cronExpression ?? null, solarEvent ?? null, solarOffsetMinutes, durationMinutes ?? null, state ? 1 : 0, req.params.id);

  if (result.changes === 0) return res.status(404).json({ error: 'Schedule not found', code: 'NOT_FOUND' });

  const updated = db.prepare(
    'SELECT s.*, d.alias AS device_alias FROM schedules s JOIN devices d ON d.id = s.device_id WHERE s.id = ?'
  ).get(req.params.id) as (ScheduleRow & { device_alias: string });

  notifyScheduler();
  logger.info({ scheduleId: updated.id, label, triggerType }, 'Schedule updated');
  res.json(toPublic(updated));
});

// PATCH /api/schedules/:id/toggle — admin only
schedulesRouter.patch('/:id/toggle', requireAdmin, (req: Request, res: Response) => {
  const { enabled } = req.body as { enabled: boolean };
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '`enabled` must be a boolean', code: 'VALIDATION_ERROR' });
  }

  const db     = getDb();
  const result = db.prepare('UPDATE schedules SET enabled = ? WHERE id = ?')
    .run(enabled ? 1 : 0, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Schedule not found', code: 'NOT_FOUND' });

  const updated = db.prepare(
    'SELECT s.*, d.alias AS device_alias FROM schedules s JOIN devices d ON d.id = s.device_id WHERE s.id = ?'
  ).get(req.params.id) as (ScheduleRow & { device_alias: string });

  notifyScheduler();
  res.json(toPublic(updated));
});

// DELETE /api/schedules/:id — admin only
schedulesRouter.delete('/:id', requireAdmin, (req: Request, res: Response) => {
  const result = getDb().prepare('DELETE FROM schedules WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Schedule not found', code: 'NOT_FOUND' });
  notifyScheduler();
  res.status(204).send();
});

/** Tell the scheduler service to reload its jobs after a change. Fire-and-forget. */
function notifyScheduler(): void {
  const url = `${process.env.SCHEDULER_URL || 'http://scheduler:3002'}/reload`;
  const key  = process.env.INTERNAL_API_KEY || '';
  fetch(url, { method: 'POST', headers: { 'x-internal-key': key } })
    .catch((err) => logger.warn({ err: err.message }, 'Could not notify scheduler'));
}
