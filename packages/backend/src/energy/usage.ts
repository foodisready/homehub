import { getDb } from '../db';
import { logger } from '../logger';
import { readName } from '../nlp/nickname-suggest';
import { runMinutes } from '../thermostat/history';

/**
 * Where the electricity goes: an estimate for each device HomeHub switches, from how long it
 * was on and what it draws, and the measurement for a device that measures its own power.
 *
 * - On-time is rebuilt from Activity's on/off changes. It counts only while HomeHub was
 *   running and the device was online: a lamp left on while HomeHub was off is unknown, not on.
 *   Checked against a plug that measures: 7.3 h on × its 27.3 W = 199 Wh, measured 200 Wh.
 * - Activity is kept for 90 days by default, so each device's hours on and measured energy
 *   per local day are kept for good in device_energy_days, finished days only. Today is live.
 * - What a device draws: what a person set; else its measured draw; else typical for what its
 *   name says it is (an LED lamp, 9 W). A wall switch's circuit can be anything, and some names
 *   don't say, so those wait for a person: they aren't counted until then.
 * - Cameras, garage doors, valves and thermostats aren't plug loads. A thermostat's heating and
 *   cooling are estimated from its running hours and the system's size, set on the thermostat.
 *
 * Days and months are the home's local time: the process clock runs in its time zone.
 */

const POLL_S = Number(process.env.ENERGY_POLL_INTERVAL_SECONDS) || 30;
/** A reading counts for up to this long, so a gap in readings isn't counted as the last value. */
const READING_MAX_S = POLL_S * 2.5;
const HEARTBEAT_MS = 60_000;
/** HomeHub counts as running until this long after its last heartbeat. */
const HEARTBEAT_GRACE_MS = 90_000;

const iso = (ms: number) => new Date(ms).toISOString();
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayStart = (key: string) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const nextDay = (key: string) => { const [y, m, d] = key.split('-').map(Number); return dayKey(new Date(y, m - 1, d + 1)); };
/** Activity times are ISO; energy readings are SQLite's "YYYY-MM-DD HH:MM:SS", UTC. */
const parseAt = (s: string) => Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);

// ── When HomeHub was running ───────────────────────────────────

let heartbeat: ReturnType<typeof setInterval> | undefined;

