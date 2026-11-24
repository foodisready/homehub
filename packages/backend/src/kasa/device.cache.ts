import { getDb } from '../db';
import { getDriver } from '../drivers/registry';
import { emitDeviceState, emitDeviceOnline, emitDeviceEnergy, emitDeviceNoPower } from '../socket';
import { cancelPowerTimer } from '../devices/power';
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
  /** On, but drawing no power for a while: see noPowerNow. */
  noPower?: boolean;
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
export function noteState(deviceId: number, state: boolean, now = Date.now()): void {
  const prev = cache.get(deviceId);
  settleAfterSwitch(deviceId, now);
  // A fresh switch starts the "no power" check again: a light just turned on reads 0 W for a moment.
  lowSince.delete(deviceId);
  if (prev?.noPower) emitDeviceNoPower(deviceId, false);
  cache.set(deviceId, { state, wattage: state ? prev?.wattage ?? null : null, online: true, lastPolled: new Date() });
  recordPower(deviceId, state);   // with the cause of the work that made the switch
}

// ── Settling after a switch ────────────────────────────────────
// Some devices take a while to show a switch: a garage door reads closed until it has moved off its
// sensor, and open until it's fully down. A regular check landing in that time would undo the switch
// on screen and log a change nobody made. So for a driver's `confirmAfterMs` after a switch, checks
// leave the device alone; the read-back after the switch, or the next check, has the real state.

const settling = new Map<number, number>();

function settleAfterSwitch(deviceId: number, now: number): void {
  const row = getDb().prepare('SELECT driver_type FROM devices WHERE id = ?').get(deviceId) as { driver_type: string | null } | undefined;
  let ms: number | undefined;
  try { ms = row ? getDriver(row.driver_type ?? 'kasa').confirmAfterMs : undefined; } catch { ms = undefined; }
  if (ms) settling.set(deviceId, now + ms); else settling.delete(deviceId);
}

/** Still settling after a switch: a check now could read the old state. */
export function isSettling(deviceId: number, now = Date.now()): boolean {
  const until = settling.get(deviceId);
  if (until === undefined) return false;
  if (now < until) return true;
  settling.delete(deviceId);
  return false;
}

// ── On, but no power ───────────────────────────────────────────
// A light whose switch measures power, on, drawing nothing: something past the
// switch has cut it, like the other switch of a 3-way pair wired in the light's
// circuit, or a dead bulb. Only lights that normally draw power, and only after
// a while, since a light just switched on reads 0 W for a moment.

const LIGHT_WORDS = /\b(?:lamps?|lights?|lighting|bulbs?|sconces?|chandeliers?|pendants?|downlights?)\b/i;
const NO_POWER_BELOW_W = 1;
const NORMAL_DRAW_MIN_W = 3;
export const NO_POWER_AFTER_MS = 45_000;
const lowSince = new Map<number, number>();
const usualDraw = new Map<number, { watts: number | null; at: number }>();

/** A light, by what HomeHub knows: a wall-switch relay, or a name that says so. */
export function isLightLike(alias: string, driverType: string, nicknames: string[] = []): boolean {
  return driverType === 'shelly' || [alias, ...nicknames].some((n) => LIGHT_WORDS.test(n));
}

/** The median draw while on over the last 30 days, re-read hourly. */
function normalDraw(id: number, now: number): number | null {
  const hit = usualDraw.get(id);
  if (hit && now - hit.at < 3_600_000) return hit.watts;
  const rows = getDb().prepare(`SELECT wattage FROM energy_readings
    WHERE device_id = ? AND wattage > 1 AND recorded_at >= datetime('now', '-30 days') ORDER BY wattage`).all(id) as { wattage: number }[];
  const watts = rows.length >= 3 ? rows[Math.floor(rows.length / 2)].wattage : null;
  usualDraw.set(id, { watts, at: now });
  return watts;
}

/**
 * Whether a device is on but drawing no power, from this reading. Pure but for
 * the remembered start of the low readings, so the poll can call it each time.
 */
export function noPowerNow(
  d: { id: number; alias: string; driverType: string; nicknames?: string[] },
  state: boolean, wattage: number | null, now: number, draw: (id: number, now: number) => number | null = normalDraw,
): boolean {
  if (!state || wattage === null || wattage >= NO_POWER_BELOW_W || !isLightLike(d.alias, d.driverType, d.nicknames)) {
    lowSince.delete(d.id);
    return false;
  }
  const usual = draw(d.id, now);
  if (usual === null || usual < NORMAL_DRAW_MIN_W) { lowSince.delete(d.id); return false; }
  const since = lowSince.get(d.id) ?? now;
  lowSince.set(d.id, since);
  return now - since >= NO_POWER_AFTER_MS;
}

