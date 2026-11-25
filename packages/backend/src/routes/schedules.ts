import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { getDb } from '../db';
import { logger } from '../logger';
import { cronProblem } from './cron-check';
import { nextRuns } from './next-run';
import { getHomeSettings, solarLocation } from '../home/home-settings';
import { RoomError, jobFor, roomsView } from '../roomba/rooms';
import { isPlayChoice, playChoiceOf } from '../drivers/SonosDriver';

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
  /** On a Turn ON schedule: turn the device off again this many minutes later. */
  stay_on_minutes: number | null;
  /** A robot vacuum's Clean schedule: its rooms' keys as JSON; null for the whole house. */
  rooms?: string | null;
  /** A Sonos Play schedule: the favorite or Sonos playlist it starts, as JSON { id, title }; null carries on. */
  play?: string | null;
  state: number;
  enabled: number;
  created_at: string;
}

/** A schedule's row with its device's name and kind. */
type Listed = ScheduleRow & { device_alias?: string; driver_type?: string | null; driver_config?: string | null };

/** A robot's schedule's rooms, by key, with each one's name now (null when forgotten); null for the whole house. */
function roomsOf(row: Listed): { keys: string[]; names: (string | null)[] } | null {
  if (row.driver_type !== 'roomba' || !row.rooms) return null;
  let keys: unknown;
  try { keys = JSON.parse(row.rooms); } catch { return null; }
  if (!Array.isArray(keys) || !keys.length) return null;
  const known = new Map(roomsView(row.driver_config ?? null).map((r) => [r.key, r.name]));
  const list = keys.filter((k): k is string => typeof k === 'string');
  return { keys: list, names: list.map((k) => known.get(k) ?? null) };
}

function toPublic(row: Listed) {
  const rooms = roomsOf(row);
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
    stayOnMinutes:      row.stay_on_minutes ?? null,
    /** A robot vacuum's Clean schedule: its rooms, by key and name; null for the whole house. */
    rooms:              rooms?.keys ?? null,
    roomNames:          rooms?.names ?? null,
    /** A Sonos Play schedule: the favorite or Sonos playlist it starts; null carries on with what was playing. */
    play:               row.driver_type === 'sonos' && row.state === 1 ? playChoiceOf(row.play) : null,
    state:              row.state === 1,
    enabled:            row.enabled === 1,
    createdAt:          row.created_at,
    /** Why the scheduler can't run it, so it never fires; null when fine. */
    problem:            (row.trigger_type === 'cron' ? cronProblem(row.cron_expression ?? '') : null)
      ?? (rooms && rooms.names.every((n) => n === null) ? 'None of its rooms is known any more, so it won’t clean.' : null),
  };
}

/** Longest "Turn off after": a day. */
export const MAX_STAY_ON_MINUTES = 24 * 60;

/**
 * "Turn off after" on a Turn ON schedule: a whole number of minutes, up to a
 * day, or nothing (it stays on). Ignored on Turn OFF and auto-off schedules.
 */
function stayOnMinutes(body: { stayOnMinutes?: unknown; state?: unknown; triggerType?: unknown }): number | null | { error: string } {
  const v = body.stayOnMinutes;
  if (v === undefined || v === null || v === '' || body.state !== true || body.triggerType === 'auto_off') return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_STAY_ON_MINUTES) {
    return { error: `stayOnMinutes must be a whole number of minutes from 1 to ${MAX_STAY_ON_MINUTES}` };
  }
  return v;
}

const SELECT = 'SELECT s.*, d.alias AS device_alias, d.driver_type, d.driver_config FROM schedules s JOIN devices d ON d.id = s.device_id';
const LIST_SQL = `${SELECT} ORDER BY s.created_at DESC`;
const ONE_SQL = `${SELECT} WHERE s.id = ?`;

/** Most rooms one Clean schedule can name. */
const MAX_ROOMS = 30;

/**
 * A robot vacuum's Clean schedule's rooms, checked as a job for them would be: named, and on one map.
 * JSON for the rooms column; null for the whole house, and for anything but a robot's Clean schedule.
 */
function scheduleRooms(body: { rooms?: unknown; state?: unknown; triggerType?: unknown }, device: { id: number; driver_type: string | null }): string | null | { error: string } {
  const v = body.rooms;
  if (device.driver_type !== 'roomba' || body.state !== true || body.triggerType === 'auto_off') return null;
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > MAX_ROOMS || v.some((k) => typeof k !== 'string' || !k)) {
    return { error: `rooms must be a list of up to ${MAX_ROOMS} room keys, or left out for the whole house` };
  }
  if (!v.length) return null;
  const keys = [...new Set(v as string[])];
  try { jobFor(device.id, keys); } catch (err) {
    if (err instanceof RoomError) return { error: err.message };
    throw err;
  }
  return JSON.stringify(keys);
}

/**
 * A Sonos Play schedule's favorite or Sonos playlist, as JSON for the play column. Null to carry on
 * with what was playing, and for anything but a speaker's Play schedule.
 */
function schedulePlay(body: { play?: unknown; state?: unknown; triggerType?: unknown }, device: { driver_type: string | null }): string | null | { error: string } {
  const v = body.play;
  if (device.driver_type !== 'sonos' || body.state !== true || body.triggerType === 'auto_off') return null;
  if (v === undefined || v === null) return null;
  if (!isPlayChoice(v)) return { error: 'play must be a favorite or Sonos playlist from the list ({ id, title }), or left out' };
  return JSON.stringify({ id: v.id, title: v.title.trim() });
}