/** Notes that HomeHub started, then that it's still running, every minute. */
export function startUptime(now = Date.now()): void {
  const id = Number(getDb().prepare('INSERT INTO homehub_uptime (started_at, last_seen) VALUES (?, ?)').run(iso(now), iso(now)).lastInsertRowid);
  heartbeat = setInterval(() => {
    try { getDb().prepare('UPDATE homehub_uptime SET last_seen = ? WHERE id = ?').run(iso(Date.now()), id); } catch { /* closing */ }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
}

export function stopUptime(): void { if (heartbeat) clearInterval(heartbeat); heartbeat = undefined; }

/** Times HomeHub was running between two times. Before it first kept track, it counts as running. */
export function upIntervals(from: number, to: number): [number, number][] {
  const rows = getDb().prepare('SELECT started_at, last_seen FROM homehub_uptime ORDER BY started_at').all() as { started_at: string; last_seen: string }[];
  if (!rows.length) return [[from, to]];
  const out: [number, number][] = [];
  const first = Date.parse(rows[0].started_at);
  if (from < first) out.push([from, Math.min(first, to)]);
  for (const r of rows) {
    const s = Math.max(from, Date.parse(r.started_at));
    const e = Math.min(to, Date.parse(r.last_seen) + HEARTBEAT_GRACE_MS);
    if (e > s) out.push([s, e]);
  }
  return out;
}

// ── One device's time on ───────────────────────────────────────

/**
 * Seconds a device was on, and seconds HomeHub knew whether it was, between two times.
 * Known: HomeHub running, the device online, and its state known (it has changed at least once).
 */
export function deviceSeconds(deviceId: number, from: number, to: number): { on: number; known: number } {
  const db = getDb();
  const before = (kind: string) => db.prepare(
    'SELECT state FROM device_events WHERE device_id = ? AND kind = ? AND at < ? ORDER BY at DESC, id DESC LIMIT 1',
  ).get(deviceId, kind, iso(from)) as { state: number } | undefined;
  let power: number | null = before('power')?.state ?? null;
  let online = before('online')?.state ?? 1;
  const events = (db.prepare(
    'SELECT kind, state, at FROM device_events WHERE device_id = ? AND at >= ? AND at < ? ORDER BY at, id',
  ).all(deviceId, iso(from), iso(to)) as { kind: string; state: number; at: string }[])
    .map((e) => ({ t: Date.parse(e.at), kind: e.kind, state: e.state }));
  // HomeHub starting and stopping are events too.
  const ups = upIntervals(from, to);
  let up = ups.some(([s, e]) => s <= from && from < e) ? 1 : 0;
  for (const [s, e] of ups) {
    if (s > from) events.push({ t: s, kind: 'up', state: 1 });
    if (e < to) events.push({ t: e, kind: 'up', state: 0 });
  }
  events.sort((a, b) => a.t - b.t);
  let on = 0, known = 0, t = from;
  const add = (until: number) => {
    const span = (until - t) / 1000;
    if (span > 0 && up && online && power !== null) { known += span; if (power === 1) on += span; }
    t = until;
  };
  for (const e of events) {
    add(e.t);
    if (e.kind === 'power') power = e.state;
    else if (e.kind === 'online') online = e.state;
    else up = e.state;
  }
  add(to);
  return { on, known };
}

/** Watt-hours from a measuring device's readings between two times, or null with no readings. */
export function measuredWh(deviceId: number, from: number, to: number): number | null {
  const rows = getDb().prepare(`
    SELECT wattage, recorded_at FROM energy_readings
    WHERE device_id = ? AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at
  `).all(deviceId, iso(from).slice(0, 19).replace('T', ' '), iso(to).slice(0, 19).replace('T', ' ')) as { wattage: number | null; recorded_at: string }[];
  if (!rows.length) return null;
  let wh = 0;
  rows.forEach((r, i) => {
    const t = parseAt(r.recorded_at);
    const next = i + 1 < rows.length ? parseAt(rows[i + 1].recorded_at) : Math.min(to, t + READING_MAX_S * 1000);
    wh += (r.wattage ?? 0) * Math.min((next - t) / 1000, READING_MAX_S) / 3600;
  });
  return Math.round(wh * 10) / 10;
}

// ── Daily summaries ────────────────────────────────────────────

interface DeviceRow {
  id: number; alias: string; room: string | null; nicknames: string | null; driver_type: string;
  driver_config: string | null; has_emeter: number; watts: number | null; created_at: string;
}

function devices(): DeviceRow[] {
  return getDb().prepare('SELECT id, alias, room, nicknames, driver_type, driver_config, has_emeter, watts, created_at FROM devices ORDER BY alias').all() as DeviceRow[];
}

/**
 * Writes each finished day's summary not yet kept, from the device's first event to yesterday,
 * and the last two finished days again in case a change came in late.
 */
export function rollUp(now = Date.now()): number {
  const db = getDb();
  const today = dayKey(new Date(now));
  const put = db.prepare('INSERT OR REPLACE INTO device_energy_days (device_id, day, on_seconds, known_seconds, measured_wh) VALUES (?, ?, ?, ?, ?)');
  let written = 0;
  for (const d of devices()) {
    const first = db.prepare('SELECT MIN(at) AS at FROM device_events WHERE device_id = ?').get(d.id) as { at: string | null };
    const firstReading = d.has_emeter ? (db.prepare('SELECT MIN(recorded_at) AS at FROM energy_readings WHERE device_id = ?').get(d.id) as { at: string | null }).at : null;
    const starts = [first.at, firstReading].filter((x): x is string => !!x).map(parseAt);
    if (!starts.length) continue;
    const kept = new Set((db.prepare('SELECT day FROM device_energy_days WHERE device_id = ?').all(d.id) as { day: string }[]).map((r) => r.day));
    const redo = new Set([dayKey(new Date(now - 86_400_000)), dayKey(new Date(now - 2 * 86_400_000))]);
    db.transaction(() => {
      for (let day = dayKey(new Date(Math.min(...starts))); day < today; day = nextDay(day)) {
        if (kept.has(day) && !redo.has(day)) continue;
        const from = dayStart(day), to = dayStart(nextDay(day));
        const s = deviceSeconds(d.id, from, to);
        put.run(d.id, day, Math.round(s.on), Math.round(s.known), d.has_emeter ? measuredWh(d.id, from, to) : null);
        written++;
      }
    })();
  }
  return written;
}

let rollTimer: ReturnType<typeof setInterval> | undefined;

/** Keeps HomeHub's running times, and writes daily summaries now and every hour. */
export function startEnergy(): void {
  startUptime();
  const run = () => { try { rollUp(); } catch (err) { logger.warn({ err: String((err as Error)?.message ?? err) }, 'Energy summary failed'); } };
  setTimeout(run, 10_000).unref?.();
  rollTimer = setInterval(run, 3_600_000);
  rollTimer.unref?.();
}

export function stopEnergy(): void { stopUptime(); if (rollTimer) clearInterval(rollTimer); }

/**
 * A device's hours on, known hours and measured Wh between two local dates: kept summaries,
 * a finished day not summarised yet worked out from Activity (just after midnight, or just
 * after HomeHub starts), and today live.
 */
function deviceTotals(d: DeviceRow, from: string, to: string, now: number): { on: number; known: number; wh: number | null } {
  const db = getDb();
  const today = dayKey(new Date(now));
  const until = to < today ? to : today;
  const rows = db.prepare('SELECT day, on_seconds, known_seconds, measured_wh FROM device_energy_days WHERE device_id = ? AND day >= ? AND day < ?')
    .all(d.id, from, until) as { day: string; on_seconds: number; known_seconds: number; measured_wh: number | null }[];
  let on = 0, known = 0, wh: number | null = null;
  for (const r of rows) {
    on += r.on_seconds; known += r.known_seconds;
    if (r.measured_wh !== null) wh = (wh ?? 0) + r.measured_wh;
  }
  const first = (db.prepare('SELECT MIN(at) AS at FROM device_events WHERE device_id = ?').get(d.id) as { at: string | null }).at;
  if (first) {
    const kept = new Set(rows.map((r) => r.day));
    const start = dayKey(new Date(Date.parse(first)));
    for (let day = start > from ? start : from; day < until; day = nextDay(day)) {
      if (kept.has(day)) continue;
      const s = deviceSeconds(d.id, dayStart(day), dayStart(nextDay(day)));
      on += s.on; known += s.known;
      if (d.has_emeter) { const m = measuredWh(d.id, dayStart(day), dayStart(nextDay(day))); if (m !== null) wh = (wh ?? 0) + m; }
    }
  }
  if (from <= today && today < to) {
    const live = deviceSeconds(d.id, dayStart(today), now);
    on += live.on; known += live.known;
    if (d.has_emeter) { const m = measuredWh(d.id, dayStart(today), now); if (m !== null) wh = (wh ?? 0) + m; }
  }
  return { on, known, wh };
}

// ── What each device draws ─────────────────────────────────────

export type WattsMethod = 'set' | 'measured' | 'typical' | 'none';
export interface Watts { watts: number | null; method: WattsMethod; label: string | null; rough: boolean }

/** Typical draw by what the name says it is, for a plug. Rough: it switches itself on and off, so time on is the most it could be. */
const TYPICAL: Record<string, { watts: number; label: string; rough?: boolean }> = {
  'lamp': { watts: 9, label: 'an LED lamp' },
  'bedside lamp': { watts: 9, label: 'an LED lamp' },
  'desk lamp': { watts: 9, label: 'an LED lamp' },
  'floor lamp': { watts: 12, label: 'an LED floor lamp' },
  'christmas lights': { watts: 30, label: 'LED string lights' },
  'fan': { watts: 40, label: 'a fan' },
  'air purifier': { watts: 30, label: 'an air purifier' },
  'tv': { watts: 100, label: 'a TV' },
  'humidifier': { watts: 30, label: 'a humidifier', rough: true },
  'dehumidifier': { watts: 300, label: 'a dehumidifier', rough: true },
  'heater': { watts: 1500, label: 'a space heater', rough: true },
  'coffee maker': { watts: 1000, label: 'a coffee maker', rough: true },
  'kettle': { watts: 1500, label: 'a kettle', rough: true },
};

/** What a name ends with, when the rest isn't words HomeHub knows. Longest first. */
const ENDINGS: [RegExp, string][] = [
  [/\bfloor lamps?$/i, 'floor lamp'],
  [/\b(?:christmas|xmas|string) lights?$/i, 'christmas lights'],
  [/\b(?:space )?heater$/i, 'heater'],
  [/\bdehumidifier$/i, 'dehumidifier'],
  [/\bhumidifier$/i, 'humidifier'],
  [/\b(?:air )?purifier$/i, 'air purifier'],
  [/\bfan$/i, 'fan'],
  [/\b(?:lamps?|lights?|bulbs?)$/i, 'lamp'],
];

/** Why a device isn't a plug load, or null if it is. */
export function excludedReason(d: Pick<DeviceRow, 'id' | 'alias' | 'driver_type' | 'driver_config'>): 'camera' | 'garage door' | 'valve' | 'thermostat' | null {
  if (d.driver_type === 'wyze') return 'camera';
  if (d.driver_type === 'meross') return 'garage door';
  try { if (d.driver_config && JSON.parse(d.driver_config)?.kind === 'thermostat') return 'thermostat'; } catch { /* not JSON */ }
  if (/\bvalve\b/i.test(d.alias)) return 'valve';
  const sensors = getDb().prepare('SELECT config FROM sensors WHERE config IS NOT NULL').all() as { config: string }[];
  if (sensors.some((s) => { try { return JSON.parse(s.config)?.shutoffDeviceId === d.id; } catch { return false; } })) return 'valve';
  return null;
}

/** The median draw while on, from the last 30 days of readings, for a device that measures. */
function measuredDraw(deviceId: number, now: number): number | null {
  const rows = getDb().prepare('SELECT wattage FROM energy_readings WHERE device_id = ? AND recorded_at >= ? AND wattage > 1 ORDER BY wattage')
    .all(deviceId, iso(now - 30 * 86_400_000).slice(0, 19).replace('T', ' ')) as { wattage: number }[];
  return rows.length ? Math.round(rows[Math.floor(rows.length / 2)].wattage * 10) / 10 : null;
}

export function wattsFor(d: DeviceRow, now = Date.now()): Watts {
  if (d.watts !== null && d.watts !== undefined) return { watts: d.watts, method: 'set', label: null, rough: false };
  if (d.has_emeter) return { watts: measuredDraw(d.id, now), method: 'measured', label: null, rough: false };
  // A wall switch's circuit can be one bulb or twelve: a person says.
  if (d.driver_type === 'shelly') return { watts: null, method: 'none', label: null, rough: false };
  const names = [d.alias, ...(d.nicknames ? JSON.parse(d.nicknames) as string[] : [])];
  for (const n of names) {
    const thing = readName(n)?.thing?.en[0];
    const t = thing ? TYPICAL[thing] : undefined;
    if (t) return { watts: t.watts, method: 'typical', label: t.label, rough: !!t.rough };
  }
  // A name the reader doesn't fully know, but whose last word says what it is: "Woman bedside lamp".
  for (const n of names) {
    for (const [pattern, key] of ENDINGS) {
      if (pattern.test(n.trim())) { const t = TYPICAL[key]; return { watts: t.watts, method: 'typical', label: t.label, rough: !!t.rough }; }
    }
  }
  return { watts: null, method: 'none', label: null, rough: false };
}

/** Sets what a device draws, or clears it back to typical or measured. */
export function setWatts(deviceId: number, watts: unknown): void {
  if (watts !== null && (typeof watts !== 'number' || !Number.isFinite(watts) || watts < 0 || watts > 5000)) {
    throw new Error('watts must be a number from 0 to 5000, or null');
  }
  getDb().prepare('UPDATE devices SET watts = ? WHERE id = ?').run(watts === null ? null : Math.round(watts * 10) / 10, deviceId);
}

// ── Heating and cooling systems ────────────────────────────────

export type HeatSystem = 'gas' | 'heat_pump' | 'electric';
export type CoolSystem = 'ac' | 'heat_pump';
export interface HvacSystem { heat: HeatSystem | null; heatSize: number | null; cool: CoolSystem | null; coolSize: number | null }

/** Sizes: a gas furnace in BTU/h of input, a heat pump or air conditioner in tons, electric heat in kW. */
export const DEFAULT_SIZE = { gas: 60_000, heat_pump: 3, electric: 10, ac: 3 } as const;

export function hvacSystem(thermostatId: number): HvacSystem {
  const r = getDb().prepare('SELECT heat_system, heat_size, cool_system, cool_size FROM thermostats WHERE device_id = ?').get(thermostatId) as
    { heat_system: string | null; heat_size: number | null; cool_system: string | null; cool_size: number | null } | undefined;
  return {
    heat: (r?.heat_system as HeatSystem) ?? null, heatSize: r?.heat_size ?? null,
    cool: (r?.cool_system as CoolSystem) ?? null, coolSize: r?.cool_size ?? null,
  };
}

export function saveHvacSystem(thermostatId: number, input: unknown): HvacSystem {
  const v = (input ?? {}) as Record<string, unknown>;
  const heat = v.heat ?? null, cool = v.cool ?? null;
  if (heat !== null && !['gas', 'heat_pump', 'electric'].includes(heat as string)) throw new Error('heat must be gas, heat_pump, electric or null');
  if (cool !== null && !['ac', 'heat_pump'].includes(cool as string)) throw new Error('cool must be ac, heat_pump or null');
  const size = (x: unknown, what: string) => {
    if (x === null || x === undefined) return null;
    if (typeof x !== 'number' || !Number.isFinite(x) || x <= 0 || x > 500_000) throw new Error(`${what} must be a positive number`);
    return x;
  };
  const s: HvacSystem = { heat: heat as HeatSystem | null, heatSize: size(v.heatSize, 'heatSize'), cool: cool as CoolSystem | null, coolSize: size(v.coolSize, 'coolSize') };
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM thermostats WHERE device_id = ?').get(thermostatId)) {
    // A thermostat whose ranges were never saved: start from the defaults.
    const f = (x: number) => Math.round(((x - 32) * 5 / 9) * 1000) / 1000;
    db.prepare('INSERT INTO thermostats (device_id, comfort_low, comfort_high, allowed_low, allowed_high) VALUES (?, ?, ?, ?, ?)').run(thermostatId, f(68), f(76), f(60), f(82));
  }
  db.prepare('UPDATE thermostats SET heat_system = ?, heat_size = ?, cool_system = ?, cool_size = ? WHERE device_id = ?')
    .run(s.heat, s.heatSize, s.cool, s.coolSize, thermostatId);
  return s;
}

/**
 * What an hour of running uses. A gas furnace burns its input rating (100,000 BTU is a therm) and
 * runs a blower, about 0.5 kW. A heat pump heating at a COP of 3 uses 12,000 ÷ (3 × 3,412) ≈ 1.17 kW
 * a ton; cooling, a heat pump or air conditioner at an EER of 11 uses 12,000 ÷ 11,000 ≈ 1.09 kW a ton.
 */
export function perHour(kind: 'heating' | 'cooling', s: HvacSystem): { kwh: number; therms: number } | null {
  if (kind === 'heating') {
    if (s.heat === 'gas') return { kwh: 0.5, therms: (s.heatSize ?? DEFAULT_SIZE.gas) / 100_000 };
    if (s.heat === 'heat_pump') return { kwh: (s.heatSize ?? DEFAULT_SIZE.heat_pump) * 12_000 / (3 * 3412), therms: 0 };
    if (s.heat === 'electric') return { kwh: s.heatSize ?? DEFAULT_SIZE.electric, therms: 0 };
    return null;
  }
  if (s.cool) return { kwh: (s.coolSize ?? DEFAULT_SIZE.ac) * 12_000 / 11_000, therms: 0 };
  return null;
}

// ── Prices ─────────────────────────────────────────────────────

export interface Prices { electricity: number | null; gas: number | null; currency: string }

export function getPrices(): Prices {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'energy_prices'").get() as { value: string } | undefined;
  try {
    const v = row ? JSON.parse(row.value) : {};
    return { electricity: v.electricity ?? null, gas: v.gas ?? null, currency: typeof v.currency === 'string' ? v.currency : 'USD' };
  } catch { return { electricity: null, gas: null, currency: 'USD' }; }
}

export function savePrices(input: unknown): Prices {
  const v = (input ?? {}) as Record<string, unknown>;
  const price = (x: unknown, what: string) => {
    if (x === null || x === undefined || x === '') return null;
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 100) throw new Error(`${what} must be a price from 0 to 100, or empty`);
    return x;
  };
  const currency = v.currency === undefined ? getPrices().currency : v.currency;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new Error('currency must be a three-letter code, such as USD');
  const p: Prices = { electricity: price(v.electricity, 'The electricity price'), gas: price(v.gas, 'The gas price'), currency };
  getDb().prepare("INSERT INTO settings (key, value) VALUES ('energy_prices', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(p));
  return p;
}

// ── A month ────────────────────────────────────────────────────

export interface DeviceUsage {
  id: number; alias: string; room: string | null;
  onHours: number;
  /** Hours HomeHub knew whether it was on. */
  knownHours: number;
  kwh: number | null;
  cost: number | null;
  watts: number | null;
  method: WattsMethod;
  label: string | null;
  rough: boolean;
}
export interface HvacUsage {
  id: number; alias: string; kind: 'heating' | 'cooling';
  hours: number; kwh: number | null; therms: number | null; cost: number | null;
  system: string | null;
}
/**
 * cost: what's known, added up; null with no price for something that used energy.
 * notCounted: devices and systems that ran but have nothing to estimate from yet (no wattage, no system).
 */
export interface Totals {
  kwh: number; therms: number; cost: number | null; notCounted: number;
  /** Each fuel's cost, null when its price isn't set: electricity can be told without a gas price. */
  electricityCost: number | null;
  gasCost: number | null;
}
export interface MonthUsage {
  month: string; from: string; to: string; partial: boolean; days: number; daysInMonth: number;
  /** When HomeHub's history starts, if after the start of the month: the month is only counted from then. */
  recordedFrom: string | null;
  prices: Prices;
  devices: DeviceUsage[];
  hvac: HvacUsage[];
  excluded: { id: number; alias: string; reason: string }[];
  totals: Totals;
  /**
   * The same number of days at the start of the month before, for a month so far. Only devices
   * HomeHub recorded through both spans are in it, so it never compares something with nothing:
   * `current` is those same devices this month. `heating`: heating or cooling is in it, which
   * follows the weather.
   */
  previousSameDays: { month: string; days: number; previous: Totals; current: Totals; devices: number; heating: boolean } | null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function costOf(kwh: number | null, therms: number | null, p: Prices): number | null {
  if ((kwh ?? 0) > 0 && p.electricity === null) return null;
  if ((therms ?? 0) > 0 && p.gas === null) return null;
  return r2((kwh ?? 0) * (p.electricity ?? 0) + (therms ?? 0) * (p.gas ?? 0));
}

/** Everything between two local dates (to exclusive), cut at now; only the devices in `only`, if given. */
function usageBetween(from: string, to: string, now: number, only?: Set<number>): Pick<MonthUsage, 'devices' | 'hvac' | 'excluded' | 'totals'> {
  const prices = getPrices();
  const out: Pick<MonthUsage, 'devices' | 'hvac' | 'excluded' | 'totals'> = {
    devices: [], hvac: [], excluded: [], totals: { kwh: 0, therms: 0, cost: 0, notCounted: 0, electricityCost: null, gasCost: null },
  };
  for (const d of devices()) {
    if (only && !only.has(d.id)) continue;
    const reason = excludedReason(d);
    if (reason === 'thermostat') {
      const s = hvacSystem(d.id);
      const end = Math.min(dayStart(to), now);
      const mins = runMinutes(d.id, dayStart(from), end, now);
      for (const kind of ['heating', 'cooling'] as const) {
        const hours = mins[kind] / 60;
        if (hours <= 0 && !perHour(kind, s)) continue;
        const rate = perHour(kind, s);
        const kwh = rate ? r2(hours * rate.kwh) : null;
        const therms = rate ? r2(hours * rate.therms) : null;
        const rowCost = rate ? costOf(kwh, therms, prices) : null;
        out.hvac.push({ id: d.id, alias: d.alias, kind, hours: r2(hours), kwh, therms, cost: rowCost, system: kind === 'heating' ? s.heat : s.cool });
        if (kwh !== null) out.totals.kwh += kwh;
        if (therms !== null) out.totals.therms += therms;
        if (!rate && hours > 0) out.totals.notCounted++;
      }
      continue;
    }
    if (reason) { out.excluded.push({ id: d.id, alias: d.alias, reason }); continue; }
    const t = deviceTotals(d, from, to, now);
    const w = wattsFor(d, now);
    const kwh = w.method === 'measured' ? (t.wh === null ? null : r2(t.wh / 1000)) : w.watts === null ? null : r2((t.on / 3600) * w.watts / 1000);
    const cost = kwh === null ? null : costOf(kwh, 0, prices);
    out.devices.push({
      id: d.id, alias: d.alias, room: d.room, onHours: r2(t.on / 3600), knownHours: r2(t.known / 3600),
      kwh, cost, watts: w.watts, method: w.method, label: w.label, rough: w.rough,
    });
    if (kwh !== null) out.totals.kwh += kwh;
    else if (t.on > 0) out.totals.notCounted++;
  }
  // Each fuel at its own price; the total only when both are known for what was used.
  const kwh = r2(out.totals.kwh), therms = r2(out.totals.therms);
  const electricityCost = prices.electricity === null ? (kwh > 0 ? null : 0) : r2(kwh * prices.electricity);
  const gasCost = prices.gas === null ? (therms > 0 ? null : 0) : r2(therms * prices.gas);
  out.totals = {
    kwh, therms, notCounted: out.totals.notCounted, electricityCost, gasCost,
    cost: electricityCost === null || gasCost === null ? null : r2(electricityCost + gasCost),
  };
  out.devices.sort((a, b) => (b.kwh ?? -1) - (a.kwh ?? -1) || b.onHours - a.onHours);
  return out;
}

/** One month: "2026-11". This month is to now, with the same days of last month to compare. */
export function monthUsage(month: string, now = Date.now()): MonthUsage {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error('month must be YYYY-MM');
  const y = Number(m[1]), mo = Number(m[2]) - 1;
  const from = dayKey(new Date(y, mo, 1)), next = dayKey(new Date(y, mo + 1, 1));
  const daysInMonth = new Date(y, mo + 1, 0).getDate();
  const partial = dayStart(next) > now;
  const end = Math.min(dayStart(next), now);
  const days = Math.max(0, (end - dayStart(from)) / 86_400_000);
  const u = usageBetween(from, next, now);
  const since = historyStart();
  let previousSameDays: MonthUsage['previousSameDays'] = null;
  if (partial && days >= 1) {
    // The same span of last month, to the hour: 14.5 days into November against October's first 14.5,
    // for the devices HomeHub was recording through all of it.
    const pFrom = dayKey(new Date(y, mo - 1, 1));
    const both = new Set(devices().filter((d) => { const t = sourceStart(d); return t !== null && t <= dayStart(pFrom); }).map((d) => d.id));
    if (both.size) {
      const pMs = Math.min(dayStart(pFrom) + days * 86_400_000, dayStart(from));
      const previous = usageBetween(pFrom, from, pMs, both);
      const current = usageBetween(from, next, now, both);
      previousSameDays = {
        month: pFrom.slice(0, 7), days: Math.round(days * 10) / 10, previous: previous.totals, current: current.totals,
        devices: both.size, heating: current.hvac.some((h) => h.kwh !== null) || previous.hvac.some((h) => h.kwh !== null),
      };
    }
  }
  return {
    month, from: iso(dayStart(from)), to: iso(end), partial, days: Math.round(days * 10) / 10, daysInMonth,
    recordedFrom: since !== null && since > dayStart(from) && since < end ? iso(since) : null,
    prices: getPrices(), ...u, previousSameDays,
  };
}

/** When HomeHub's history of one device begins: its first change, reading or summary; a thermostat's first run or sample. */
function sourceStart(d: DeviceRow): number | null {
  const db = getDb();
  const times: (string | null)[] = excludedReason(d) === 'thermostat'
    ? [
      (db.prepare('SELECT MIN(started_at) AS t FROM thermostat_runs WHERE device_id = ?').get(d.id) as { t: string | null }).t,
      (db.prepare('SELECT MIN(at) AS t FROM thermostat_samples WHERE device_id = ?').get(d.id) as { t: string | null }).t,
    ]
    : [
      (db.prepare('SELECT MIN(at) AS t FROM device_events WHERE device_id = ?').get(d.id) as { t: string | null }).t,
      (db.prepare('SELECT MIN(recorded_at) AS t FROM energy_readings WHERE device_id = ?').get(d.id) as { t: string | null }).t,
    ];
  const day = (db.prepare('SELECT MIN(day) AS d FROM device_energy_days WHERE device_id = ?').get(d.id) as { d: string | null }).d;
  const all = [...times.filter((t): t is string => !!t).map(parseAt), ...(day ? [dayStart(day)] : [])];
  return all.length ? Math.min(...all) : null;
}

/** When HomeHub's history begins: the first daily summary, on/off change or thermostat run. */
export function historyStart(): number | null {
  const db = getDb();
  const firstDay = (db.prepare('SELECT MIN(day) AS d FROM device_energy_days').get() as { d: string | null }).d;
  const firstEvent = (db.prepare('SELECT MIN(at) AS at FROM device_events').get() as { at: string | null }).at;
  const firstRun = (db.prepare('SELECT MIN(started_at) AS at FROM thermostat_runs').get() as { at: string | null }).at;
  const t = Math.min(firstDay ? dayStart(firstDay) : Infinity, firstEvent ? Date.parse(firstEvent) : Infinity, firstRun ? Date.parse(firstRun) : Infinity);
  return Number.isFinite(t) ? t : null;
}

/** The last `count` months' totals, oldest first. recorded: HomeHub had history for at least part of it. */
export function monthTotals(count = 12, now = Date.now()): (Totals & { month: string; recorded: boolean })[] {
  const since = historyStart() ?? Infinity;
  const today = new Date(now);
  const out: (Totals & { month: string; recorded: boolean })[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const next = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    const recorded = since < Math.min(next.getTime(), now);
    const u = recorded ? usageBetween(dayKey(start), dayKey(next), now).totals : { kwh: 0, therms: 0, cost: 0, notCounted: 0, electricityCost: 0, gasCost: 0 };
    out.push({ month: dayKey(start).slice(0, 7), recorded, ...u });
  }
  return out;
}
