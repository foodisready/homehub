import crypto from 'node:crypto';
import os from 'node:os';
import { getDb } from '../db';
import { applyPower, isProtectedDevice, type PowerDevice } from '../devices/power';
import { getCachedState } from '../kasa/device.cache';
import { logger } from '../logger';

const SWEEP_INTERVAL_MS = 15_000;
// A lost "clear" event must not keep a room occupied forever.
const OCCUPIED_LIMIT_MS = 2 * 60 * 60 * 1000;
const SHELLY_TIMEOUT_MS = 15_000;

export interface MotionRuleRow {
  id:                number;
  name:              string;
  token:             string;
  device_id:         number;
  off_after_minutes: number;
  occupied:          number;
  last_motion_at:    string | null;
  turn_on_with_motion: number;
  sensor_ip:         string | null;
  sensor_username:   string | null;
  sensor_password:   string | null;
}

type RuleWithDevice = MotionRuleRow & PowerDevice & {
  rule_id:         number;
  turned_on_at:    string | null;
  override_until:  string | null;
  timer_off_at:    string | null;
};

/** SQLite's datetime('now') is UTC with no zone marker. */
const toMs = (time: string | null) =>
  time ? Date.parse(time.includes('T') ? time : `${time.replace(' ', 'T')}Z`) : 0;

export function createMotionRule(
  name: string,
  deviceId: number,
  offAfterMinutes: number,
  turnOnWithMotion = false,
): MotionRuleRow {
  const token = crypto.randomBytes(16).toString('hex');
  const db = getDb();
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO motion_rules (name, token, device_id, off_after_minutes, turn_on_with_motion) VALUES (?, ?, ?, ?, ?)',
  ).run(name, token, deviceId, offAfterMinutes, turnOnWithMotion ? 1 : 0);
  return db.prepare('SELECT * FROM motion_rules WHERE id = ?').get(lastInsertRowid) as MotionRuleRow;
}

/** Both events mean someone was there just now. Returns false for an unknown token. */
export function recordMotion(token: string, occupied: boolean, now = new Date()): boolean {
  const result = getDb().prepare(
    'UPDATE motion_rules SET occupied = ?, last_motion_at = ? WHERE token = ?',
  ).run(occupied ? 1 : 0, now.toISOString(), token);
  return result.changes > 0;
}

/** Records a sensor event and, if the rule asks for it, turns the light on. */
export async function handleMotion(token: string, occupied: boolean, now = new Date()): Promise<boolean> {
  if (!recordMotion(token, occupied, now)) return false;
  if (!occupied) return true;

  const rule = getDb().prepare(`
    SELECT d.*, r.device_id, r.turn_on_with_motion, r.name
    FROM motion_rules r JOIN devices d ON d.id = r.device_id WHERE r.token = ?
  `).get(token) as RuleWithDevice;
  if (!rule.turn_on_with_motion || isProtectedDevice(rule)) return true;

  const cached = getCachedState(rule.device_id);
  if (!cached?.online || cached.state) return true;
  // Someone chose to hold this light in its current state.
  if (toMs(rule.override_until) > now.getTime()) return true;

  try {
    await applyPower({ ...rule, id: rule.device_id }, true);
    logger.info({ rule: rule.name, device: rule.alias }, 'Motion, light turned on');
  } catch (err) {
    logger.warn({ err, rule: rule.name }, 'Could not turn on light after motion');
  }
  return true;
}

function shouldTurnOff(rule: RuleWithDevice, now: number): boolean {
  // Until the sensor reports, no motion says nothing about the room.
  if (!rule.last_motion_at) return false;
  if (isProtectedDevice({ id: rule.device_id, alias: rule.alias, is_protected: rule.is_protected })) return false;

  const cached = getCachedState(rule.device_id);
  if (!cached?.online || !cached.state) return false;

  // A keep-on timer is a deliberate choice, so it wins.
  if (rule.timer_off_at || toMs(rule.override_until) > now) return false;

  const lastMotion = toMs(rule.last_motion_at);
  if (rule.occupied && now - lastMotion < OCCUPIED_LIMIT_MS) return false;

  // Lights switched on in an empty room still get the full time.
  const start = Math.max(lastMotion, toMs(rule.turned_on_at));
  return now - start >= rule.off_after_minutes * 60_000;
}

