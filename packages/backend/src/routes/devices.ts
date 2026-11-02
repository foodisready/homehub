import { Router, Request, Response } from 'express';
import { reconcileDiscovered } from '../drivers/reconcile';
import type { DiscoveredDevice } from '../drivers/DeviceDriver';
import { getDb } from '../db';
import { getCachedState, getAllCachedStates } from '../kasa/device.cache';
import { getDriver, getAllDrivers } from '../drivers/registry';
import { emitDeviceState } from '../socket';
import { logger } from '../logger';
import { cancelPowerTimer, clearOverride, isProtectedDevice, notifyPowerOff, setOverride } from '../devices/power';

function confirmStateAsync(
  deviceId: number,
  alias: string,
  driverType: string,
  ip: string,
  config: Record<string, unknown> | undefined,
  expectedState: boolean,
): void {
  setTimeout(async () => {
    try {
      const actual = await getDriver(driverType).getPower(ip, config);
      const states = getAllCachedStates();
      const prev   = states.get(deviceId);
      states.set(deviceId, { state: actual, wattage: prev?.wattage ?? null, online: true, lastPolled: new Date() });
      if (actual !== expectedState) {
        emitDeviceState(deviceId, alias, actual, prev?.wattage ?? null);
        logger.warn({ deviceId, alias, expectedState, actual }, 'Device state mismatch after setPower — corrected');
      }
    } catch { /* device offline — next poll will handle it */ }
  }, 1200);
}

export const devicesRouter = Router();

interface DeviceRow {
  id: number;
  alias: string;
  ip: string;
  model: string | null;
  has_emeter: number;
  icon: string | null;
  created_at: string;
  override_state: number | null;
  override_until: string | null;
  driver_type: string;
  driver_config: string | null;
  mac: string | null;
  nicknames: string | null;
  is_protected: number;
}

