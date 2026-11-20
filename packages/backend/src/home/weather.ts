import { getHomeSettings, type TemperatureUnit } from './home-settings';
import { logger } from '../logger';

/**
 * The weather at home, from Open-Meteo (open-meteo.com): free, with no account
 * or key. Only the home's location leaves the house, rounded to two decimal
 * places (about a kilometre). Asked at most every ten minutes per place.
 *
 * A question about another city ("the weather in New York?") looks the city up
 * with Open-Meteo's geocoding first: only the city's name is sent.
 */

export type { TemperatureUnit } from './home-settings';

export interface DayForecast {
  /** YYYY-MM-DD, in the home's time zone. */
  date: string;
  high: number;
  low: number;
  /** The chance of rain or snow, 0 to 100. */
  rain: number;
  /** A WMO weather code: 0 clear, 2 partly cloudy, 61 rain... */
  code: number;
}

export interface Weather {
  unit: TemperatureUnit;
  now: { temperature: number; feelsLike: number; code: number };
  today: DayForecast;
  tomorrow: DayForecast;
  fetchedAt: string;
}

export class WeatherError extends Error {
  constructor(message: string, readonly code: 'NOT_LOCATED' | 'UNREACHABLE') { super(message); }
}

/** A city asked about, found by name. */
export interface Place {
  /** As Open-Meteo names it, in English: "New York", "Hong Kong". */
  name:      string;
  latitude:  number;
  longitude: number;
  timezone:  string;
}

/** How the home shows temperatures: chosen in Settings → Home, else TEMPERATURE_UNIT, else by time zone. */
export function temperatureUnit(): TemperatureUnit {
  return getHomeSettings().temperatureUnit;
}

/** What a WMO weather code means, in a few words: "partly cloudy", "light rain". */
export function describeWeather(code: number): string {
  if (code === 0) return 'clear';
  if (code === 1) return 'mostly clear';
  if (code === 2) return 'partly cloudy';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'foggy';
  if (code >= 51 && code <= 57) return 'drizzly';
  if (code === 61 || code === 80) return 'light rain';
  if (code === 63 || code === 81) return 'rain';
  if (code === 65 || code === 82) return 'heavy rain';
  if (code === 66 || code === 67) return 'freezing rain';
  if (code === 71 || code === 85) return 'light snow';
  if (code === 73 || code === 75 || code === 77 || code === 86) return 'snow';
  if (code >= 95) return 'thunderstorms';
  return 'mixed';
}

const CACHE_MS = 10 * 60_000;
const cached = new Map<string, { at: number; weather: Weather }>();
const places = new Map<string, Place | null>();

/** For tests. */
export function clearWeatherCache(): void { cached.clear(); places.clear(); }

/**
 * A city by its name in English, or null when Open-Meteo knows no place by that name.
 * Throws WeatherError when Open-Meteo can't be reached. Remembered while HomeHub runs.
 */
export async function findPlace(name: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<Place | null> {
  const key = name.trim().toLowerCase();
  if (places.has(key)) return places.get(key)!;
  const url = 'https://geocoding-api.open-meteo.com/v1/search?' + new URLSearchParams({ name: name.trim(), count: '1', language: 'en', format: 'json' });
  let data: any;
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Open-Meteo geocoding answered ${res.status}`);
    data = await res.json();
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Place lookup unavailable');
    throw new WeatherError("I can't get the weather right now.", 'UNREACHABLE');
  }
  const r = Array.isArray(data?.results) ? data.results[0] : null;
  const place: Place | null = r && Number.isFinite(r.latitude) && Number.isFinite(r.longitude) && typeof r.timezone === 'string'
    ? { name: String(r.name ?? name), latitude: r.latitude, longitude: r.longitude, timezone: r.timezone }
    : null;
  places.set(key, place);
  return place;
}

const round = (n: unknown) => Math.round(Number(n));

/** The weather at home, or with `place`, in that city: in the home's unit, with "today" as the city's day. */
export async function getWeather(opts: { fetchImpl?: typeof fetch; now?: number; place?: Place } = {}): Promise<Weather> {
  const home = getHomeSettings();
  const where = opts.place ?? (home.latitude === null || home.longitude === null ? null
    : { latitude: home.latitude, longitude: home.longitude, timezone: home.timezone });
  if (!where) {
    throw new WeatherError("HomeHub doesn't know where your home is yet. Set it in Settings → Home.", 'NOT_LOCATED');
  }
  const unit = home.temperatureUnit;
  const lat = where.latitude.toFixed(2), lon = where.longitude.toFixed(2);
  const key = `${lat},${lon},${unit},${where.timezone}`;
  const now = opts.now ?? Date.now();
  const hit = cached.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.weather;

  const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: lat, longitude: lon,
    current: 'temperature_2m,apparent_temperature,weather_code',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code',
    temperature_unit: unit === 'F' ? 'fahrenheit' : 'celsius',
    timezone: where.timezone,
    forecast_days: '2',
  });
  let data: any;
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
    data = await res.json();
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Weather unavailable');
    throw new WeatherError("I can't get the weather right now.", 'UNREACHABLE');
  }
  const d = data?.daily, c = data?.current;
  if (!c || !Array.isArray(d?.time) || d.time.length < 2) {
    throw new WeatherError("I can't get the weather right now.", 'UNREACHABLE');
  }
  const day = (i: number): DayForecast => ({
    date: String(d.time[i]),
    high: round(d.temperature_2m_max[i]),
    low: round(d.temperature_2m_min[i]),
    rain: round(d.precipitation_probability_max?.[i] ?? 0),
    code: round(d.weather_code[i]),
  });
  const weather: Weather = {
    unit,
    now: { temperature: round(c.temperature_2m), feelsLike: round(c.apparent_temperature), code: round(c.weather_code) },
    today: day(0),
    tomorrow: day(1),
    fetchedAt: new Date(now).toISOString(),
  };
  cached.set(key, { at: now, weather });
  if (cached.size > 20) cached.delete(cached.keys().next().value!);
  return weather;
}
