import { getHomeSettings } from './home-settings';
import { logger } from '../logger';

/**
 * The weather at home, from Open-Meteo (open-meteo.com): free, with no account
 * or key. Only the home's location leaves the house, rounded to two decimal
 * places (about a kilometre). Asked at most every ten minutes.
 */

export type TemperatureUnit = 'F' | 'C';

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

/** Time zones of the United States and its territories, where temperatures are in °F. */
const FAHRENHEIT_ZONES = /^(?:America\/(?:New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Juneau|Sitka|Yakutat|Nome|Metlakatla|Adak|Boise|Detroit|Indiana\/.+|Kentucky\/.+|North_Dakota\/.+|Menominee|Puerto_Rico|St_Thomas)|Pacific\/(?:Honolulu|Guam|Saipan|Pago_Pago)|US\/.+)$/;

/** °F in the United States, °C elsewhere; TEMPERATURE_UNIT=C or F in .env decides instead. */
export function temperatureUnit(timezone = getHomeSettings().timezone): TemperatureUnit {
  const set = process.env.TEMPERATURE_UNIT?.trim().toUpperCase();
  if (set === 'C' || set === 'F') return set;
  return FAHRENHEIT_ZONES.test(timezone) ? 'F' : 'C';
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
let cached: { key: string; at: number; weather: Weather } | null = null;

/** For tests. */
export function clearWeatherCache(): void { cached = null; }

const round = (n: unknown) => Math.round(Number(n));

export async function getWeather(opts: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<Weather> {
  const home = getHomeSettings();
  if (home.latitude === null || home.longitude === null) {
    throw new WeatherError("HomeHub doesn't know where your home is yet. Set it in Settings → Home.", 'NOT_LOCATED');
  }
  const unit = temperatureUnit(home.timezone);
  const lat = home.latitude.toFixed(2), lon = home.longitude.toFixed(2);
  const key = `${lat},${lon},${unit},${home.timezone}`;
  const now = opts.now ?? Date.now();
  if (cached && cached.key === key && now - cached.at < CACHE_MS) return cached.weather;

  const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: lat, longitude: lon,
    current: 'temperature_2m,apparent_temperature,weather_code',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code',
    temperature_unit: unit === 'F' ? 'fahrenheit' : 'celsius',
    timezone: home.timezone,
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
  cached = { key, at: now, weather };
  return weather;
}
