import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { getCachedState, getAllCachedStates } from '../kasa/device.cache';
import { setPowerState, getEnergyMetrics, discoverDevices } from '../kasa/kasa.service';
import { emitDeviceState } from '../socket';
import { logger } from '../logger';

export const devicesRouter = Router();

interface DeviceRow {
  id: number;
  alias: string;
  ip: string;
  model: string | null;
  has_emeter: number;
  icon: string | null;
  created_at: string;
}

function mergeWithCache(device: DeviceRow) {
  const cached = getCachedState(device.id);
  return {
    id:        device.id,
    alias:     device.alias,
    ip:        device.ip,
    model:     device.model,
    hasEmeter: device.has_emeter === 1,
    icon:      device.icon,
    state:     cached?.state   ?? false,
    wattage:   cached?.wattage ?? null,
    online:    cached?.online  ?? true,   // optimistic until first poll
  };
}

// GET /api/devices
devicesRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const devices = db.prepare('SELECT * FROM devices ORDER BY alias').all() as DeviceRow[];
  res.json(devices.map(mergeWithCache));
});

// GET /api/devices/:id
devicesRouter.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const device = db.prepare('SELECT * FROM devices WHERE id = ? OR alias = ?')
    .get(req.params.id, req.params.id) as DeviceRow | undefined;
  if (!device) return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });
  res.json(mergeWithCache(device));
});

// POST /api/devices/:id/on
devicesRouter.post('/:id/on', async (req: Request, res: Response) => {
  const db = getDb();
  const device = db.prepare('SELECT * FROM devices WHERE id = ? OR alias = ?')
    .get(req.params.id, req.params.id) as DeviceRow | undefined;
  if (!device) return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });

  try {
    await setPowerState(device.ip, true);
    emitDeviceState(device.id, device.alias, true, getCachedState(device.id)?.wattage ?? null);
    res.json({ alias: device.alias, state: true });
  } catch (err) {
    logger.error(err, 'Failed to turn on device');
    res.status(503).json({ error: 'Device unreachable', code: 'DEVICE_UNREACHABLE' });
  }
});

// POST /api/devices/:id/off
devicesRouter.post('/:id/off', async (req: Request, res: Response) => {
  const db = getDb();
  const device = db.prepare('SELECT * FROM devices WHERE id = ? OR alias = ?')
    .get(req.params.id, req.params.id) as DeviceRow | undefined;
  if (!device) return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });

  try {
    await setPowerState(device.ip, false);
    emitDeviceState(device.id, device.alias, false, null);
    res.json({ alias: device.alias, state: false });
  } catch (err) {
    logger.error(err, 'Failed to turn off device');
    res.status(503).json({ error: 'Device unreachable', code: 'DEVICE_UNREACHABLE' });
  }
});

// GET /api/devices/:id/energy
devicesRouter.get('/:id/energy', async (req: Request, res: Response) => {
  const db = getDb();
  const device = db.prepare('SELECT * FROM devices WHERE id = ? OR alias = ?')
    .get(req.params.id, req.params.id) as DeviceRow | undefined;
  if (!device) return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });
  if (!device.has_emeter) return res.status(400).json({ error: 'Device does not support energy monitoring', code: 'NO_EMETER' });

  try {
    const metrics = await getEnergyMetrics(device.ip);
    res.json({ alias: device.alias, ...metrics, recordedAt: new Date().toISOString() });
  } catch (err) {
    logger.error(err, 'Failed to get energy metrics');
    res.status(503).json({ error: 'Device unreachable', code: 'DEVICE_UNREACHABLE' });
  }
});

// GET /api/energy/summary — total live wattage across all online devices
devicesRouter.get('/energy/summary', (_req: Request, res: Response) => {
  const db = getDb();
  const devices = db.prepare('SELECT * FROM devices').all() as DeviceRow[];
  const states = getAllCachedStates();

  const readings = devices.map((d) => {
    const cached = states.get(d.id);
    return { id: d.id, alias: d.alias, wattage: cached?.wattage ?? null, online: cached?.online ?? false };
  });

  const totalWattage = readings.reduce((sum, r) => sum + (r.wattage ?? 0), 0);
  const onlineCount  = readings.filter((r) => r.online).length;

  res.json({ totalWattage, deviceCount: devices.length, onlineCount, readings });
});

// POST /api/devices/discover — trigger UDP broadcast discovery
devicesRouter.post('/discover', async (_req: Request, res: Response) => {
  try {
    const found = await discoverDevices(5000);
    res.json(found);
  } catch (err) {
    logger.error(err, 'Discovery failed');
    res.status(500).json({ error: 'Discovery failed', code: 'DISCOVERY_FAILED' });
  }
});

// POST /api/devices — manually register a device
devicesRouter.post('/', (req: Request, res: Response) => {
  const { alias, ip, model, hasEmeter = false } = req.body as {
    alias: string; ip: string; model?: string; hasEmeter?: boolean;
  };
  if (!alias || !ip) return res.status(400).json({ error: 'alias and ip are required', code: 'VALIDATION_ERROR' });

  const db = getDb();
  try {
    const result = db.prepare(
      'INSERT INTO devices (alias, ip, model, has_emeter) VALUES (?, ?, ?, ?)'
    ).run(alias, ip, model ?? null, hasEmeter ? 1 : 0);
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(result.lastInsertRowid) as DeviceRow;
    res.status(201).json(mergeWithCache(device));
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Alias or IP already exists', code: 'CONFLICT' });
    }
    throw err;
  }
});

// PATCH /api/devices/:id — update alias or ip
devicesRouter.patch('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const device = db.prepare('SELECT * FROM devices WHERE id = ? OR alias = ?')
    .get(req.params.id, req.params.id) as DeviceRow | undefined;
  if (!device) return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });

  const { alias, ip, icon } = req.body as { alias?: string; ip?: string; icon?: string };
  const newAlias = alias ?? device.alias;
  const newIp    = ip    ?? device.ip;
  const newIcon  = icon  ?? device.icon;

  db.prepare('UPDATE devices SET alias = ?, ip = ?, icon = ? WHERE id = ?')
    .run(newAlias, newIp, newIcon, device.id);

  const updated = db.prepare('SELECT * FROM devices WHERE id = ?').get(device.id) as DeviceRow;
  res.json(mergeWithCache(updated));
});

// DELETE /api/devices/:id
devicesRouter.delete('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM devices WHERE id = ? OR alias = ?')
    .run(req.params.id, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });
  res.status(204).send();
});
