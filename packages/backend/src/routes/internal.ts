import { Router, Request, Response } from 'express';
import { requireInternalKey } from '../middleware/internal';
import { getDb } from '../db';
import { setPowerState } from '../kasa/kasa.service';
import { getCachedState } from '../kasa/device.cache';
import { emitDeviceState } from '../socket';
import { logger } from '../logger';

export const internalRouter = Router();

internalRouter.use(requireInternalKey);

interface DeviceRow { id: number; alias: string; ip: string; }

// POST /internal/devices/:id/execute  { state: boolean }
// Called by the scheduler when a scheduled action fires.
internalRouter.post('/devices/:id/execute', async (req: Request, res: Response) => {
  const db     = getDb();
  const device = db.prepare('SELECT id, alias, ip FROM devices WHERE id = ?')
    .get(req.params.id) as DeviceRow | undefined;

  if (!device) {
    return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });
  }

  const { state } = req.body as { state: boolean };
  if (typeof state !== 'boolean') {
    return res.status(400).json({ error: '`state` must be a boolean', code: 'VALIDATION_ERROR' });
  }

  try {
    await setPowerState(device.ip, state);
    emitDeviceState(device.id, device.alias, state, getCachedState(device.id)?.wattage ?? null);
    logger.info({ deviceId: device.id, alias: device.alias, state }, 'Scheduled action executed');
    res.json({ alias: device.alias, state });
  } catch (err) {
    logger.error(err, 'Scheduled execute failed');
    res.status(503).json({ error: 'Device unreachable', code: 'DEVICE_UNREACHABLE' });
  }
});
