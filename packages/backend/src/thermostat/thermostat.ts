import { getDb } from '../db';
import { logger } from '../logger';
import { emitThermostatState } from '../socket';
import { temperatureUnit, type TemperatureUnit } from '../home/weather';
import type { ThermostatMode, ThermostatReading } from '../matter/controller';
import { noteRunning } from './history';

/**
 * Matter thermostats, each a HomeHub device (driver_config.kind 'thermostat').
 *
 * Each has two ranges, in °C:
 * - comfort: where the home should be when people are in and awake. It shapes
 *   advice and shows on the card, and limits nothing.
 * - allowed: the most that Chat, voice, schedules and scenes may ever set,
 *   nights and time away included. A person changing it on the card can go
 *   anywhere the thermostat itself allows.
 */

// matter.js loads only when Matter is used.
const matter = () => import('../matter/controller');

export type ChangeSource = 'app' | 'chat' | 'voice' | 'schedule' | 'scene' | 'assistant';

export interface Ranges {
  comfort: { low: number; high: number };
  allowed: { low: number; high: number };
}

// 68–76 °F comfortable; 60–82 °F allowed.
export const DEFAULT_RANGES: Ranges = {
  comfort: { low: fToC(68), high: fToC(76) },
  allowed: { low: fToC(60), high: fToC(82) },
};

export interface ThermostatView extends ThermostatReading, Ranges {
  id: number;
  alias: string;
  room: string | null;
  online: boolean;
  /** How the home shows temperatures. Every number here is °C. */
  unit: TemperatureUnit;
}

export class ThermostatError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function fToC(f: number): number { return Math.round(((f - 32) * 5 / 9) * 1000) / 1000; }

interface Row { id: number; alias: string; room: string | null; ip: string; driver_config: string | null }

const configOf = (row: Row): { nodeId?: string; endpoint?: number; kind?: string } => {
  try { return row.driver_config ? JSON.parse(row.driver_config) : {}; } catch { return {}; }
};

function rows(): Row[] {
  return (getDb().prepare("SELECT id, alias, room, ip, driver_config FROM devices WHERE driver_type = 'matter'").all() as Row[])
    .filter((r) => configOf(r).kind === 'thermostat');
}

function row(id: number): Row {
  const r = rows().find((x) => x.id === id);
  if (!r) throw new ThermostatError('No thermostat with that id.', 404);
  return r;
}

export function rangesOf(id: number): Ranges {
  const r = getDb().prepare('SELECT comfort_low, comfort_high, allowed_low, allowed_high FROM thermostats WHERE device_id = ?').get(id) as
    { comfort_low: number; comfort_high: number; allowed_low: number; allowed_high: number } | undefined;
  return r ? { comfort: { low: r.comfort_low, high: r.comfort_high }, allowed: { low: r.allowed_low, high: r.allowed_high } } : DEFAULT_RANGES;
}

/** Validates and saves a thermostat's ranges: comfort inside allowed, low below high, at least 1 °C each. */
export function saveRanges(id: number, input: unknown): Ranges {
  row(id);
  const v = (input ?? {}) as { comfort?: { low?: unknown; high?: unknown }; allowed?: { low?: unknown; high?: unknown } };
  const num = (x: unknown, what: string) => {
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 40) throw new ThermostatError(`${what} must be a temperature between 0 and 40 °C.`);
    return x;
  };
  const r: Ranges = {
    comfort: { low: num(v.comfort?.low, 'The lowest comfortable temperature'), high: num(v.comfort?.high, 'The highest comfortable temperature') },
    allowed: { low: num(v.allowed?.low, 'The lowest allowed temperature'), high: num(v.allowed?.high, 'The highest allowed temperature') },
  };
  if (r.comfort.high - r.comfort.low < 1) throw new ThermostatError('The comfortable range must be at least 1 °C (2 °F) wide.');
  if (r.allowed.high - r.allowed.low < 1) throw new ThermostatError('The allowed range must be at least 1 °C (2 °F) wide.');
  if (r.comfort.low < r.allowed.low || r.comfort.high > r.allowed.high) throw new ThermostatError('The comfortable range must be inside the allowed range.');
  getDb().prepare(`
    INSERT INTO thermostats (device_id, comfort_low, comfort_high, allowed_low, allowed_high) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (device_id) DO UPDATE SET comfort_low = excluded.comfort_low, comfort_high = excluded.comfort_high,
      allowed_low = excluded.allowed_low, allowed_high = excluded.allowed_high
  `).run(id, r.comfort.low, r.comfort.high, r.allowed.low, r.allowed.high);
  void refresh(id);
  return r;
}

const last = new Map<number, ThermostatView>();

