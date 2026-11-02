import { getDb } from '../db';
import { getDriver } from '../drivers/registry';
import { getAllCachedStates } from '../kasa/device.cache';
import { emitDeviceOverride, emitDeviceState } from '../socket';
import { logger } from '../logger';

export interface PowerDevice {
  id:            number;
  alias:         string;
  ip:            string;
  driver_type:   string;
  driver_config: string | null;
  is_protected?: number;
}

const SWEEP_INTERVAL_MS = 15_000;

const toIso = (sqlite: string | null) => (sqlite ? sqlite.replace(' ', 'T') + 'Z' : null);

const powerOffListeners: ((deviceId: number) => void)[] = [];

/** Runs after HomeHub turns a device off. Motion sensors use this to stop waiting. */
export function onPowerOff(listener: (deviceId: number) => void): void {
  powerOffListeners.push(listener);
}

export function notifyPowerOff(deviceId: number): void {
  powerOffListeners.forEach((listener) => listener(deviceId));
}

async function sendPower(device: PowerDevice, state: boolean): Promise<void> {
  const config = device.driver_config ? JSON.parse(device.driver_config) : undefined;
  await getDriver(device.driver_type ?? 'kasa').setPower(device.ip, state, config);

  const db = getDb();
  if (state) {
    db.prepare("UPDATE devices SET turned_on_at = datetime('now') WHERE id = ?").run(device.id);
  } else {
    db.prepare('UPDATE devices SET turned_on_at = NULL WHERE id = ?').run(device.id);
  }

  const cached = getAllCachedStates().get(device.id);
  if (cached) cached.state = state;
  emitDeviceState(device.id, device.alias, state, cached?.wattage ?? null);
  if (!state) notifyPowerOff(device.id);
}

/** Block schedules for a period. A device kept on also turns off when it ends. */
export function setOverride(deviceId: number, state: boolean, minutes: number): void {
  const offset = `${minutes} minutes`;
  const db = getDb();
  db.prepare(`
    UPDATE devices
       SET override_state = ?,
           override_until = datetime('now', ?),
           timer_off_at   = CASE WHEN ? = 1 THEN datetime('now', ?) ELSE NULL END
     WHERE id = ?
  `).run(state ? 1 : 0, offset, state ? 1 : 0, offset, deviceId);

  const row = db.prepare('SELECT override_until FROM devices WHERE id = ?')
    .get(deviceId) as { override_until: string | null } | undefined;
  emitDeviceOverride(deviceId, state, toIso(row?.override_until ?? null));
}

export function clearOverride(deviceId: number): void {
  getDb().prepare(
    'UPDATE devices SET override_state = NULL, override_until = NULL, timer_off_at = NULL WHERE id = ?'
  ).run(deviceId);
  emitDeviceOverride(deviceId, null, null);
}

/** Switching a device by hand replaces its timer, so it can't fire later. */
export function cancelPowerTimer(deviceId: number): void {
  const row = getDb().prepare('SELECT timer_off_at FROM devices WHERE id = ?')
    .get(deviceId) as { timer_off_at: string | null } | undefined;
  if (row?.timer_off_at) clearOverride(deviceId);
}

/** Switch a device now. `minutes` turns it back off after that long. */
export async function applyPower(device: PowerDevice, state: boolean, minutes?: number): Promise<void> {
  await sendPower(device, state);
  if (state && minutes) {
    setOverride(device.id, true, minutes);
  } else {
    cancelPowerTimer(device.id);
  }
}

/**
 * Chat, voice and MCP must not switch a protected device, so it's left to the
 * dashboard. Anything that looks like a water valve is protected without being
 * marked, because forgetting the setting shouldn't let a model cut the water.
 */
/** Garage doors are always protected: opening one by mistake leaves the house open. */
const ALWAYS_PROTECTED_DRIVERS = new Set(['meross']);

export function isProtectedDevice(
  device: Pick<PowerDevice, 'id' | 'alias' | 'is_protected'> & { driver_type?: string },
): boolean {
  if (device.is_protected === 1 || /\bvalve\b/i.test(device.alias)) return true;
  if (device.driver_type && ALWAYS_PROTECTED_DRIVERS.has(device.driver_type)) return true;

  const sensors = getDb().prepare('SELECT config FROM sensors WHERE config IS NOT NULL')
    .all() as { config: string }[];
  return sensors.some((sensor) => {
    try {
      return JSON.parse(sensor.config)?.shutoffDeviceId === device.id;
    } catch {
      return false;
    }
  });
}

const unreachable = new Set<number>();

async function expireTimer(device: PowerDevice & { timer_off_at: string }): Promise<void> {
  try {
    await sendPower(device, false);
  } catch (err) {
    // The timer stays set, so the next sweep tries again.
    if (!unreachable.has(device.id)) {
      unreachable.add(device.id);
      logger.warn({ err, deviceId: device.id, alias: device.alias }, 'Could not turn off device at end of timer');
    }
    return;
  }

  unreachable.delete(device.id);
  const result = getDb().prepare(`
    UPDATE devices SET override_state = NULL, override_until = NULL, timer_off_at = NULL
     WHERE id = ? AND timer_off_at = ?
  `).run(device.id, device.timer_off_at);
  if (result.changes > 0) emitDeviceOverride(device.id, null, null);
  logger.info({ deviceId: device.id, alias: device.alias }, 'Timer ended, device turned off');
}

let sweeping = false;

/** Turn off devices whose timer has ended, and clear overrides that have lapsed. */
export async function sweepPowerTimers(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const db = getDb();

    const lapsed = db.prepare(
      "SELECT id FROM devices WHERE timer_off_at IS NULL AND override_until <= datetime('now')"
    ).all() as { id: number }[];
    for (const { id } of lapsed) clearOverride(id);

    const due = db.prepare("SELECT * FROM devices WHERE timer_off_at <= datetime('now')")
      .all() as (PowerDevice & { timer_off_at: string })[];
    await Promise.all(due.map(expireTimer));
  } finally {
    sweeping = false;
  }
}

/** Timers live in the database, so the first sweep also catches any that ended during downtime. */
export function startPowerTimers(): void {
  const sweep = () => sweepPowerTimers().catch((err) => logger.error(err, 'Timer sweep failed'));
  sweep();
  setInterval(sweep, SWEEP_INTERVAL_MS);
}
