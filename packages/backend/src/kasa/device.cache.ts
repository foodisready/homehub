import { getDb } from '../db';
import { getDriver } from '../drivers/registry';
import { emitDeviceState, emitDeviceOnline, emitDeviceEnergy } from '../socket';
import { sendPushToUsers } from '../push/push.service';
import { OfflineAlerts } from './offline-alerts';
import { logger } from '../logger';
import { isActiveServer } from '../system/role';
import { lastPowerState, recordOnline, recordPower } from '../activity/activity';

export interface DeviceState {
  state: boolean;
  wattage: number | null;
  online: boolean;
  lastPolled: Date;
}

const cache = new Map<number, DeviceState>();

/** Device offline notifications go to admins, who can do something about them. */
const offlineAlerts = new OfflineAlerts((id, alias) => {
  const admins = (getDb().prepare("SELECT id FROM users WHERE role = 'admin'").all() as { id: number }[]).map((u) => u.id);
  sendPushToUsers(admins, 'Device offline', `${alias} hasn’t been reachable for 10 minutes`, { url: '/settings?section=devices', deviceId: id });
});

const POLL_INTERVAL_MS = (Number(process.env.ENERGY_POLL_INTERVAL_SECONDS) || 30) * 1000;

export function getCachedState(deviceId: number): DeviceState | undefined {
  return cache.get(deviceId);
}

export function getAllCachedStates(): Map<number, DeviceState> {
  return cache;
}

/**
 * Records a switch HomeHub just made, so the device list shows it straight
 * away rather than after the read-back a moment later. Wattage is kept when
 * turning on, since the next poll measures it.
 */
export function noteState(deviceId: number, state: boolean): void {
  const prev = cache.get(deviceId);
  cache.set(deviceId, { state, wattage: state ? prev?.wattage ?? null : null, online: true, lastPolled: new Date() });
  recordPower(deviceId, state);   // with the cause of the work that made the switch
}

/** Poll a single device, update the cache, and emit socket events. */
// Tuya devices use a stateful TCP connection that gets confused by frequent polling.
// Poll them at most once every 5 minutes — state is updated via confirmStateAsync after toggles.
const TUYA_POLL_INTERVAL_MS = 5 * 60 * 1000;
const tuyaLastPolled = new Map<number, number>();

async function pollDevice(
  id: number,
  ip: string,
  alias: string,
  hasEmeter: boolean,
  driverType: string,
  driverConfig: Record<string, unknown> | undefined,
): Promise<void> {
  // Throttle Tuya polling to avoid connection lockouts. A backup HomeHub doesn't check them at
  // all: each check takes the plug's only connection, and the active HomeHub's Chat, voice and
  // schedules then find it busy. Switching one by hand on the backup still reads it back.
  if (driverType === 'tuya' && !isActiveServer()) return;
  if (driverType === 'tuya') {
    const last = tuyaLastPolled.get(id) ?? 0;
    if (Date.now() - last < TUYA_POLL_INTERVAL_MS) return;
    tuyaLastPolled.set(id, Date.now());
  }

  const prev   = cache.get(id);
  const driver = getDriver(driverType);
  const started = Date.now();
  try {
    const state  = await driver.getPower(ip, driverConfig);
    const energy = hasEmeter ? await driver.getEnergy(ip, driverConfig) : null;
    // A switch landed while this read was in flight: its state is newer, so keep it.
    if ((cache.get(id)?.lastPolled.getTime() ?? 0) > started) return;
    cache.set(id, { state, wattage: energy?.wattage ?? null, online: true, lastPolled: new Date() });

    // HomeHub records its own switches as it makes them, so a change seen here
    // came from outside: a wall switch, the device's app, or while HomeHub was off.
    if (prev?.online ? prev.state !== state : lastPowerState(id) !== null && lastPowerState(id) !== state) {
      recordPower(id, state, { source: 'outside' });
    }
    if (prev && !prev.online) recordOnline(id, true);
    offlineAlerts.reached(id);

    // Track when device was turned on/off (for auto-off schedules)
    const db = getDb();
    if (state) {
      // Seed turned_on_at if lamp is on but has no timestamp (e.g. was on before backend started)
      db.prepare("UPDATE devices SET turned_on_at = datetime('now') WHERE id = ? AND turned_on_at IS NULL").run(id);
    } else if (prev?.online && prev.state !== state) {
      // Clear turned_on_at when lamp turns off
      db.prepare('UPDATE devices SET turned_on_at = NULL WHERE id = ?').run(id);
    }

    // Emit state if it changed or device just came online
    if (!prev?.online || prev.state !== state || prev.wattage !== (energy?.wattage ?? null)) {
      emitDeviceState(id, alias, state, energy?.wattage ?? null);
    }
    if (prev && !prev.online) emitDeviceOnline(id, alias, true);

    // Persist energy reading for history
    if (hasEmeter && energy) {
      const db = getDb();
      db.prepare(
        'INSERT INTO energy_readings (device_id, wattage, voltage, current) VALUES (?, ?, ?, ?)'
      ).run(id, energy.wattage, energy.voltage, energy.current);
      if (energy.wattage != null) emitDeviceEnergy(id, alias, energy.wattage, energy.voltage, energy.current);
    }
  } catch {
    cache.set(id, { state: prev?.state ?? false, wattage: null, online: false, lastPolled: new Date() });
    if (!prev || prev.online) recordOnline(id, false);
    if (!prev || prev.online) emitDeviceOnline(id, alias, false);
    offlineAlerts.missed(id, alias, prev?.online);
    logger.warn({ id, ip }, 'Device unreachable during poll');
  }
}