/** The thermostat now, as the live subscription last heard it; its last known values if it's offline. */
export async function getThermostat(id: number): Promise<ThermostatView> {
  const r = row(id);
  const c = configOf(r);
  const base = { id, alias: r.alias, room: r.room, unit: temperatureUnit(), ...rangesOf(id) };
  try {
    const reading = await (await matter()).readThermostat(c.nodeId!, c.endpoint!);
    const view: ThermostatView = { ...reading, ...base, online: true };
    if (reading.mode !== 'off' && reading.mode !== 'other') rememberMode(id, reading.mode);
    // Every report passes through here, so a run starts and ends when the thermostat says.
    noteRunning(id, reading.running);
    last.set(id, view);
    return view;
  } catch (err) {
    const known = last.get(id);
    if (known) return { ...known, ...base, online: false };
    logger.debug({ id, err: String((err as Error)?.message ?? err) }, 'Thermostat not readable');
    return {
      ...base, online: false, temperature: null, heat: null, cool: null, mode: 'other', modes: ['off'],
      running: null, heatLimits: null, coolLimits: null, deadband: 2.5,
    };
  }
}

export async function listThermostats(): Promise<ThermostatView[]> {
  return Promise.all(rows().map((r) => getThermostat(r.id)));
}

/** Reads a thermostat again and tells every open page. */
export async function refresh(id: number): Promise<void> {
  try { emitThermostatState(await getThermostat(id)); } catch { /* deleted meanwhile */ }
}

/** The thermostat device for a Matter address, for the controller's change reports. */
export function thermostatIdFor(nodeId: string, endpoint: number): number | null {
  return rows().find((r) => { const c = configOf(r); return c.nodeId === nodeId && c.endpoint === endpoint; })?.id ?? null;
}

function rememberMode(id: number, mode: ThermostatMode): void {
  getDb().prepare(`
    INSERT INTO thermostats (device_id, comfort_low, comfort_high, allowed_low, allowed_high, last_mode) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (device_id) DO UPDATE SET last_mode = excluded.last_mode
  `).run(id, DEFAULT_RANGES.comfort.low, DEFAULT_RANGES.comfort.high, DEFAULT_RANGES.allowed.low, DEFAULT_RANGES.allowed.high, mode);
}

/** The mode "on" goes back to: the last one it was in, else heat or cool, whichever it has. */
export function resumeMode(id: number, modes: ThermostatMode[]): ThermostatMode {
  const r = getDb().prepare('SELECT last_mode FROM thermostats WHERE device_id = ?').get(id) as { last_mode: string | null } | undefined;
  const lastMode = r?.last_mode as ThermostatMode | null | undefined;
  if (lastMode && modes.includes(lastMode)) return lastMode;
  return modes.includes('heat') ? 'heat' : modes.includes('cool') ? 'cool' : modes.includes('auto') ? 'auto' : 'off';
}

const round = (x: number) => Math.round(x * 100) / 100;

/**
 * Changes a thermostat's mode or targets, in °C. Anything but a person on the card must stay
 * inside the allowed range. Every change must fit the thermostat's own limits. In auto, the
 * other target moves too if the two would come closer than the thermostat allows.
 */
export async function changeThermostat(id: number, change: { mode?: unknown; heat?: unknown; cool?: unknown }, source: ChangeSource): Promise<ThermostatView> {
  const now = await getThermostat(id);
  if (!now.online) throw new ThermostatError(`${now.alias} isn’t connected.`, 503);
  const out: { mode?: ThermostatMode; heat?: number; cool?: number } = {};

  if (change.mode !== undefined) {
    if (typeof change.mode !== 'string' || !now.modes.includes(change.mode as ThermostatMode)) {
      throw new ThermostatError(`${now.alias} can be set to: ${now.modes.join(', ')}.`);
    }
    out.mode = change.mode as ThermostatMode;
  }
  for (const key of ['heat', 'cool'] as const) {
    const v = change[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new ThermostatError(`The ${key === 'heat' ? 'heating' : 'cooling'} target must be a number.`);
    const limits = key === 'heat' ? now.heatLimits : now.coolLimits;
    if (!limits) throw new ThermostatError(`${now.alias} doesn’t ${key}.`);
    if (v < limits[0] || v > limits[1]) throw new ThermostatError(`${now.alias} can only be set between ${limits[0]} and ${limits[1]} °C.`);
    if (source !== 'app' && (v < now.allowed.low - 0.01 || v > now.allowed.high + 0.01)) {
      throw new ThermostatError(`That’s outside the range allowed for ${now.alias}. Change it in Settings → Devices if you need to.`, 422);
    }
    out[key] = round(v);
  }

  // Auto keeps the two targets apart.
  const mode = out.mode ?? now.mode;
  const heat = out.heat ?? now.heat;
  const cool = out.cool ?? now.cool;
  if (mode === 'auto' && heat !== null && cool !== null && cool - heat < now.deadband) {
    if (out.heat !== undefined && out.cool === undefined) out.cool = round(heat + now.deadband);
    else if (out.cool !== undefined && out.heat === undefined) out.heat = round(cool - now.deadband);
    else throw new ThermostatError(`In auto, cooling must be at least ${now.deadband} °C above heating.`);
  }

  const c = configOf(row(id));
  await (await matter()).setThermostat(c.nodeId!, c.endpoint!, out);
  logger.info({ id, alias: now.alias, source, ...out }, 'Thermostat changed');
  // The thermostat confirms through the live subscription a moment later; until then, show what was set.
  const view = { ...(await getThermostat(id)), ...out };
  emitThermostatState(view);
  return view;
}
