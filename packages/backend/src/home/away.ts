import SunCalc from 'suncalc';
import { getDb } from '../db';
import { logger } from '../logger';
import { getHomeSettings, solarLocation } from './home-settings';
import { temperatureUnit } from './weather';
import { automationsPaused } from '../automation/pause';
import { withActivity } from '../activity/activity';
import { applyPower, isProtectedDevice, type PowerDevice } from '../devices/power';
import { getCachedState } from '../kasa/device.cache';
import { sendPushToAll } from '../push/push.service';
import {
  ThermostatError, changeThermostat, getThermostat, lastKnown, rangesOf, resumeOwnSchedule, thermostatIds, type ThermostatView,
} from '../thermostat/thermostat';
import { latestDue, schedulePoints } from '../thermostat/schedule';
import { AWAY_SETTINGS_KEY, AWAY_STATE_KEY, awayActive } from './away-state';

/**
 * Away mode: one switch for when everyone's out for a while.
 *
 * While it's on:
 * - thermostats go to their away temperatures (inside "Never beyond"), and their
 *   temperature schedules wait;
 * - any water flow counts as a leak (sensors/flow-store reads away-state);
 * - check-ins and spoken reminders wait (family/ reads away-state);
 * - chosen lamps go on around sunset and off in the late evening, at slightly different
 *   times each day, so the house looks lived in.
 * Starting it also resumes any paused cameras.
 *
 * It ends by hand, or by itself a set time before the day and time you're back, so the
 * house is warm (or cool) when you arrive: thermostats go back to what their schedule
 * says now, or else to what they were set to before. Everyone with notifications on is told.
 */

export class AwayError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export interface AwaySettings {
  /** Per thermostat (device id), its away targets in °C. Missing: the edges of its allowed range. */
  thermostats: Record<string, { heat: number | null; cool: number | null }>;
  water: boolean;
  cameras: boolean;
  family: boolean;
  /** Lamps for lived-in lights. */
  lights: number[];
  /** How long before you're back it ends, to warm or cool the house. */
  warmUpMinutes: number;
}

export const DEFAULT_SETTINGS: AwaySettings = { thermostats: {}, water: true, cameras: true, family: true, lights: [], warmUpMinutes: 60 };
export const MAX_AWAY_DAYS = 90;
export const MAX_WARM_UP = 240;
const TICK_MS = 30_000;
const RESTORE_GIVE_UP_MS = 24 * 3600_000;

interface Targets {
  heat: number | null;
  cool: number | null;
  /** It was following its own schedule (a Honeywell thermostat), so ending Away mode lets it again. */
  ownSchedule?: boolean;
}

interface AwayState {
  since: string;
  /** When you're back, or null for until it's turned off. */
  until: string | null;
  by: string | null;
  /** Each thermostat's targets before Away changed them. */
  before: Record<string, Targets>;
  /** Thermostats already at their away temperatures. */
  applied: number[];
  /** What lived-in lights last asked of each lamp. */
  lights: Record<string, boolean>;
}

/** Thermostats to put back after Away mode, retried while they're offline, and lamps to turn off. */
interface Restore { at: string; ids: number[]; before: Record<string, Targets>; lamps?: number[] }
const RESTORE_KEY = 'away_restore';

// ── Storage ────────────────────────────────────────────────────────

