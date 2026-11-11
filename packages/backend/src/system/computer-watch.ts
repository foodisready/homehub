import fs from 'fs';
import path from 'path';
import { getDb } from '../db';
import { logger } from '../logger';
import { sendPushToUsers } from '../push/push.service';

/**
 * Keeps an eye on the computer HomeHub runs on: how hot it is, and, on a
 * Raspberry Pi, whether it's getting enough power. Checked every minute, so the
 * Health page can say how hot it got while nobody was looking, and admins get a
 * notification when it stays too hot or the power runs short.
 *
 * Both are read from Linux's /sys, which a container can see. On a Mac, or a
 * computer that reports neither, it does nothing.
 */

export const THERMAL_ROOT = '/sys/class/thermal';
export const HWMON_ROOT = '/sys/class/hwmon';

/** A Raspberry Pi 4 starts slowing itself down at 80 °C. */
export const HOT_C = 80;
/** Too hot for this long before a notification, so a short burst doesn't send one. */
export const HOT_FOR_MS = 5 * 60_000;
/** At most one notification of each kind in this long. */
export const ALERT_EVERY_MS = 6 * 3_600_000;
/** The Health page shows the hottest reading in this long. */
export const PEAK_WINDOW_MS = 24 * 3_600_000;
const EVERY_MS = 60_000;

/** The hottest sensor the computer reports, in °C, or null if it reports none. */
export function readTemperature(root = THERMAL_ROOT): number | null {
  let hottest = 0;
  try {
    for (const zone of fs.readdirSync(root)) {
      if (!zone.startsWith('thermal_zone')) continue;
      const milli = Number(fs.readFileSync(path.join(root, zone, 'temp'), 'utf8').trim());
      if (Number.isFinite(milli)) hottest = Math.max(hottest, milli / 1000);
    }
  } catch {
    return null;
  }
  return hottest || null;
}

/**
 * True while a Raspberry Pi's power is too low (its lightning-bolt warning),
 * false while it's fine, and null on a computer that doesn't report it.
 */
export function readLowPower(root = HWMON_ROOT): boolean | null {
  try {
    for (const dir of fs.readdirSync(root)) {
      const name = fs.readFileSync(path.join(root, dir, 'name'), 'utf8').trim();
      if (name !== 'rpi_volt') continue;
      return fs.readFileSync(path.join(root, dir, 'in0_lcrit_alarm'), 'utf8').trim() === '1';
    }
  } catch { /* not Linux, or not readable */ }
  return null;
}

export interface Reader { temperature(): number | null; lowPower(): boolean | null }
export type Notify = (title: string, body: string) => void;

const readers: Reader = { temperature: () => readTemperature(), lowPower: () => readLowPower() };

let samples: { at: number; t: number }[] = [];
let hotSince: number | null = null;
let lowPowerAt: number | null = null;
let powerKnown = false;
const lastAlert: { hot: number | null; power: number | null } = { hot: null, power: null };

/** Notifications go to admins: they're the ones who can do something about it. */
const notifyAdmins: Notify = (title, body) => {
  const admins = (getDb().prepare("SELECT id FROM users WHERE role = 'admin'").all() as { id: number }[]).map((u) => u.id);
  sendPushToUsers(admins, title, body, { url: '/health' });
};

/** One check. Exported so tests can drive the clock and the readings. */
export function sample(now = Date.now(), read: Reader = readers, notify: Notify = notifyAdmins): void {
  const t = read.temperature();
  if (t !== null) {
    samples.push({ at: now, t });
    while (samples.length && now - samples[0].at > PEAK_WINDOW_MS) samples.shift();
    hotSince = t >= HOT_C ? (hotSince ?? now) : null;
    if (hotSince !== null && now - hotSince >= HOT_FOR_MS && due('hot', now)) {
      lastAlert.hot = now;
      logger.warn({ temperature: t }, 'HomeHub computer is running hot');
      notify('HomeHub is running hot', `Its computer has been at ${Math.round(t)} °C for ${Math.round((now - hotSince) / 60_000)} minutes, so it's slowing itself down. Make sure air can reach it, and check its fan.`);
    }
  }
  const low = read.lowPower();
  if (low !== null) powerKnown = true;
  if (low) {
    lowPowerAt = now;
    if (due('power', now)) {
      lastAlert.power = now;
      logger.warn('HomeHub computer is not getting enough power');
      notify("HomeHub isn't getting enough power", 'Its computer reported low power, which can make it slow or unreliable. Use a 5.1 V 3 A adapter (the official Raspberry Pi one) and a short cable.');
    }
  }
}

function due(kind: 'hot' | 'power', now: number): boolean {
  const last = lastAlert[kind];
  return last === null || now - last >= ALERT_EVERY_MS;
}

/** The hottest reading in the last day, if any were taken. */
export function recentPeak(now = Date.now()): { t: number; at: number } | null {
  let peak: { t: number; at: number } | null = null;
  for (const s of samples) if (now - s.at <= PEAK_WINDOW_MS && (!peak || s.t > peak.t)) peak = s;
  return peak;
}

/** When the power was last too low, if it was in the last day. */
export function lowPowerSeen(now = Date.now()): number | null {
  return lowPowerAt !== null && now - lowPowerAt <= PEAK_WINDOW_MS ? lowPowerAt : null;
}

/** Whether this computer reports its power at all (a Raspberry Pi does). */
export function powerReported(): boolean { return powerKnown; }

export function resetComputerWatch(): void {
  samples = [];
  hotSince = null;
  lowPowerAt = null;
  powerKnown = false;
  lastAlert.hot = null;
  lastAlert.power = null;
}

export function startComputerWatch(): void {
  if (readTemperature() === null && readLowPower() === null) return;   // nothing to watch here
  const tick = () => { try { sample(); } catch (err) { logger.warn({ err }, 'Computer check failed'); } };
  tick();
  setInterval(tick, EVERY_MS).unref();
}
