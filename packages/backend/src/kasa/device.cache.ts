import { getDb } from '../db';
import { getDriver } from '../drivers/registry';
import { emitDeviceState, emitDeviceOnline, emitDeviceEnergy } from '../socket';
import { sendPushToAll } from '../push/push.service';
import { logger } from '../logger';

export interface DeviceState {
  state: boolean;
  wattage: number | null;
  online: boolean;
  lastPolled: Date;
}

const cache = new Map<number, DeviceState>();

const POLL_INTERVAL_MS = (Number(process.env.ENERGY_POLL_INTERVAL_SECONDS) || 30) * 1000;

export function getCachedState(deviceId: number): DeviceState | undefined {
  return cache.get(deviceId);
}

export function getAllCachedStates(): Map<number, DeviceState> {
  return cache;
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
  // Throttle Tuya polling to avoid connection lockouts
  if (driverType === 'tuya') {
    const last = tuyaLastPolled.get(id) ?? 0;
    if (Date.now() - last < TUYA_POLL_INTERVAL_MS) return;
    tuyaLastPolled.set(id, Date.now());
  }

  const prev   = cache.get(id);
  const driver = getDriver(driverType);
  try {
    const state  = await driver.getPower(ip, driverConfig);
    const energy = hasEmeter ? await driver.getEnergy(ip, driverConfig) : null;
    cache.set(id, { state, wattage: energy?.wattage ?? null, online: true, lastPolled: new Date() });

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
    if (!prev || prev.online) {
      emitDeviceOnline(id, alias, false);
      sendPushToAll('Device offline', `${alias} is no longer reachable`, { deviceId: id });
    }
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