function read<T>(key: string): T | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.value) as T; } catch { return null; }
}
function write(key: string, value: unknown | null): void {
  const db = getDb();
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

const state = () => read<AwayState>(AWAY_STATE_KEY);

export function getAwaySettings(): AwaySettings {
  const saved = read<Partial<AwaySettings>>(AWAY_SETTINGS_KEY) ?? {};
  return { ...DEFAULT_SETTINGS, ...saved, thermostats: { ...(saved.thermostats ?? {}) }, lights: [...(saved.lights ?? [])] };
}

// ── Devices ────────────────────────────────────────────────────────

interface DeviceRow extends PowerDevice { room: string | null }

function devices(ids?: number[]): DeviceRow[] {
  const rows = getDb().prepare('SELECT id, alias, ip, room, driver_type, driver_config, is_protected FROM devices ORDER BY alias').all() as DeviceRow[];
  return ids ? rows.filter((r) => ids.includes(r.id)) : rows;
}

const kindOf = (d: DeviceRow): string | undefined => {
  try { return d.driver_config ? JSON.parse(d.driver_config)?.kind : undefined; } catch { return undefined; }
};

/** A lamp Away mode may switch: not protected (doors, cameras, valves), not a thermostat. */
export function mayLight(d: DeviceRow): boolean {
  return kindOf(d) !== 'thermostat' && !isProtectedDevice(d);
}

/** The away targets for a thermostat: saved, else the edges of its allowed range. */
export function awayTargets(id: number, settings = getAwaySettings()): Targets {
  const saved = settings.thermostats[String(id)];
  const { allowed } = rangesOf(id);
  return {
    heat: saved?.heat ?? allowed.low,
    cool: saved?.cool ?? allowed.high,
  };
}

function deg(c: number): string {
  return temperatureUnit() === 'F' ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c * 2) / 2}°C`;
}

// ── Settings ───────────────────────────────────────────────────────

export function saveAwaySettings(input: unknown): AwaySettings {
  const v = (input ?? {}) as Record<string, unknown>;
  const out = getAwaySettings();
  for (const key of ['water', 'cameras', 'family'] as const) {
    if (v[key] === undefined) continue;
    if (typeof v[key] !== 'boolean') throw new AwayError(`${key} must be true or false.`);
    out[key] = v[key] as boolean;
  }
  if (v.warmUpMinutes !== undefined) {
    const m = v.warmUpMinutes;
    if (typeof m !== 'number' || !Number.isInteger(m) || m < 0 || m > MAX_WARM_UP) throw new AwayError(`The warm-up time must be 0 to ${MAX_WARM_UP} minutes.`);
    out.warmUpMinutes = m;
  }
  if (v.lights !== undefined) {
    if (!Array.isArray(v.lights) || !v.lights.every((x) => Number.isInteger(x))) throw new AwayError('lights must be a list of device ids.');
    const ids = [...new Set(v.lights as number[])];
    const found = devices(ids);
    for (const id of ids) {
      const d = found.find((x) => x.id === id);
      if (!d) throw new AwayError(`There’s no device ${id}.`);
      if (!mayLight(d)) throw new AwayError(`${d.alias} can’t be used for lived-in lights: it’s protected or a thermostat.`);
    }
    out.lights = ids;
  }
  if (v.thermostats !== undefined) {
    if (typeof v.thermostats !== 'object' || v.thermostats === null || Array.isArray(v.thermostats)) throw new AwayError('thermostats must be an object.');
    const ids = new Set(thermostatIds());
    const next: AwaySettings['thermostats'] = {};
    for (const [key, raw] of Object.entries(v.thermostats as Record<string, unknown>)) {
      const id = Number(key);
      if (!ids.has(id)) throw new AwayError(`There’s no thermostat ${key}.`);
      const t = (raw ?? {}) as Record<string, unknown>;
      const { allowed } = rangesOf(id);
      const one = (k: 'heat' | 'cool'): number | null => {
        const x = t[k];
        if (x === undefined || x === null) return null;
        if (typeof x !== 'number' || !Number.isFinite(x)) throw new AwayError(`The away ${k === 'heat' ? 'heating' : 'cooling'} temperature must be a number.`);
        if (x < allowed.low - 0.01 || x > allowed.high + 0.01) {
          throw new AwayError(`Away temperatures must be inside the allowed ${deg(allowed.low)}–${deg(allowed.high)}.`);
        }
        return Math.round(x * 100) / 100;
      };
      const heat = one('heat'), cool = one('cool');
      if (heat !== null && cool !== null && cool - heat < 1.5) throw new AwayError('The away cooling temperature must be well above the heating one.');
      next[key] = { heat, cool };
    }
    out.thermostats = next;
  }
  write(AWAY_SETTINGS_KEY, out);
  return out;
}

// ── Lived-in lights ────────────────────────────────────────────────

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * One lamp's evening: on 0–45 minutes after sunset, off between 10:00 and 11:30 PM.
 * The same lamp and day always give the same times, so a restart doesn't reshuffle them.
 */
export function lightPlan(id: number, day: Date): { on: Date; off: Date } | null {
  const y = day.getFullYear(), m = day.getMonth(), d = day.getDate();
  const h = hash(`${y}-${m}-${d}|${id}`);
  const { lat, lon } = solarLocation();
  const sunset = SunCalc.getTimes(new Date(y, m, d, 12), lat, lon).sunset;
  const base = sunset && !Number.isNaN(sunset.getTime()) ? sunset : new Date(y, m, d, 18);
  const on = new Date(base.getTime() + (h % 46) * 60_000);
  const off = new Date(y, m, d, 22, (h >>> 8) % 91);
  return on < off ? { on, off } : null;
}

async function runLights(s: AwayState, settings: AwaySettings, now: Date): Promise<boolean> {
  let changed = false;
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (const d of devices(settings.lights)) {
    if (!mayLight(d)) continue;
    const plan = lightPlan(d.id, day);
    const want = !!plan && now >= plan.on && now < plan.off;
    if (want === (s.lights[String(d.id)] ?? false)) continue;
    try {
      await withActivity({ source: 'away', detail: 'lived-in lights' }, () => applyPower(d, want));
      s.lights[String(d.id)] = want;
      changed = true;
      logger.info({ id: d.id, alias: d.alias, on: want }, 'Away mode: lived-in lights');
    } catch (err) {
      logger.warn({ id: d.id, err: String((err as Error)?.message ?? err) }, 'Away mode: a lamp didn’t switch');
    }
  }
  return changed;
}

// ── Thermostats ────────────────────────────────────────────────────

export interface AwayDeps {
  read: (id: number) => Promise<ThermostatView>;
  change: (id: number, change: { heat?: number; cool?: number }) => Promise<unknown>;
  /** Lets a thermostat follow its own schedule again; false if it has none. */
  resume?: (id: number) => Promise<boolean>;
}
const realDeps: AwayDeps = { read: getThermostat, change: (id, c) => changeThermostat(id, c, 'away'), resume: resumeOwnSchedule };
let deps: AwayDeps = realDeps;
/** For tests. */
export function setAwayDeps(d: AwayDeps | null): void { deps = d ?? realDeps; }

/**
 * Sends the targets a thermostat has, fitted to its own limits and to the gap it keeps
 * between heating and cooling. True once done or not possible, false while it's offline.
 */
async function setTargets(id: number, t: Targets, view: ThermostatView): Promise<boolean> {
  const fit = (x: number, limits: [number, number]) => Math.min(Math.max(x, limits[0]), limits[1]);
  const change: { heat?: number; cool?: number } = {};
  if (t.heat !== null && view.heatLimits) change.heat = fit(t.heat, view.heatLimits);
  if (t.cool !== null && view.coolLimits) change.cool = fit(t.cool, view.coolLimits);
  if (change.heat !== undefined && change.cool !== undefined && change.cool - change.heat < view.deadband) {
    change.cool = Math.round((change.heat + view.deadband) * 100) / 100;
  }
  if (!Object.keys(change).length) return true;
  try {
    await deps.change(id, change);
    return true;
  } catch (err) {
    if (err instanceof ThermostatError && err.status === 503) return false;
    logger.warn({ id, err: String((err as Error)?.message ?? err) }, 'Away mode: thermostat change refused');
    return true;
  }
}

async function applyThermostats(s: AwayState, settings: AwaySettings): Promise<boolean> {
  let changed = false;
  for (const id of thermostatIds()) {
    if (s.applied.includes(id)) continue;
    const view = await deps.read(id);
    if (!view.online) continue;
    s.before[String(id)] ??= { heat: view.heat, cool: view.cool, ...(view.hold === 'schedule' ? { ownSchedule: true } : {}) };
    if (await setTargets(id, awayTargets(id, settings), view)) {
      s.applied.push(id);
      changed = true;
      logger.info({ id, alias: view.alias, ...awayTargets(id, settings) }, 'Away mode: thermostat set');
    }
  }
  return changed;
}

/**
 * What a thermostat goes back to: what its schedule says now, else what it was before.
 * A target the schedule leaves alone (heating only, say) goes back to what it was.
 */
export function backTo(id: number, before: Targets | undefined, now: Date): Targets | null {
  const due = latestDue(schedulePoints(id), new Date(0), now);
  if (due) return { heat: due.point.heat ?? before?.heat ?? null, cool: due.point.cool ?? before?.cool ?? null };
  return before ?? null;
}

/** Back to following its own schedule: true once done, false while it's offline, null if it has none. */
async function resumeOwn(id: number): Promise<boolean | null> {
  if (!deps.resume) return null;
  try {
    return (await deps.resume(id)) ? true : null;
  } catch (err) {
    if (err instanceof ThermostatError && err.status === 503) return false;
    logger.warn({ id, err: String((err as Error)?.message ?? err) }, 'Away mode: thermostat couldn’t go back to its own schedule');
    return null;
  }
}

async function runRestore(now: Date): Promise<void> {
  const r = read<Restore>(RESTORE_KEY);
  if (!r) return;
  // Lamps lived-in lights left on go off, once.
  for (const d of devices(r.lamps ?? [])) {
    try { await withActivity({ source: 'away', detail: 'Away mode ended' }, () => applyPower(d, false)); } catch { /* left as is */ }
  }
  const left: number[] = [];
  for (const id of r.ids) {
    if (!thermostatIds().includes(id)) continue;
    const before = r.before[String(id)];
    // No HomeHub schedule to go back to, and it was following its own: it follows that again.
    if (before?.ownSchedule && !latestDue(schedulePoints(id), new Date(0), now)) {
      const resumed = await resumeOwn(id);
      if (resumed === false) { left.push(id); continue; }
      if (resumed) { logger.info({ id }, 'Away mode: thermostat back on its own schedule'); continue; }
    }
    const target = backTo(id, before, now);
    if (!target) continue;
    const view = await deps.read(id);
    if (!view.online || !(await setTargets(id, target, view))) { left.push(id); continue; }
    // The schedule takes over from here, without making again what was just set.
    getDb().prepare('UPDATE thermostats SET schedule_checked_at = ? WHERE device_id = ?').run(now.toISOString(), id);
    logger.info({ id, alias: view.alias, ...target }, 'Away mode: thermostat back');
  }
  if (left.length && now.getTime() - Date.parse(r.at) < RESTORE_GIVE_UP_MS) write(RESTORE_KEY, { ...r, ids: left, lamps: [] });
  else write(RESTORE_KEY, null);
}

// ── Start and end ──────────────────────────────────────────────────

/** When it ends by itself: the warm-up time before you're back. */
export function endsAt(s: Pick<AwayState, 'until'>, settings = getAwaySettings()): Date | null {
  return s.until ? new Date(Date.parse(s.until) - settings.warmUpMinutes * 60_000) : null;
}

function parseUntil(until: unknown, now: Date, warmUpMinutes: number): string | null {
  if (until === undefined || until === null || until === '') return null;
  const t = typeof until === 'string' ? Date.parse(until) : NaN;
  if (Number.isNaN(t)) throw new AwayError('“Back on” must be a date and time.');
  if (t <= now.getTime() + 5 * 60_000) throw new AwayError('“Back on” must be later than now.');
  // Otherwise it would end, and say welcome back, as soon as it started.
  if (t - warmUpMinutes * 60_000 <= now.getTime() + 5 * 60_000) {
    throw new AwayError(`Back to normal is set to ${warmUpMinutes} minutes before you’re back, so the day back must be later than that from now.`);
  }
  if (t > now.getTime() + MAX_AWAY_DAYS * 86_400_000) throw new AwayError(`Away mode can be set for up to ${MAX_AWAY_DAYS} days.`);
  return new Date(t).toISOString();
}

/**
 * Starting, ending and the regular check run one at a time, so ending can't slip in
 * while a check is waiting on a thermostat and leave it at its away temperature.
 */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/** Until when check-ins and reminders stay paused after Away mode: the day back. */
export const AWAY_FAMILY_UNTIL_KEY = 'away_family_until';

export function startAway(input: { until?: unknown }, by: string | null, now = new Date()): Promise<AwayView> {
  return serial(async () => {
    const settings = getAwaySettings();
    const until = parseUntil(input.until, now, settings.warmUpMinutes);
    const existing = state();
    if (existing) {
      // Already away: only the day back changes.
      write(AWAY_STATE_KEY, { ...existing, until });
      logger.info({ until }, 'Away mode: day back changed');
      return awayView();
    }
    // A return still waiting (a thermostat that was offline, lamps left while paused) carries
    // over, so this time's end puts them back to what they were before the last time.
    const pending = read<Restore>(RESTORE_KEY);
    const s: AwayState = { since: now.toISOString(), until, by, before: {}, applied: [], lights: {} };
    for (const id of pending?.ids ?? []) if (pending!.before[String(id)]) s.before[String(id)] = pending!.before[String(id)];
    for (const id of pending?.lamps ?? []) s.lights[String(id)] = true;
    write(RESTORE_KEY, null);
    write(AWAY_FAMILY_UNTIL_KEY, null);
    write(AWAY_STATE_KEY, s);
    logger.info({ until, by }, 'Away mode on');

    // Paused automations (a development copy, say) leave every device alone.
    if (settings.cameras && !automationsPaused()) {
      for (const d of devices().filter((x) => x.driver_type === 'wyze' && getCachedState(x.id)?.state === false)) {
        try {
          await withActivity({ source: 'away', detail: 'resumed for Away mode' }, () => applyPower(d, true));
          logger.info({ id: d.id, alias: d.alias }, 'Away mode: camera resumed');
        } catch (err) {
          logger.warn({ id: d.id, err: String((err as Error)?.message ?? err) }, 'Away mode: a camera didn’t resume');
        }
      }
    }
    await check(now);
    return awayView();
  });
}

export function endAway(why: 'person' | 'time', now = new Date()): Promise<AwayView> {
  return serial(() => end(why, now));
}

async function end(why: 'person' | 'time', now: Date): Promise<AwayView> {
  const s = state();
  if (!s) return awayView();
  write(AWAY_STATE_KEY, null);
  const lamps = Object.keys(s.lights).filter((k) => s.lights[k]).map(Number);
  write(RESTORE_KEY, { at: now.toISOString(), ids: s.applied, before: s.before, lamps });
  // Ending early to warm the house up: nobody's home yet, so check-ins wait for the day back.
  if (s.until && Date.parse(s.until) > now.getTime()) write(AWAY_FAMILY_UNTIL_KEY, s.until);
  logger.info({ why }, 'Away mode off');

  // Paused automations leave devices alone; it's all put back once they resume.
  const paused = automationsPaused();
  if (!paused) await runRestore(now);

  if (why === 'time' && !paused) {
    const back = s.applied.map((id) => {
      const t = backTo(id, s.before[String(id)], now);
      const name = getDb().prepare('SELECT alias FROM devices WHERE id = ?').get(id) as { alias: string } | undefined;
      return t && name ? `${name.alias} to ${[t.heat !== null ? deg(t.heat) : null, t.cool !== null ? `cooling ${deg(t.cool)}` : null].filter(Boolean).join(', ')}` : null;
    }).filter(Boolean);
    sendPushToAll('Away mode ended', back.length ? `Welcome back. ${back.join('; ')}.` : 'Welcome back. Everything is back to normal.', { url: '/dashboard' });
  }
  return awayView();
}

// ── Running ────────────────────────────────────────────────────────

/** Ends Away mode when it's time, sets thermostats that were offline, and runs the lamps. Exported for tests. */
export function tick(now = new Date()): Promise<void> {
  return serial(() => check(now));
}

async function check(now: Date): Promise<void> {
  try {
    const s = state();
    const settings = getAwaySettings();
    if (s) {
      const endAt = endsAt(s, settings);
      if (endAt && now >= endAt) { await end('time', now); return; }
      if (automationsPaused()) return;
      const a = await applyThermostats(s, settings);
      const b = await runLights(s, settings, now);
      if (a || b) write(AWAY_STATE_KEY, s);
    } else if (!automationsPaused()) {
      await runRestore(now);
    }
  } catch (err) {
    logger.error({ err }, 'Away mode failed');
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startAwayMode(): void {
  timer = setInterval(() => { void tick(); }, TICK_MS);
  timer.unref?.();
}
export function stopAwayMode(): void { if (timer) clearInterval(timer); timer = undefined; }

// ── The view ───────────────────────────────────────────────────────

export interface AwayView {
  active: boolean;
  since: string | null;
  until: string | null;
  /** When it ends by itself, the warm-up time before `until`. */
  endsAt: string | null;
  by: string | null;
  settings: AwaySettings;
  unit: 'F' | 'C';
  /** The home's time zone, for showing the day back. */
  timezone: string;
  /** heats and cools: what it can do, as last reported; both when not heard from yet. */
  thermostats: { id: number; alias: string; away: Targets; allowed: { low: number; high: number }; set: boolean; heats: boolean; cools: boolean }[];
  /** What this home has, so the page only offers what applies. */
  has: { water: boolean; cameras: boolean; family: boolean };
  /** Devices that may be lived-in lights. */
  lamps: { id: number; alias: string; room: string | null }[];
}

function capabilities(id: number): { heats: boolean; cools: boolean } {
  const v = lastKnown(id);
  if (!v || (v.heatLimits === null && v.coolLimits === null)) return { heats: true, cools: true };
  return { heats: v.heatLimits !== null, cools: v.coolLimits !== null };
}

const count = (sql: string): number => {
  try { return (getDb().prepare(sql).get() as { n: number }).n; } catch { return 0; }
};

export function awayView(): AwayView {
  const s = state();
  const settings = getAwaySettings();
  const names = new Map(devices().map((d) => [d.id, d]));
  return {
    active: !!s,
    since: s?.since ?? null,
    until: s?.until ?? null,
    endsAt: s ? endsAt(s, settings)?.toISOString() ?? null : null,
    by: s?.by ?? null,
    settings,
    unit: temperatureUnit(),
    timezone: getHomeSettings().timezone,
    thermostats: thermostatIds().map((id) => ({
      id, alias: names.get(id)?.alias ?? `Thermostat ${id}`,
      away: awayTargets(id, settings), allowed: rangesOf(id).allowed, set: !!s?.applied.includes(id),
      ...capabilities(id),
    })),
    has: {
      water: count("SELECT COUNT(*) n FROM sensors WHERE type = 'flow'") > 0,
      cameras: count("SELECT COUNT(*) n FROM devices WHERE driver_type = 'wyze'") > 0,
      family: count('SELECT (SELECT COUNT(*) FROM checkins) + (SELECT COUNT(*) FROM reminders) n') > 0,
    },
    lamps: devices().filter(mayLight).map((d) => ({ id: d.id, alias: d.alias, room: d.room })),
  };
}