/** Poll all devices in the DB. */
async function pollAll(): Promise<void> {
  const db = getDb();
  const devices = db.prepare('SELECT id, ip, alias, has_emeter, driver_type, driver_config FROM devices').all() as
    { id: number; ip: string; alias: string; has_emeter: number; driver_type: string; driver_config: string | null }[];

  await Promise.allSettled(
    devices.map((d) => {
      const config = d.driver_config ? JSON.parse(d.driver_config) : undefined;
      return pollDevice(d.id, d.ip, d.alias, d.has_emeter === 1, d.driver_type ?? 'kasa', config);
    })
  );
}

/** Checks one device now, e.g. right after it's added, instead of waiting for the next poll. */
export async function pollDeviceNow(id: number): Promise<void> {
  const d = getDb().prepare('SELECT id, ip, alias, has_emeter, driver_type, driver_config FROM devices WHERE id = ?').get(id) as
    { id: number; ip: string; alias: string; has_emeter: number; driver_type: string; driver_config: string | null } | undefined;
  if (!d) return;
  const config = d.driver_config ? JSON.parse(d.driver_config) : undefined;
  await pollDevice(d.id, d.ip, d.alias, d.has_emeter === 1, d.driver_type ?? 'kasa', config);
}

/** Forget cached states and poll again, after the device list was replaced (e.g. a restore). */
export async function refreshDevices(): Promise<void> {
  cache.clear();
  tuyaLastPolled.clear();
  await pollAll();
}

/** Delete energy readings older than 90 days. */
function pruneOldReadings(): void {
  try {
    const db = getDb();
    const result = db.prepare(
      "DELETE FROM energy_readings WHERE recorded_at < datetime('now', '-90 days')"
    ).run();
    if (result.changes > 0) logger.info({ deleted: result.changes }, 'Pruned old energy readings');
  } catch (err) {
    logger.error(err, 'Energy reading prune failed');
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Start the background polling loop. */
export function startPolling(): void {
  // Initial poll on startup
  pollAll().catch((err) => logger.error(err, 'Initial poll failed'));

  setInterval(() => {
    pollAll().catch((err) => logger.error(err, 'Poll cycle failed'));
  }, POLL_INTERVAL_MS);

  // Prune old readings once on startup, then daily
  pruneOldReadings();
  setInterval(pruneOldReadings, MS_PER_DAY);

  logger.info({ intervalMs: POLL_INTERVAL_MS }, 'Device polling started');
}
