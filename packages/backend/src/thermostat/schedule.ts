import SunCalc from 'suncalc';
import { getDb } from '../db';
import { logger } from '../logger';
import { solarLocation } from '../home/home-settings';
import { temperatureUnit } from '../home/weather';
import { automationsPaused } from '../automation/pause';
import { withActivity } from '../activity/activity';
import {
  ThermostatError, changeThermostat, ensureThermostatRow, getThermostat, rangesOf, requireThermostat, thermostatIds,
  type ThermostatView,
} from './thermostat';

/**
 * A thermostat's temperature schedule: a weekly list of changes, each on some days at a
 * time or at sunrise or sunset, setting the heating and cooling targets.
 *
 * - Only targets change; the mode stays as it is, so a schedule never turns heating or
 *   cooling on, or back on after someone turned it off for the summer.
 * - A change made by a person holds until the next scheduled one.
 * - Every target must be inside the thermostat's allowed range.
 * - A change missed while HomeHub was down is made when it's back, if it's still the
 *   latest one due (up to a week back). One that came due while automations were paused
 *   is skipped, like other schedules.
 *
 * Times are the home's local time (process.env.TZ, set from Settings → Home).
 */

export const SUN_EVENTS = ['sunrise', 'sunset'] as const;
export type SunEvent = typeof SUN_EVENTS[number];
export const MAX_SUN_OFFSET = 180;
export const MAX_POINTS = 50;
const LOOKBACK_MS = 7 * 24 * 3600_000;
const TICK_MS = 30_000;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** One change, as the API shows it. Temperatures in °C. */
export interface SchedulePoint {
  id: number;
  /** Weekdays, 0 Sunday … 6 Saturday, in order. */
  days: number[];
  /** "HH:MM", or null when it's at sunrise or sunset. */
  time: string | null;
  sun: { event: SunEvent; offset: number } | null;
  heat: number | null;
  cool: number | null;
  enabled: boolean;
}

interface Row {
  id: number; device_id: number; days: number; at_minute: number | null;
  solar_event: SunEvent | null; solar_offset: number; heat: number | null; cool: number | null; enabled: number;
}

const toPoint = (r: Row): SchedulePoint => ({
  id: r.id,
  days: [0, 1, 2, 3, 4, 5, 6].filter((d) => r.days & (1 << d)),
  time: r.at_minute === null ? null : `${String(Math.floor(r.at_minute / 60)).padStart(2, '0')}:${String(r.at_minute % 60).padStart(2, '0')}`,
  sun: r.solar_event ? { event: r.solar_event, offset: r.solar_offset } : null,
  heat: r.heat,
  cool: r.cool,
  enabled: r.enabled === 1,
});

export function schedulePoints(deviceId: number): SchedulePoint[] {
  const rows = getDb().prepare('SELECT * FROM thermostat_schedule WHERE device_id = ? ORDER BY id').all(deviceId) as Row[];
  return rows.map(toPoint);
}

// ── When ───────────────────────────────────────────────────────────

/** When a change happens on the local day starting at `day` (local midnight); null if not that weekday, or no sun. */
export function occursOn(p: SchedulePoint, day: Date): Date | null {
  if (!p.days.includes(day.getDay())) return null;
  if (p.time) {
    const [h, m] = p.time.split(':').map(Number);
    // A time skipped when clocks go forward comes out an hour later, which is when it's due.
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
  }
  if (!p.sun) return null;
  const { lat, lon } = solarLocation();
  const t = SunCalc.getTimes(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12), lat, lon)[p.sun.event];
  if (!t || Number.isNaN(t.getTime())) return null;   // near the poles
  return new Date(t.getTime() + p.sun.offset * 60_000);
}

const startOfDay = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate());
const nextDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

export interface Due { point: SchedulePoint; at: Date }

/** The latest enabled change due after `since` and at or before `now`, or null. */
export function latestDue(points: SchedulePoint[], since: Date, now: Date): Due | null {
  const from = new Date(Math.max(since.getTime(), now.getTime() - LOOKBACK_MS));
  let best: Due | null = null;
  for (let day = startOfDay(from); day <= now; day = nextDay(day)) {
    for (const point of points) {
      if (!point.enabled) continue;
      const at = occursOn(point, day);
      if (!at || at <= from || at > now) continue;
      // At the same moment, the one added later wins.
      if (!best || at > best.at || (at.getTime() === best.at.getTime() && point.id > best.point.id)) best = { point, at };
    }
  }
  return best;
}

/** The next enabled change after `now`, within eight days, or null. */
export function nextDue(points: SchedulePoint[], now: Date): Due | null {
  let best: Due | null = null;
  let day = startOfDay(now);
  for (let i = 0; i < 9; i++, day = nextDay(day)) {
    for (const point of points) {
      if (!point.enabled) continue;
      const at = occursOn(point, day);
      if (!at || at <= now) continue;
      if (!best || at < best.at || (at.getTime() === best.at.getTime() && point.id > best.point.id)) best = { point, at };
    }
  }
  return best;
}