function mergeWithCache(device: DeviceRow) {
  const cached = getCachedState(device.id);
  return {
    id:            device.id,
    alias:         device.alias,
    ip:            device.ip,
    model:         device.model,
    hasEmeter:     device.has_emeter === 1,
    icon:          device.icon,
    state:         cached?.state   ?? false,
    wattage:       cached?.wattage ?? null,
    online:        cached?.online  ?? true,   // optimistic until first poll
    overrideState: device.override_state != null ? device.override_state === 1 : null,
    overrideUntil: device.override_until
      ? device.override_until.replace(' ', 'T') + 'Z'
      : null,
    driverType:   device.driver_type ?? 'kasa',
    driverConfig: device.driver_config ? JSON.parse(device.driver_config) : null,
    nicknames:    device.nicknames ? JSON.parse(device.nicknames) as string[] : [],
    isProtected:  isProtectedDevice(device),
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
    const config = device.driver_config ? JSON.parse(device.driver_config) : undefined;
    await getDriver(device.driver_type ?? 'kasa').setPower(device.ip, true, config);
    db.prepare("UPDATE devices SET turned_on_at = datetime('now') WHERE id = ?").run(device.id);
    cancelPowerTimer(device.id);
    emitDeviceState(device.id, device.alias, true, getCachedState(device.id)?.wattage ?? null);
    confirmStateAsync(device.id, device.alias, device.driver_type ?? 'kasa', device.ip, config, true);
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
    const config = device.driver_config ? JSON.parse(device.driver_config) : undefined;
    await getDriver(device.driver_type ?? 'kasa').setPower(device.ip, false, config);
    db.prepare('UPDATE devices SET turned_on_at = NULL WHERE id = ?').run(device.id);
    cancelPowerTimer(device.id);
    emitDeviceState(device.id, device.alias, false, null);
    notifyPowerOff(device.id);
    confirmStateAsync(device.id, device.alias, device.driver_type ?? 'kasa', device.ip, config, false);
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
    const config  = device.driver_config ? JSON.parse(device.driver_config) : undefined;
    const metrics = await getDriver(device.driver_type ?? 'kasa').getEnergy(device.ip, config);
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

// POST /api/devices/discover — fan out discovery across all registered drivers
devicesRouter.post('/discover', async (_req: Request, res: Response) => {
  try {
    // One driver at a time: the Shelly and Tuya subnet sweeps flood the network
    // enough to lose the UDP replies that Kasa discovery depends on.
    const found: DiscoveredDevice[] = [];
    for (const driver of getAllDrivers()) {
      try {
        found.push(...await driver.discover());
      } catch (err) {
        logger.warn({ err, driver: driver.type }, 'Driver discovery failed');
      }
    }
    res.json(reconcileDiscovered(found));
  } catch (err) {
    logger.error(err, 'Discovery failed');
    res.status(500).json({ error: 'Discovery failed', code: 'DISCOVERY_FAILED' });
  }
});

// POST /api/devices/probe — probe a single IP to identify its device type and metadata
devicesRouter.post('/probe', async (req: Request, res: Response) => {
  const { ip, driverType } = req.body as { ip?: string; driverType?: string };
  if (!ip) return res.status(400).json({ error: 'ip is required', code: 'VALIDATION_ERROR' });

  const typesToTry = driverType ? [driverType] : getAllDrivers().map((d) => d.type);
  for (const type of typesToTry) {
    try {
      const result = await getDriver(type).probe(ip);
      if (result) return res.json({ ...result, driverType: type });
    } catch {}
  }
  res.status(404).json({ error: `No device found at ${ip}`, code: 'DEVICE_NOT_FOUND' });
});

// POST /api/devices — manually register a device
devicesRouter.post('/', (req: Request, res: Response) => {
  const { alias, ip, model, hasEmeter = false, driverType = 'kasa', driverConfig, mac } = req.body as {
    alias: string; ip: string; model?: string; hasEmeter?: boolean;
    driverType?: string; driverConfig?: Record<string, unknown>; mac?: string;
  };
  if (!alias || !ip) return res.status(400).json({ error: 'alias and ip are required', code: 'VALIDATION_ERROR' });

  const db = getDb();
  try {
    const result = db.prepare(
      'INSERT INTO devices (alias, ip, model, has_emeter, driver_type, driver_config, mac) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(alias, ip, model ?? null, hasEmeter ? 1 : 0, driverType, driverConfig ? JSON.stringify(driverConfig) : null, mac ?? null);
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

  const { alias, ip, icon, driverType, driverConfig, mac, nicknames, isProtected } = req.body as {
    alias?: string; ip?: string; icon?: string;
    driverType?: string; driverConfig?: Record<string, unknown> | null; mac?: string;
    nicknames?: string[]; isProtected?: boolean;
  };
  if (nicknames !== undefined && (!Array.isArray(nicknames) || nicknames.some((n) => typeof n !== 'string'))) {
    return res.status(400).json({ error: 'nicknames must be a list of names', code: 'VALIDATION_ERROR' });
  }
  if (isProtected !== undefined && typeof isProtected !== 'boolean') {
    return res.status(400).json({ error: 'isProtected must be true or false', code: 'VALIDATION_ERROR' });
  }
  const newAlias        = alias       ?? device.alias;
  const newIp           = ip          ?? device.ip;
  const newIcon         = icon        ?? device.icon;
  const newDriverType   = driverType  ?? device.driver_type;
  const newDriverConfig = driverConfig !== undefined
    ? (driverConfig ? JSON.stringify(driverConfig) : null)
    : device.driver_config;
  const newMac          = mac         ?? device.mac;
  const newNicknames    = nicknames
    ? JSON.stringify([...new Set(nicknames.map((n) => n.trim()).filter(Boolean))])
    : device.nicknames;
  const newProtected    = isProtected === undefined ? device.is_protected : (isProtected ? 1 : 0);

  try {
    db.prepare(`
      UPDATE devices
         SET alias = ?, ip = ?, icon = ?, driver_type = ?, driver_config = ?, mac = ?, nicknames = ?, is_protected = ?
       WHERE id = ?
    `).run(newAlias, newIp, newIcon, newDriverType, newDriverConfig, newMac, newNicknames, newProtected, device.id);
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Another device already uses that name or IP address', code: 'CONFLICT' });
    }
    throw err;
  }

  const updated = db.prepare('SELECT * FROM devices WHERE id = ?').get(device.id) as DeviceRow;
  res.json(mergeWithCache(updated));
});

// POST /api/devices/:id/override — hold a state for N minutes; a device held on then turns off
devicesRouter.post('/:id/override', async (req: Request, res: Response) => {
  const { state, durationMinutes } = req.body as { state?: boolean; durationMinutes?: number };
  if (typeof state !== 'boolean' || !Number.isFinite(durationMinutes) || durationMinutes! <= 0) {
    return res.status(400).json({ error: 'state (boolean) and durationMinutes (>0) are required', code: 'VALIDATION_ERROR' });
  }

  const db = getDb();
  const device = db.prepare('SELECT * FROM devices WHERE id = ? OR alias = ?')
    .get(req.params.id, req.params.id) as DeviceRow | undefined;
  if (!device) return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });

  setOverride(device.id, state, durationMinutes!);

  try {
    const config = device.driver_config ? JSON.parse(device.driver_config) : undefined;
    await getDriver(device.driver_type ?? 'kasa').setPower(device.ip, state, config);
    emitDeviceState(device.id, device.alias, state, getCachedState(device.id)?.wattage ?? null);
  } catch (err) {
    logger.warn({ ip: device.ip }, 'Could not apply override state immediately');
    // A timer on a lamp that never came on would report something untrue.
    if (state) {
      clearOverride(device.id);
      return res.status(503).json({ error: 'Device unreachable', code: 'DEVICE_UNREACHABLE' });
    }
  }

  const updated = db.prepare('SELECT * FROM devices WHERE id = ?').get(device.id) as DeviceRow;
  logger.info({ deviceId: device.id, state, durationMinutes }, 'Override set');
  res.json(mergeWithCache(updated));
});

// DELETE /api/devices/:id/override — cancel active override
devicesRouter.delete('/:id/override', (req: Request, res: Response) => {
  const db = getDb();
  const device = db.prepare('SELECT id FROM devices WHERE id = ? OR alias = ?')
    .get(req.params.id, req.params.id) as { id: number } | undefined;
  if (!device) return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });
  clearOverride(device.id);
  res.status(204).send();
});

// DELETE /api/devices/:id
devicesRouter.delete('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM devices WHERE id = ? OR alias = ?')
    .run(req.params.id, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });
  res.status(204).send();
});
