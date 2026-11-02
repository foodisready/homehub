import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { isProtectedDevice, type PowerDevice } from '../devices/power';
import { logger } from '../logger';
import {
  SensorLoginError, SensorResponseError, connectSensor, createMotionRule, handleMotion, type MotionRuleRow,
} from '../sensors/motion';

const MAX_MINUTES = 24 * 60;

const toPublic = (rule: MotionRuleRow & { alias: string }) => ({
  id:              rule.id,
  name:            rule.name,
  deviceId:        rule.device_id,
  deviceAlias:     rule.alias,
  offAfterMinutes: rule.off_after_minutes,
  turnOnWithMotion: rule.turn_on_with_motion === 1,
  sensorIp:        rule.sensor_ip,
  sensorUsername:  rule.sensor_username,
  hasSensorPassword: !!rule.sensor_password,
  occupied:        rule.occupied === 1,
  lastMotionAt:    rule.last_motion_at,
});

const readRule = (id: unknown) => getDb().prepare(`
  SELECT r.*, d.alias FROM motion_rules r JOIN devices d ON d.id = r.device_id WHERE r.id = ?
`).get(id) as (MotionRuleRow & { alias: string }) | undefined;

const validMinutes = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_MINUTES;

/** Sensors can't log in, so the token in the URL proves who's calling. */
export const motionEventsRouter = Router();

motionEventsRouter.get('/:token/:event', async (req: Request, res: Response) => {
  const { token, event } = req.params;
  if (event !== 'on' && event !== 'off') return res.status(404).end();
  if (!await handleMotion(String(token), event === 'on')) return res.status(404).end();
  res.status(204).end();
});

export const motionRouter = Router();

// GET /api/motion
motionRouter.get('/', (_req: Request, res: Response) => {
  const rules = getDb().prepare(`
    SELECT r.*, d.alias FROM motion_rules r JOIN devices d ON d.id = r.device_id ORDER BY r.name
  `).all() as (MotionRuleRow & { alias: string })[];
  res.json(rules.map(toPublic));
});

// POST /api/motion
motionRouter.post('/', (req: Request, res: Response) => {
  const { name, deviceId, offAfterMinutes, turnOnWithMotion } = req.body as {
    name?: unknown; deviceId?: unknown; offAfterMinutes?: unknown; turnOnWithMotion?: unknown;
  };
  if (typeof name !== 'string' || !name.trim() || !validMinutes(offAfterMinutes)) {
    return res.status(400).json({ error: 'A name and 1 to 1440 minutes are required', code: 'VALIDATION_ERROR' });
  }

  const device = getDb().prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) as PowerDevice | undefined;
  if (!device) return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });
  if (isProtectedDevice(device)) {
    return res.status(400).json({ error: `${device.alias} is protected`, code: 'DEVICE_PROTECTED' });
  }

  try {
    const rule = createMotionRule(name.trim(), device.id, offAfterMinutes, turnOnWithMotion === true);
    res.status(201).json(toPublic(readRule(rule.id)!));
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'That name is already used', code: 'CONFLICT' });
    }
    throw err;
  }
});

// PATCH /api/motion/:id — changes only the fields sent
motionRouter.patch('/:id', (req: Request, res: Response) => {
  const { name, deviceId, offAfterMinutes, turnOnWithMotion } = req.body as {
    name?: unknown; deviceId?: unknown; offAfterMinutes?: unknown; turnOnWithMotion?: unknown;
  };
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ error: 'A name is required', code: 'VALIDATION_ERROR' });
  }
  if (offAfterMinutes !== undefined && !validMinutes(offAfterMinutes)) {
    return res.status(400).json({ error: 'Use 1 to 1440 minutes', code: 'VALIDATION_ERROR' });
  }
  if (turnOnWithMotion !== undefined && typeof turnOnWithMotion !== 'boolean') {
    return res.status(400).json({ error: 'turnOnWithMotion must be true or false', code: 'VALIDATION_ERROR' });
  }

  const db = getDb();
  if (deviceId !== undefined) {
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) as PowerDevice | undefined;
    if (!device) return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });
    if (isProtectedDevice(device)) {
      return res.status(400).json({ error: `${device.alias} is protected`, code: 'DEVICE_PROTECTED' });
    }
  }

  const rule = readRule(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found', code: 'NOT_FOUND' });

  try {
    db.prepare(`
      UPDATE motion_rules
         SET name = ?, device_id = ?, off_after_minutes = ?, turn_on_with_motion = ?
       WHERE id = ?
    `).run(
      name === undefined ? rule.name : (name as string).trim(),
      deviceId ?? rule.device_id,
      offAfterMinutes ?? rule.off_after_minutes,
      turnOnWithMotion === undefined ? rule.turn_on_with_motion : (turnOnWithMotion ? 1 : 0),
      rule.id,
    );
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'That name is already used', code: 'CONFLICT' });
    }
    throw err;
  }
  res.json(toPublic(readRule(rule.id)!));
});

// DELETE /api/motion/:id
motionRouter.delete('/:id', (req: Request, res: Response) => {
  const result = getDb().prepare('DELETE FROM motion_rules WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Rule not found', code: 'NOT_FOUND' });
  res.status(204).end();
});

// POST /api/motion/:id/connect — configures the sensor and saves its login.
// A blank password reuses the saved one, and the password is never returned.
motionRouter.post('/:id/connect', async (req: Request, res: Response) => {
  const { sensorIp, username = '', password: newPassword = '' } = req.body as {
    sensorIp?: unknown; username?: unknown; password?: unknown;
  };
  if (typeof sensorIp !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(sensorIp)
      || typeof username !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'A sensor IP address is required', code: 'VALIDATION_ERROR' });
  }

  const rule = readRule(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found', code: 'NOT_FOUND' });

  const password = newPassword || (rule.sensor_password ?? '');
  const saveLogin = () => getDb().prepare(
    'UPDATE motion_rules SET sensor_ip = ?, sensor_username = ?, sensor_password = ? WHERE id = ?',
  ).run(sensorIp, username, password, rule.id);

  try {
    await connectSensor(rule, sensorIp, username, password);
    saveLogin();
    res.json({ connected: true });
  } catch (err) {
    if (err instanceof SensorLoginError) {
      return res.status(422).json({ error: err.message, code: 'SENSOR_LOGIN_REJECTED' });
    }
    // The login wasn't refused, so keep it for the next try.
    saveLogin();
    logger.warn({ sensorIp, reason: (err as Error).message }, 'Could not connect motion sensor');
    if (err instanceof SensorResponseError) {
      return res.status(502).json({ error: err.message, code: 'SENSOR_REFUSED' });
    }
    res.status(502).json({
      error: "Couldn't reach the sensor. Press its button to wake it, then try again.",
      code: 'SENSOR_UNREACHABLE',
    });
  }
});