// GET /api/schedules
schedulesRouter.get('/', (_req: Request, res: Response) => {
  const rows = getDb().prepare(LIST_SQL).all() as Listed[];
  // When each runs next, for the page's "Coming up". A failure here never hides the list.
  let next = new Map<number, string | null>();
  try { next = nextRuns(rows, new Date(), getHomeSettings().timezone, solarLocation()); }
  catch (err) { logger.warn({ err }, 'Could not work out next run times'); }
  res.json(rows.map((r) => ({ ...toPublic(r), next: next.get(r.id) ?? null })));
});

// GET /api/schedules/:id
schedulesRouter.get('/:id', (req: Request, res: Response) => {
  const row = getDb().prepare(ONE_SQL).get(req.params.id) as Listed | undefined;
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
  const badCron = triggerType === 'cron' ? cronProblem(cronExpression!) : null;
  if (badCron) return res.status(400).json({ error: badCron, code: 'INVALID_CRON' });
  if (triggerType === 'solar' && (!solarEvent || !SOLAR_EVENTS.includes(solarEvent))) {
    return res.status(400).json({ error: `solarEvent must be one of: ${SOLAR_EVENTS.join(', ')}`, code: 'VALIDATION_ERROR' });
  }
  if (triggerType === 'auto_off' && (!durationMinutes || durationMinutes <= 0)) {
    return res.status(400).json({ error: 'durationMinutes (>0) required for auto_off trigger', code: 'VALIDATION_ERROR' });
  }
  const db = getDb();
  const device = db.prepare('SELECT id, driver_type FROM devices WHERE id = ?').get(deviceId) as { id: number; driver_type: string | null } | undefined;
  if (!device) return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });
  // A robot vacuum stops when its job is done, so "Turn off after" would only send it home part way.
  const stayOn = device.driver_type === 'roomba' ? null : stayOnMinutes(req.body);
  if (stayOn !== null && typeof stayOn === 'object') return res.status(400).json({ error: stayOn.error, code: 'VALIDATION_ERROR' });
  const rooms = scheduleRooms(req.body, device);
  if (rooms !== null && typeof rooms === 'object') return res.status(400).json({ error: rooms.error, code: 'INVALID_ROOMS' });
  const play = schedulePlay(req.body, device);
  if (play !== null && typeof play === 'object') return res.status(400).json({ error: play.error, code: 'VALIDATION_ERROR' });

  try {
    const result = db.prepare(`
      INSERT INTO schedules (device_id, label, trigger_type, cron_expression, solar_event, solar_offset_minutes, duration_minutes, stay_on_minutes, rooms, play, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(deviceId, label, triggerType, cronExpression ?? null, solarEvent ?? null, solarOffsetMinutes, durationMinutes ?? null, stayOn, rooms, play, state ? 1 : 0);

    const created = db.prepare(ONE_SQL).get(result.lastInsertRowid) as Listed;

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
  const badCron = triggerType === 'cron' ? cronProblem(cronExpression!) : null;
  if (badCron) return res.status(400).json({ error: badCron, code: 'INVALID_CRON' });
  if (triggerType === 'solar' && (!solarEvent || !SOLAR_EVENTS.includes(solarEvent))) {
    return res.status(400).json({ error: `solarEvent must be one of: ${SOLAR_EVENTS.join(', ')}`, code: 'VALIDATION_ERROR' });
  }
  if (triggerType === 'auto_off' && (!durationMinutes || durationMinutes <= 0)) {
    return res.status(400).json({ error: 'durationMinutes (>0) required for auto_off trigger', code: 'VALIDATION_ERROR' });
  }
  const db = getDb();
  const device = db.prepare('SELECT id, driver_type FROM devices WHERE id = ?').get(deviceId) as { id: number; driver_type: string | null } | undefined;
  if (!device) return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });
  // A robot vacuum stops when its job is done, so "Turn off after" would only send it home part way.
  const stayOn = device.driver_type === 'roomba' ? null : stayOnMinutes(req.body);
  if (stayOn !== null && typeof stayOn === 'object') return res.status(400).json({ error: stayOn.error, code: 'VALIDATION_ERROR' });
  const rooms = scheduleRooms(req.body, device);
  if (rooms !== null && typeof rooms === 'object') return res.status(400).json({ error: rooms.error, code: 'INVALID_ROOMS' });
  const play = schedulePlay(req.body, device);
  if (play !== null && typeof play === 'object') return res.status(400).json({ error: play.error, code: 'VALIDATION_ERROR' });

  const result = db.prepare(`
    UPDATE schedules
    SET device_id = ?, label = ?, trigger_type = ?, cron_expression = ?,
        solar_event = ?, solar_offset_minutes = ?, duration_minutes = ?, stay_on_minutes = ?, rooms = ?, play = ?, state = ?
    WHERE id = ?
  `).run(deviceId, label, triggerType, cronExpression ?? null, solarEvent ?? null, solarOffsetMinutes, durationMinutes ?? null, stayOn, rooms, play, state ? 1 : 0, req.params.id);

  if (result.changes === 0) return res.status(404).json({ error: 'Schedule not found', code: 'NOT_FOUND' });

  const updated = db.prepare(ONE_SQL).get(req.params.id) as Listed;

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

  const updated = db.prepare(ONE_SQL).get(req.params.id) as Listed;

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
export function notifyScheduler(): void {
  const url = `${process.env.SCHEDULER_URL || 'http://scheduler:3002'}/reload`;
  const key  = process.env.INTERNAL_API_KEY || '';
  fetch(url, { method: 'POST', headers: { 'x-internal-key': key } })
    .catch((err) => logger.warn({ err: err.message }, 'Could not notify scheduler'));
}