// ── Saving ─────────────────────────────────────────────────────────

/** "62°F" or "16.5°C", in the home's unit, for messages. */
function deg(c: number): string {
  return temperatureUnit() === 'F' ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c * 2) / 2}°C`;
}

/** "6:30 AM", "sunset" or "30 min before sunrise", for messages. */
function whenWords(time: string | null, sun: SchedulePoint['sun']): string {
  if (time) {
    const [h, m] = time.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  }
  if (!sun) return '';
  return sun.offset ? `${Math.abs(sun.offset)} min ${sun.offset < 0 ? 'before' : 'after'} ${sun.event}` : sun.event;
}

/**
 * Checks a whole schedule and returns it ready to save. Throws a ThermostatError saying,
 * in words, what's wrong with which change.
 */
export function parseSchedule(input: unknown, view: Pick<ThermostatView, 'alias' | 'allowed' | 'heatLimits' | 'coolLimits' | 'deadband'>): Omit<SchedulePoint, 'id'>[] {
  const list = (input as { points?: unknown } | null)?.points;
  if (!Array.isArray(list)) throw new ThermostatError('points must be a list of changes.');
  if (list.length > MAX_POINTS) throw new ThermostatError(`A schedule can have at most ${MAX_POINTS} changes.`);
  const limitsKnown = view.heatLimits !== null || view.coolLimits !== null;
  const seen = new Map<string, number>();

  return list.map((raw, i) => {
    const n = `Change ${i + 1}`;
    const v = (raw ?? {}) as Record<string, unknown>;

    const days = v.days;
    if (!Array.isArray(days) || days.length === 0 || !days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) {
      throw new ThermostatError(`${n}: choose at least one day.`);
    }
    const dayList = [...new Set(days as number[])].sort();

    let time: string | null = null;
    let sun: SchedulePoint['sun'] = null;
    if (v.time !== undefined && v.time !== null) {
      if (typeof v.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time)) throw new ThermostatError(`${n}: the time must be HH:MM.`);
      time = v.time;
    }
    if (v.sun !== undefined && v.sun !== null) {
      const s = v.sun as { event?: unknown; offset?: unknown };
      if (!SUN_EVENTS.includes(s.event as SunEvent)) throw new ThermostatError(`${n}: choose sunrise or sunset.`);
      const offset = s.offset ?? 0;
      if (typeof offset !== 'number' || !Number.isInteger(offset) || Math.abs(offset) > MAX_SUN_OFFSET) {
        throw new ThermostatError(`${n}: minutes before or after must be a whole number up to ${MAX_SUN_OFFSET}.`);
      }
      sun = { event: s.event as SunEvent, offset };
    }
    if ((time === null) === (sun === null)) throw new ThermostatError(`${n}: give a time, or sunrise or sunset.`);
    // From here on, a change is named by its time, as the page shows it.
    const at = whenWords(time, sun);
    const named = `At ${at}`;

    const temp = (key: 'heat' | 'cool'): number | null => {
      const t = v[key];
      if (t === undefined || t === null) return null;
      if (typeof t !== 'number' || !Number.isFinite(t)) throw new ThermostatError(`${named}: the ${key === 'heat' ? 'heating' : 'cooling'} target must be a number.`);
      if (t < view.allowed.low - 0.01) throw new ThermostatError(`${named}: ${deg(t)} is below the lowest allowed for ${view.alias}, ${deg(view.allowed.low)}.`);
      if (t > view.allowed.high + 0.01) throw new ThermostatError(`${named}: ${deg(t)} is above the highest allowed for ${view.alias}, ${deg(view.allowed.high)}.`);
      const limits = key === 'heat' ? view.heatLimits : view.coolLimits;
      if (limitsKnown && !limits) throw new ThermostatError(`${named}: ${view.alias} doesn’t ${key}.`);
      if (limits && (t < limits[0] - 0.01 || t > limits[1] + 0.01)) {
        throw new ThermostatError(`${named}: ${view.alias} can only be set from ${deg(limits[0])} to ${deg(limits[1])}.`);
      }
      return Math.round(t * 100) / 100;
    };
    const heat = temp('heat');
    const cool = temp('cool');
    if (heat === null && cool === null) throw new ThermostatError(`${named}: set a heating or cooling target.`);
    if (heat !== null && cool !== null && cool - heat < view.deadband - 0.01) {
      throw new ThermostatError(`${named}: cooling must be at least ${temperatureUnit() === 'F' ? Math.round(view.deadband * 9 / 5) + '°F' : view.deadband + '°C'} above heating.`);
    }

    const key = time ?? `${sun!.event}${sun!.offset}`;
    for (const d of dayList) {
      const other = seen.get(`${d}|${key}`);
      if (other !== undefined) throw new ThermostatError(`There’s already a change at ${at} on ${DAY_NAMES[d]}s. Edit that one, or choose another time.`);
      seen.set(`${d}|${key}`, i);
    }

    return { days: dayList, time, sun, heat, cool, enabled: v.enabled !== false };
  });
}

/** Replaces a thermostat's schedule. */
export async function saveSchedule(deviceId: number, input: unknown, read: (id: number) => Promise<ThermostatView> = getThermostat): Promise<SchedulePoint[]> {
  requireThermostat(deviceId);
  const view = await read(deviceId);
  const points = parseSchedule(input, view);
  const db = getDb();
  ensureThermostatRow(deviceId);
  db.transaction(() => {
    db.prepare('DELETE FROM thermostat_schedule WHERE device_id = ?').run(deviceId);
    const add = db.prepare(`
      INSERT INTO thermostat_schedule (device_id, days, at_minute, solar_event, solar_offset, heat, cool, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const p of points) {
      const mask = p.days.reduce((m, d) => m | (1 << d), 0);
      const minute = p.time ? Number(p.time.slice(0, 2)) * 60 + Number(p.time.slice(3)) : null;
      add.run(deviceId, mask, minute, p.sun?.event ?? null, p.sun?.offset ?? 0, p.heat, p.cool, p.enabled ? 1 : 0);
    }
    // Saving isn't a change coming due: what's set now stays until the next one.
    db.prepare('UPDATE thermostats SET schedule_checked_at = ? WHERE device_id = ?').run(new Date().toISOString(), deviceId);
  })();
  logger.info({ deviceId, alias: view.alias, count: points.length }, 'Thermostat schedule saved');
  return schedulePoints(deviceId);
}

