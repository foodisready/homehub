/**
 * When motion may turn a light on: any time, only when the room is dark by the
 * sensor's own light reading, only between sunset and sunrise, or only between
 * set hours. Each motion rule picks one.
 *
 * Whenever HomeHub can't tell (the sensor doesn't answer, or there's no sunset
 * near the poles), it turns the light on: nobody should be left in the dark by
 * a glitch.
 */
import SunCalc from 'suncalc';
import { solarLocation } from '../home/home-settings';

export const TURN_ON_WHEN = ['always', 'dark', 'sun', 'hours'] as const;
export type TurnOnWhen = typeof TURN_ON_WHEN[number];

export const DEFAULT_DARK_BELOW_LUX = 100;   // the Shelly Motion's own "dark"
export const MAX_LUX = 10_000;
export const MAX_SUN_OFFSET_MINUTES = 180;
const LUX_TIMEOUT_MS = 3_000;

export interface WhenRule {
  turn_on_when:       string;
  dark_below_lux:     number;
  sun_offset_minutes: number;
  hours_from:         string;
  hours_to:           string;
  sensor_ip:          string | null;
  sensor_username:    string | null;
  sensor_password:    string | null;
}

export type Decision =
  | { on: true; lux?: number }
  /** Why motion didn't turn the light on, to show on the Sensors page. */
  | { on: false; reason: string; lux?: number };

export const isTime = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Is this local time within from–to? A range like 17:00–08:00 runs past midnight. */
export function withinHours(now: Date, from: string, to: string): boolean {
  const t = now.getHours() * 60 + now.getMinutes();
  const f = minutesOf(from), e = minutesOf(to);
  return f <= e ? t >= f && t < e : t >= f || t < e;
}

/**
 * Today's dark window: from offset minutes before sunset until offset minutes
 * after sunrise. Null near the poles, where the sun may not rise or set.
 */
export function sunTimes(now: Date, offsetMinutes: number): { darkFrom: Date; darkUntil: Date } | null {
  const { lat, lon } = solarLocation();
  const t = SunCalc.getTimes(now, lat, lon);
  if (Number.isNaN(t.sunrise.getTime()) || Number.isNaN(t.sunset.getTime())) return null;
  return {
    darkFrom: new Date(t.sunset.getTime() - offsetMinutes * 60_000),
    darkUntil: new Date(t.sunrise.getTime() + offsetMinutes * 60_000),
  };
}

const clock = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** Reads a Gen 1 Shelly Motion's light level, in lux. Null if it can't be read. */
export async function readLux(rule: WhenRule, fetcher: typeof fetch = fetch): Promise<number | null> {
  if (!rule.sensor_ip) return null;
  const headers: Record<string, string> = rule.sensor_username
    ? { Authorization: `Basic ${Buffer.from(`${rule.sensor_username}:${rule.sensor_password ?? ''}`).toString('base64')}` }
    : {};
  try {
    const res = await fetcher(`http://${rule.sensor_ip}/status`, { headers, signal: AbortSignal.timeout(LUX_TIMEOUT_MS) });
    if (!res.ok) return null;
    const lux = ((await res.json()) as { lux?: { value?: unknown; is_valid?: unknown } }).lux;
    if (!lux || lux.is_valid === false || typeof lux.value !== 'number' || !Number.isFinite(lux.value)) return null;
    return Math.round(lux.value);
  } catch {
    return null;
  }
}

/** Whether motion should turn the light on now, and if not, why. */
export async function decideTurnOn(rule: WhenRule, now: Date, lux: () => Promise<number | null> = () => readLux(rule)): Promise<Decision> {
  switch (rule.turn_on_when) {
    case 'dark': {
      const value = await lux();
      if (value === null) return { on: true };   // couldn't tell: light the way
      return value < rule.dark_below_lux
        ? { on: true, lux: value }
        : { on: false, lux: value, reason: `bright enough (${value} lux; turns on below ${rule.dark_below_lux})` };
    }
    case 'sun': {
      const sun = sunTimes(now, rule.sun_offset_minutes);
      if (!sun) return { on: true };
      return now >= sun.darkFrom || now < sun.darkUntil
        ? { on: true }
        : { on: false, reason: `daylight (turns on from ${clock(sun.darkFrom)} until ${clock(sun.darkUntil)})` };
    }
    case 'hours':
      return withinHours(now, rule.hours_from, rule.hours_to)
        ? { on: true }
        : { on: false, reason: `outside ${rule.hours_from}–${rule.hours_to}` };
    default:
      return { on: true };
  }
}
