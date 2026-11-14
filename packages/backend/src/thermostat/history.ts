import { getDb } from '../db';
import { logger } from '../logger';
import { getHomeSettings } from '../home/home-settings';
import type { ThermostatView } from './thermostat';

/**
 * What thermostats did, for the Energy page.
 *
 * - Running hours come from the thermostat's own reports of starting and stopping, kept as
 *   runs with exact times, not from the 5-minute samples. A thermostat that doesn't report
 *   whether it's running has no runs; its temperatures are still kept.
 * - Samples every 5 minutes give the day chart its temperatures, targets and mode.
 * - The outdoor temperature each hour, from Open-Meteo for the home's location, gives each
 *   day's heating and cooling degree-days: how far the day's average was below or above
 *   65 °F (18.3 °C). Hours per degree-day compares a cold month with a mild one fairly.
 *   Past days are fetched too, so a day HomeHub was off still counts.
 *
 * Days and months are the home's local time: the process clock runs in its time zone.
 */

export const SAMPLE_EVERY_MS = 5 * 60_000;
const OUTDOOR_EVERY_MS = 60 * 60_000;
/** Degree-days count from 65 °F, the usual base for homes. */
export const BASE_C = (65 - 32) * 5 / 9;
/** Samples are kept 400 days: a year back, and this month last year. Runs and outdoor hours are small and kept. */
const KEEP_SAMPLES_DAYS = 400;
/** A day counts toward degree-days with at least this many hours of outdoor temperature. */
const MIN_HOURS = 18;

export type RunKind = 'heating' | 'cooling';

const iso = (ms: number) => new Date(ms).toISOString();

// ── Recording ──────────────────────────────────────────────────

/**
 * A thermostat reported: starts or ends a run when heating or cooling starts or stops.
 * Fan only isn't a run. Nothing changes for a thermostat that doesn't say (running null).
 */