/** For tests. */
export function resetNoPower(): void { lowSince.clear(); usualDraw.clear(); }

/** Poll a single device, update the cache, and emit socket events. */
// Tuya devices use a stateful TCP connection that gets confused by frequent polling.
// Poll them at most once every 5 minutes — state is updated via confirmStateAsync after toggles.
const TUYA_POLL_INTERVAL_MS = 5 * 60 * 1000;
const tuyaLastPolled = new Map<number, number>();

/** Reads in progress, so two callers asking about one device share a single read. */
const reading = new Map<number, Promise<void>>();

function pollDevice(
  id: number, ip: string, alias: string, hasEmeter: boolean, driverType: string, driverConfig: Record<string, unknown> | undefined,
): Promise<void> {
  const busy = reading.get(id);
  if (busy) return busy;
  const read = readDevice(id, ip, alias, hasEmeter, driverType, driverConfig).finally(() => reading.delete(id));
  reading.set(id, read);
  return read;
}

async function readDevice(
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
  // A robot vacuum takes one connection too: a backup connecting would take it from the active HomeHub.
  if (driverType === 'roomba' && !isActiveServer()) return;
  if (driverType === 'tuya') {
    const last = tuyaLastPolled.get(id) ?? 0;
    if (Date.now() - last < TUYA_POLL_INTERVAL_MS) return;
    tuyaLastPolled.set(id, Date.now());
  }

  if (isSettling(id)) return;
  const prev   = cache.get(id);
  const driver = getDriver(driverType);
  const started = Date.now();
  try {
    const state  = await driver.getPower(ip, driverConfig);
    const energy = hasEmeter ? await driver.getEnergy(ip, driverConfig) : null;
    // A switch landed while this read was in flight: its state is newer, so keep it.
    if ((cache.get(id)?.lastPolled.getTime() ?? 0) > started) return;
    const noPower = hasEmeter ? noPowerNow({ id, alias, driverType }, state, energy?.wattage ?? null, Date.now()) : false;
    cache.set(id, { state, wattage: energy?.wattage ?? null, online: true, lastPolled: new Date(), ...(noPower ? { noPower } : {}) });
    if (noPower !== !!prev?.noPower) {
      emitDeviceNoPower(id, noPower);
      if (noPower) logger.warn({ id, alias }, 'Light is on but drawing no power; a wall switch may be off');
    }

    // HomeHub records its own switches as it makes them, so a change seen here
    // came from outside: a wall switch, the device's app, or while HomeHub was off.
    if (prev?.online ? prev.state !== state : lastPowerState(id) !== null && lastPowerState(id) !== state) {
      recordPower(id, state, { source: 'outside' });
      // Turned off by hand: a timer to turn it off has nothing left to do, and
      // mustn't keep motion from turning it back on.
      if (!state) cancelPowerTimer(id);
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

type Row = { id: number; ip: string; alias: string; has_emeter: number; driver_type: string; driver_config: string | null };
const pollRow = (d: Row) => pollDevice(d.id, d.ip, d.alias, d.has_emeter === 1, d.driver_type ?? 'kasa', d.driver_config ? JSON.parse(d.driver_config) : undefined);

/** A device read this recently is fresh enough for "check now". */
export const FRESH_MS = 3_000;
/** "Check now" answers by then even if a device is slow; its state still arrives over the socket. */
export const CHECK_WAIT_MS = 4_000;

/**
 * Reads these devices now (all, if none are named) instead of waiting up to a poll interval, for a
 * screen that just opened: a garage door opened with its remote shows open straight away. Devices
 * read in the last few seconds are skipped, and Tuya keeps its own limit (see pollDevice).
 */
export async function checkNow(ids?: number[], now = Date.now()): Promise<void> {
  const rows = getDb().prepare('SELECT id, ip, alias, has_emeter, driver_type, driver_config FROM devices').all() as Row[];
  const want = ids?.length ? new Set(ids) : null;
  const stale = rows.filter((d) => (!want || want.has(d.id)) && now - (cache.get(d.id)?.lastPolled.getTime() ?? 0) >= FRESH_MS);
  if (!stale.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(stale.map(pollRow)),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, CHECK_WAIT_MS); }),
  ]);
  clearTimeout(timer);
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
