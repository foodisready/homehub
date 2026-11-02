import { Router, Request, Response } from 'express';
import { reconcileDiscovered } from '../drivers/reconcile';
import type { DiscoveredDevice } from '../drivers/DeviceDriver';
import { getDb } from '../db';
import { getCachedState, getAllCachedStates, noteState, pollDeviceNow } from '../kasa/device.cache';
import { getDriver, getAllDrivers } from '../drivers/registry';
import { emitDeviceState } from '../socket';
import { logger } from '../logger';
import { cancelPowerTimer, clearOverride, isProtectedDevice, notifyPowerOff, setOverride } from '../devices/power';
import { requireAdmin } from '../middleware/auth';
import { keepSecrets, withoutSecrets } from '../devices/secrets';
import { lastChanges, recordPower, type LastChange } from '../activity/activity';
import {
  MAX_EXTRA_NETWORKS, displayNetwork, extraNetworks, ownNetworks, saveExtraNetworks, suggestedNetworks,
} from '../discovery/networks';

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
        // The device didn't do what HomeHub asked, so Activity mustn't say it did.
        recordPower(deviceId, actual, { source: 'homehub', detail: "didn't respond to the switch" });
        emitDeviceState(deviceId, alias, actual, prev?.wattage ?? null);
        logger.warn({ deviceId, alias, expectedState, actual }, 'Device state mismatch after setPower — corrected');
      }
    } catch { /* device offline — next poll will handle it */ }
  }, getDriver(driverType).confirmAfterMs ?? 1200);
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
  room: string | null;
  is_protected: number;
}

/** Blank means no room. Returns undefined for anything that isn't a room name. */
function cleanRoom(room: unknown): string | null | undefined {
  if (room === null) return null;
  if (typeof room !== 'string') return undefined;
  return room.trim() || null;
}

function mergeWithCache(device: DeviceRow, changes: Map<number, LastChange> = lastChanges()) {
  const cached = getCachedState(device.id);
  const { config, savedSecrets } = withoutSecrets(device.driver_config ? JSON.parse(device.driver_config) : null);
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
    driverConfig: config,
    savedSecrets,
    nicknames:    device.nicknames ? JSON.parse(device.nicknames) as string[] : [],
    room:         device.room,
    isProtected:  isProtectedDevice(device),
    /** The latest on/off change and what caused it, from Activity. */
    lastChange:   changes.get(device.id) ?? null,
  };
}

// GET /api/devices
devicesRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const devices = db.prepare('SELECT * FROM devices ORDER BY alias').all() as DeviceRow[];
  const changes = lastChanges();
  res.json(devices.map((d) => mergeWithCache(d, changes)));
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
    noteState(device.id, true);
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
    noteState(device.id, false);
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

/** The networks Discover searches, as "192.168.1.x". */
function networksView() {
  return {
    own: ownNetworks().map(displayNetwork),
    extra: extraNetworks().map(displayNetwork),
    suggested: suggestedNetworks().map(displayNetwork),
    max: MAX_EXTRA_NETWORKS,
  };
}

// GET /api/devices/discover/networks
devicesRouter.get('/discover/networks', (_req: Request, res: Response) => {
  res.json(networksView());
});

// PUT /api/devices/discover/networks { networks: ["192.168.1.x"] } — other networks for Discover to search
devicesRouter.put('/discover/networks', requireAdmin, (req: Request, res: Response) => {
  const { networks } = req.body as { networks?: unknown };
  if (!Array.isArray(networks) || networks.some((n) => typeof n !== 'string')) {
    return res.status(400).json({ error: 'networks must be a list of addresses', code: 'VALIDATION_ERROR' });
  }
  try {
    saveExtraNetworks(networks as string[]);
    res.json(networksView());
  } catch (err) {
    res.status(400).json({ error: (err as Error).message, code: 'VALIDATION_ERROR' });
  }
});

// POST /api/devices/discover — fan out discovery across all registered drivers
devicesRouter.post('/discover', requireAdmin, async (_req: Request, res: Response) => {
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
devicesRouter.post('/probe', requireAdmin, async (req: Request, res: Response) => {
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
devicesRouter.post('/', requireAdmin, (req: Request, res: Response) => {
  const { alias, ip, model, hasEmeter = false, driverType = 'kasa', driverConfig, mac, room = null } = req.body as {
    alias: string; ip: string; model?: string; hasEmeter?: boolean;
    driverType?: string; driverConfig?: Record<string, unknown>; mac?: string; room?: string | null;
  };
  if (!alias || !ip) return res.status(400).json({ error: 'alias and ip are required', code: 'VALIDATION_ERROR' });

  const db = getDb();
  try {
    const result = db.prepare(
      'INSERT INTO devices (alias, ip, model, has_emeter, driver_type, driver_config, mac, room) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(alias, ip, model ?? null, hasEmeter ? 1 : 0, driverType, driverConfig ? JSON.stringify(driverConfig) : null, mac ?? null, cleanRoom(room) ?? null);
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(result.lastInsertRowid) as DeviceRow;
    // Learn its state now rather than at the next poll; a slow device mustn't hold up the reply.
    pollDeviceNow(device.id).catch(() => undefined);
    res.status(201).json(mergeWithCache(device));
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Alias or IP already exists', code: 'CONFLICT' });
    }
    throw err;
  }
});

// PATCH /api/devices/:id — update alias or ip
devicesRouter.patch('/:id', requireAdmin, (req: Request, res: Response) => {
  const db = getDb();
  const device = db.prepare('SELECT * FROM devices WHERE id = ? OR alias = ?')
    .get(req.params.id, req.params.id) as DeviceRow | undefined;
  if (!device) return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });

  const { alias, ip, icon, driverType, driverConfig, mac, nicknames, isProtected, room } = req.body as {
    alias?: string; ip?: string; icon?: string;
    driverType?: string; driverConfig?: Record<string, unknown> | null; mac?: string;
    nicknames?: string[]; isProtected?: boolean; room?: string | null;
  };
  if (room !== undefined && cleanRoom(room) === undefined) {
    return res.status(400).json({ error: 'room must be text', code: 'VALIDATION_ERROR' });
  }
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
  // The browser never sees saved passwords and keys, so an edit that leaves one out keeps it.
  const newDriverConfig = driverConfig !== undefined
    ? (driverConfig ? JSON.stringify(keepSecrets(driverConfig, device.driver_config ? JSON.parse(device.driver_config) : null)) : null)
    : device.driver_config;
  const newMac          = mac         ?? device.mac;
  const newNicknames    = nicknames
    ? JSON.stringify([...new Set(nicknames.map((n) => n.trim()).filter(Boolean))])
    : device.nicknames;
  const newProtected    = isProtected === undefined ? device.is_protected : (isProtected ? 1 : 0);
  const newRoom         = room === undefined ? device.room : cleanRoom(room);

  try {
    db.prepare(`
      UPDATE devices
         SET alias = ?, ip = ?, icon = ?, driver_type = ?, driver_config = ?, mac = ?, nicknames = ?, is_protected = ?, room = ?
       WHERE id = ?
    `).run(newAlias, newIp, newIcon, newDriverType, newDriverConfig, newMac, newNicknames, newProtected, newRoom, device.id);
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
    noteState(device.id, state);
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
devicesRouter.delete('/:id', requireAdmin, (req: Request, res: Response) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM devices WHERE id = ? OR alias = ?')
    .run(req.params.id, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });
  res.status(204).send();
});