export function noteRunning(deviceId: number, running: ThermostatView['running'], now = Date.now()): void {
  if (running === null) return;
  const db = getDb();
  const open = db.prepare('SELECT id, kind FROM thermostat_runs WHERE device_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(deviceId) as { id: number; kind: string } | undefined;
  const kind: RunKind | null = running === 'heating' || running === 'cooling' ? running : null;
  if (open?.kind === kind) return;
  if (open) db.prepare('UPDATE thermostat_runs SET ended_at = ? WHERE id = ?').run(iso(now), open.id);
  if (kind) db.prepare('INSERT INTO thermostat_runs (device_id, kind, started_at) VALUES (?, ?, ?)').run(deviceId, kind, iso(now));
}

/** A 5-minute sample. Offline thermostats aren't sampled, so a gap shows as a gap. */
export function recordSample(view: ThermostatView, now = Date.now()): void {
  if (!view.online) return;
  getDb().prepare(`
    INSERT OR REPLACE INTO thermostat_samples (device_id, at, temperature, heat, cool, mode, running)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(view.id, iso(Math.floor(now / 60_000) * 60_000), view.temperature, view.heat, view.cool, view.mode, view.running);
  noteRunning(view.id, view.running, now);
}

/**
 * After HomeHub was off, a run still open may have ended long ago: end it at the last
 * sample, the last time HomeHub knew it was running. Too short rather than too long.
 */
export function closeStaleRuns(): void {
  const db = getDb();
  const open = db.prepare('SELECT id, device_id, started_at FROM thermostat_runs WHERE ended_at IS NULL').all() as
    { id: number; device_id: number; started_at: string }[];
  for (const r of open) {
    const last = db.prepare('SELECT MAX(at) AS at FROM thermostat_samples WHERE device_id = ? AND at >= ?').get(r.device_id, r.started_at) as { at: string | null };
    db.prepare('UPDATE thermostat_runs SET ended_at = ? WHERE id = ?').run(last.at ?? r.started_at, r.id);
  }
}

export function pruneSamples(now = Date.now()): void {
  getDb().prepare('DELETE FROM thermostat_samples WHERE at < ?').run(iso(now - KEEP_SAMPLES_DAYS * 86_400_000));
}

/** "2026-11-14T15:00", the home's local hour. */
const localHour = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:00`;

/**
 * Fetches outdoor temperatures by the hour, for the home's location, and keeps the ones that
 * have happened. Three days back each hour; three months back the first time, or after a gap.
 */
export async function fetchOutdoor(opts: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<number> {
  const home = getHomeSettings();
  if (home.latitude === null || home.longitude === null) return 0;
  const now = opts.now ?? Date.now();
  const db = getDb();
  const newest = (db.prepare('SELECT MAX(hour) AS h FROM outdoor_hours').get() as { h: string | null }).h;
  const behindDays = newest ? (now - new Date(newest).getTime()) / 86_400_000 : Infinity;
  const pastDays = behindDays > 2.5 ? 92 : 3;
  const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: home.latitude.toFixed(2), longitude: home.longitude.toFixed(2),
    hourly: 'temperature_2m', temperature_unit: 'celsius', timezone: home.timezone,
    past_days: String(pastDays), forecast_days: '1',
  });
  let data: { hourly?: { time?: string[]; temperature_2m?: (number | null)[] } };
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
    data = await res.json() as typeof data;
  } catch (err) {
    logger.warn({ err: String((err as Error)?.message ?? err) }, 'Outdoor temperatures unavailable');
    return 0;
  }
  const times = data.hourly?.time ?? [], temps = data.hourly?.temperature_2m ?? [];
  const nowHour = localHour(new Date(now));
  const put = db.prepare('INSERT OR REPLACE INTO outdoor_hours (hour, temp_c) VALUES (?, ?)');
  let kept = 0;
  db.transaction(() => {
    times.forEach((t, i) => {
      const v = temps[i];
      if (typeof v === 'number' && t <= nowHour) { put.run(t, v); kept++; }
    });
  })();
  return kept;
}

let timers: ReturnType<typeof setInterval>[] = [];

/** Starts sampling every 5 minutes and fetching outdoor temperatures every hour, once there's a thermostat. */
export function startHistory(list: () => Promise<ThermostatView[]>): void {
  closeStaleRuns();
  const sample = async () => {
    try {
      const all = await list();
      for (const v of all) recordSample(v);
      return all.length;
    } catch (err) {
      logger.warn({ err: String((err as Error)?.message ?? err) }, 'Thermostat sample failed');
      return 0;
    }
  };
  const outdoor = async () => { if ((await list()).length) await fetchOutdoor(); };
  void sample().then((n) => { if (n) void outdoor(); });
  timers = [
    setInterval(() => void sample(), SAMPLE_EVERY_MS),
    setInterval(() => void outdoor(), OUTDOOR_EVERY_MS),
    setInterval(() => pruneSamples(), 86_400_000),
  ];
  for (const t of timers) t.unref?.();
}

export function stopHistory(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
}

// ── Reading back ───────────────────────────────────────────────

/** Minutes each kind ran between two times, a run cut to fit; one still running counts up to `now`. */
export function runMinutes(deviceId: number, from: number, to: number, now = Date.now()): Record<RunKind, number> {
  const rows = getDb().prepare(`
    SELECT kind, started_at, ended_at FROM thermostat_runs
    WHERE device_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)
  `).all(deviceId, iso(to), iso(from)) as { kind: RunKind; started_at: string; ended_at: string | null }[];
  const out: Record<RunKind, number> = { heating: 0, cooling: 0 };
  for (const r of rows) {
    const start = Math.max(from, Date.parse(r.started_at));
    const end = Math.min(to, r.ended_at ? Date.parse(r.ended_at) : now);
    if (end > start && (r.kind === 'heating' || r.kind === 'cooling')) out[r.kind] += (end - start) / 60_000;
  }
  return out;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Heating and cooling degree-days between two local dates (from inclusive, to exclusive), from
 * each day's average outdoor temperature. `days` is how many days had enough hours to count.
 */
export function degreeDays(from: Date, to: Date): { hdd: number; cdd: number; days: number } {
  const rows = getDb().prepare(`
    SELECT substr(hour, 1, 10) AS day, AVG(temp_c) AS mean, COUNT(*) AS n FROM outdoor_hours
    WHERE hour >= ? AND hour < ? GROUP BY day
  `).all(`${dayKey(from)}T00:00`, `${dayKey(to)}T00:00`) as { day: string; mean: number; n: number }[];
  let hdd = 0, cdd = 0, days = 0;
  for (const r of rows) {
    if (r.n < MIN_HOURS) continue;
    hdd += Math.max(0, BASE_C - r.mean);
    cdd += Math.max(0, r.mean - BASE_C);
    days++;
  }
  // In °F degree-days, the unit people know (65 °F base): one °C degree-day is 1.8 °F ones.
  return { hdd: Math.round(hdd * 1.8 * 10) / 10, cdd: Math.round(cdd * 1.8 * 10) / 10, days };
}

export interface MonthSummary {
  /** "2026-11" */
  month: string;
  heatHours: number;
  coolHours: number;
  /** °F degree-days, 65 °F base. */
  hdd: number;
  cdd: number;
  /** Days with enough outdoor temperatures to count. */
  weatherDays: number;
  /** Days in the month so far. */
  days: number;
  /** The average inside temperature, °C, or null with no samples. */
  inside: number | null;
  /** HomeHub was recording this thermostat for at least part of the month. */
  recorded: boolean;
  /** The month isn't over yet. */
  partial: boolean;
}

const h1 = (min: number) => Math.round(min / 6) / 10;   // minutes to hours, one decimal

/** The last `count` months, oldest first, this month (so far) last. */
export function months(deviceId: number, count = 12, now = Date.now()): MonthSummary[] {
  const db = getDb();
  const first = (db.prepare('SELECT MIN(at) AS at FROM thermostat_samples WHERE device_id = ?').get(deviceId) as { at: string | null }).at;
  const firstRun = (db.prepare('SELECT MIN(started_at) AS at FROM thermostat_runs WHERE device_id = ?').get(deviceId) as { at: string | null }).at;
  const since = Math.min(first ? Date.parse(first) : Infinity, firstRun ? Date.parse(firstRun) : Infinity);
  const today = new Date(now);
  const out: MonthSummary[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const next = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    const end = Math.min(next.getTime(), now);
    const run = runMinutes(deviceId, start.getTime(), end, now);
    // Degree-days to the end of yesterday for this month: today isn't over.
    const dd = degreeDays(start, i === 0 ? new Date(today.getFullYear(), today.getMonth(), today.getDate()) : next);
    const inside = db.prepare('SELECT AVG(temperature) AS t FROM thermostat_samples WHERE device_id = ? AND at >= ? AND at < ?')
      .get(deviceId, iso(start.getTime()), iso(end)) as { t: number | null };
    out.push({
      month: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
      heatHours: h1(run.heating),
      coolHours: h1(run.cooling),
      hdd: dd.hdd, cdd: dd.cdd, weatherDays: dd.days,
      days: Math.round((end - start.getTime()) / 86_400_000 * 10) / 10,
      inside: inside.t === null ? null : Math.round(inside.t * 10) / 10,
      recorded: since < end,
      partial: i === 0,
    });
  }
  return out;
}

export interface DayHistory {
  /** "2026-11-14" */
  date: string;
  /** Local midnight to midnight, as ISO times. */
  from: string;
  to: string;
  samples: { at: string; temperature: number | null; heat: number | null; cool: number | null; mode: string | null; running: string | null }[];
  runs: { kind: RunKind; from: string; to: string }[];
  /** Outdoor temperature each hour, °C; `at` is the hour's start. */
  outdoor: { at: string; temperature: number }[];
  heatHours: number;
  coolHours: number;
}

/** One local day: samples, runs cut to the day, outdoor hours, and its running hours. */
export function day(deviceId: number, date: string, now = Date.now()): DayHistory {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error('date must be YYYY-MM-DD');
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  const from = start.getTime(), to = next.getTime();
  const db = getDb();
  const samples = db.prepare(`
    SELECT at, temperature, heat, cool, mode, running FROM thermostat_samples
    WHERE device_id = ? AND at >= ? AND at < ? ORDER BY at
  `).all(deviceId, iso(from), iso(to)) as DayHistory['samples'];
  const runs = (db.prepare(`
    SELECT kind, started_at, ended_at FROM thermostat_runs
    WHERE device_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at
  `).all(deviceId, iso(to), iso(from)) as { kind: RunKind; started_at: string; ended_at: string | null }[])
    .map((r) => ({
      kind: r.kind,
      from: iso(Math.max(from, Date.parse(r.started_at))),
      to: iso(Math.min(to, r.ended_at ? Date.parse(r.ended_at) : Math.min(now, to))),
    }))
    .filter((r) => r.to > r.from);
  const outdoor = (db.prepare('SELECT hour, temp_c FROM outdoor_hours WHERE hour >= ? AND hour < ? ORDER BY hour')
    .all(`${date}T00:00`, `${dayKey(next)}T00:00`) as { hour: string; temp_c: number }[])
    .map((r) => {
      const [d, t] = r.hour.split('T');
      const [y, mo, da] = d.split('-').map(Number);
      return { at: iso(new Date(y, mo - 1, da, Number(t.slice(0, 2))).getTime()), temperature: r.temp_c };
    });
  const run = runMinutes(deviceId, from, to, now);
  return { date, from: iso(from), to: iso(to), samples, runs, outdoor, heatHours: h1(run.heating), coolHours: h1(run.cooling) };
}

/** Whether this thermostat has ever said if it's running: without that there are no hours to count. */
export function reportsRunning(deviceId: number): boolean {
  return !!getDb().prepare('SELECT 1 FROM thermostat_samples WHERE device_id = ? AND running IS NOT NULL LIMIT 1').get(deviceId)
    || !!getDb().prepare('SELECT 1 FROM thermostat_runs WHERE device_id = ? LIMIT 1').get(deviceId);
}