// ── Running ────────────────────────────────────────────────────────

function checkedAt(id: number): Date | null {
  const r = getDb().prepare('SELECT schedule_checked_at c FROM thermostats WHERE device_id = ?').get(id) as { c: string | null } | undefined;
  const t = r?.c ? new Date(r.c) : null;
  return t && !Number.isNaN(t.getTime()) ? t : null;
}

function setChecked(id: number, now: Date): void {
  ensureThermostatRow(id);
  getDb().prepare('UPDATE thermostats SET schedule_checked_at = ? WHERE device_id = ?').run(now.toISOString(), id);
}

/** Makes the change due on one thermostat, if any. Exported for tests. */
export interface ScheduleDeps {
  read: (id: number) => Promise<ThermostatView>;
  change: (id: number, change: { heat?: number; cool?: number }) => Promise<unknown>;
}
const realDeps: ScheduleDeps = { read: getThermostat, change: (id, c) => changeThermostat(id, c, 'schedule') };

export async function runThermostatSchedule(id: number, now = new Date(), deps: ScheduleDeps = realDeps): Promise<'none' | 'paused' | 'set' | 'offline' | 'failed'> {
  const since = checkedAt(id);
  if (!since) { setChecked(id, now); return 'none'; }   // the first look: nothing was missed
  const points = schedulePoints(id);
  const due = points.length ? latestDue(points, since, now) : null;
  if (!due) { setChecked(id, now); return 'none'; }
  if (automationsPaused()) { setChecked(id, now); return 'paused'; }

  const view = await deps.read(id);
  if (!view.online) return 'offline';   // tried again on the next tick; a later change takes its place
  const change: { heat?: number; cool?: number } = {};
  if (due.point.heat !== null && view.heatLimits) change.heat = due.point.heat;
  if (due.point.cool !== null && view.coolLimits) change.cool = due.point.cool;
  // Already there: nothing to send.
  const same = (a: number | undefined, b: number | null) => a === undefined || (b !== null && Math.abs(a - b) < 0.05);
  if (Object.keys(change).length === 0 || (same(change.heat, view.heat) && same(change.cool, view.cool))) { setChecked(id, now); return 'none'; }

  // Within the allowed range now too, which may have narrowed since the schedule was saved.
  const { allowed } = rangesOf(id);
  for (const k of ['heat', 'cool'] as const) {
    const t = change[k];
    if (t !== undefined) change[k] = Math.min(Math.max(t, allowed.low), allowed.high);
  }
  const label = `${due.point.time ?? due.point.sun!.event} schedule`;
  try {
    await withActivity({ source: 'schedule', detail: label }, () => deps.change(id, change));
    setChecked(id, now);
    logger.info({ id, alias: view.alias, ...change, due: due.at.toISOString() }, 'Thermostat schedule changed the temperature');
    return 'set';
  } catch (err) {
    if (err instanceof ThermostatError && err.status === 503) return 'offline';
    setChecked(id, now);
    logger.warn({ id, alias: view.alias, err: String((err as Error)?.message ?? err) }, 'Thermostat schedule change failed');
    return 'failed';
  }
}

let running = false;
async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const id of thermostatIds()) {
      try { await runThermostatSchedule(id); } catch (err) { logger.error({ err, id }, 'Thermostat schedule failed'); }
    }
  } finally { running = false; }
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startThermostatSchedules(): void {
  timer = setInterval(() => { void tick(); }, TICK_MS);
  timer.unref?.();
  void tick();
}
export function stopThermostatSchedules(): void { if (timer) clearInterval(timer); timer = undefined; }