let sweeping = false;

export async function sweepMotionRules(now = Date.now()): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const rules = getDb().prepare(`
      SELECT d.*, r.id AS rule_id, r.device_id, r.off_after_minutes, r.occupied, r.last_motion_at, r.name
      FROM motion_rules r JOIN devices d ON d.id = r.device_id
    `).all() as RuleWithDevice[];

    await Promise.all(rules.filter((rule) => shouldTurnOff(rule, now)).map(async (rule) => {
      try {
        await applyPower({ ...rule, id: rule.device_id }, false);
        logger.info({ rule: rule.name, device: rule.alias }, 'No motion, light turned off');
      } catch (err) {
        logger.warn({ err, rule: rule.name }, 'Could not turn off light after no motion');
      }
    }));
  } finally {
    sweeping = false;
  }
}

export function startMotionRules(): void {
  setInterval(() => {
    sweepMotionRules().catch((err) => logger.error(err, 'Motion sweep failed'));
  }, SWEEP_INTERVAL_MS);
}

/** This machine's address on the sensor's network, which the sensor must be able to reach. */
function hubAddressFor(sensorIp: string): string | null {
  const network = sensorIp.split('.').slice(0, 3).join('.');
  for (const entries of Object.values(os.networkInterfaces())) {
    const match = entries?.find((e) => e.family === 'IPv4' && e.address.startsWith(`${network}.`));
    if (match) return match.address;
  }
  return null;
}

export class SensorLoginError extends Error {}

/** The sensor answered, but not as expected. The message is safe to show. */
export class SensorResponseError extends Error {}

const redact = (text: string, token: string) =>
  text.replaceAll(token, '[hidden]').replace(/\s+/g, ' ').slice(0, 300);

/** Tells a Gen 1 Shelly Motion to report to HomeHub. */
export async function connectSensor(
  rule: MotionRuleRow,
  sensorIp: string,
  username: string,
  password: string,
): Promise<void> {
  const hub = hubAddressFor(sensorIp);
  if (!hub) throw new SensorResponseError(`HomeHub isn't on the same network as ${sensorIp}.`);

  const base = `http://${hub}:${process.env.PORT || 3000}/motion/${rule.token}`;
  const headers: Record<string, string> = username
    ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }
    : {};

  const request = async (path: string): Promise<string> => {
    const response = await fetch(`http://${sensorIp}${path}`, {
      headers,
      signal: AbortSignal.timeout(SHELLY_TIMEOUT_MS),
    });
    if (response.status === 401) throw new SensorLoginError('The sensor rejected that username or password.');
    const body = await response.text();
    if (!response.ok) {
      throw new SensorResponseError(`The sensor answered ${response.status}: ${redact(body, rule.token)}`);
    }
    return body;
  };

  // Its JSON may escape slashes, so compare without them.
  const readSaved = async () => (await request('/settings/actions')).replace(/\\\//g, '/');

  // Firmware differs in the format it accepts and answers 200 even when it
  // ignores a request, so only reading the settings back proves a save.
  const actions = [['motion_on', `${base}/on`], ['motion_off', `${base}/off`]];
  for (const [name, url] of actions) {
    let saved = '';
    for (const urls of [`urls[0][url]=${url}&urls[0][int]=0000-2359`, `urls[]=${url}`]) {
      await request(`/settings/actions?index=0&name=${name}&enabled=true&${urls}`);
      saved = await readSaved();
      if (saved.includes(url)) break;
    }
    if (!saved.includes(url)) {
      throw new SensorResponseError(`The sensor did not save ${name}: ${redact(saved, rule.token)}`);
    }
  }
}
