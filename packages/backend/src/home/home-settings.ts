import { getDb } from '../db';

/**
 * Where the home is and its time zone. Sunrise and sunset schedules need the
 * location; clock-time schedules and every time HomeHub shows need the time
 * zone.
 *
 * Set in Settings → Home and kept in the settings table. Until then, HomeHub
 * uses LATITUDE, LONGITUDE and TIMEZONE (or TZ) from .env, so older installs
 * keep working. A value saved in Settings wins over .env.
 */

export interface HomeSettings {
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  /** False until a real location is known, so the page can ask for it. */
  located: boolean;
  /** Where each value came from. */
  source: { location: 'settings' | 'env' | 'none'; timezone: 'settings' | 'env' | 'default' };
}

const KEYS = { latitude: 'home_latitude', longitude: 'home_longitude', timezone: 'home_timezone' } as const;
/** .env.example's San Francisco values: present in many .env files, but never a real home. */
const EXAMPLE = { latitude: 37.7749, longitude: -122.4194 };

export class HomeSettingsError extends Error {}

export function isTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function stored(): Partial<Record<keyof typeof KEYS, string>> {
  const rows = getDb().prepare(`SELECT key, value FROM settings WHERE key IN (?, ?, ?)`)
    .all(KEYS.latitude, KEYS.longitude, KEYS.timezone) as { key: string; value: string }[];
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    latitude: byKey.get(KEYS.latitude),
    longitude: byKey.get(KEYS.longitude),
    timezone: byKey.get(KEYS.timezone),
  };
}

const num = (v: string | undefined) => (v === undefined || v.trim() === '' ? NaN : Number(v));

export function getHomeSettings(): HomeSettings {
  const s = stored();
  let latitude: number | null = null;
  let longitude: number | null = null;
  let location: HomeSettings['source']['location'] = 'none';

  if (Number.isFinite(num(s.latitude)) && Number.isFinite(num(s.longitude))) {
    latitude = num(s.latitude); longitude = num(s.longitude); location = 'settings';
  } else {
    const lat = num(process.env.LATITUDE), lon = num(process.env.LONGITUDE);
    if (Number.isFinite(lat) && Number.isFinite(lon) && !(lat === EXAMPLE.latitude && lon === EXAMPLE.longitude)) {
      latitude = lat; longitude = lon; location = 'env';
    }
  }

  let timezone = 'UTC';
  let tzSource: HomeSettings['source']['timezone'] = 'default';
  const envTz = process.env.TIMEZONE || (process.env.HOMEHUB_ENV_TZ ?? process.env.TZ);
  if (s.timezone && isTimezone(s.timezone)) {
    timezone = s.timezone; tzSource = 'settings';
  } else if (envTz && isTimezone(envTz) && !/^(Etc\/)?UTC$/.test(envTz)) {
    // UTC from the environment is Docker's default, not a choice, so the page still asks.
    timezone = envTz; tzSource = 'env';
  }

  return { latitude, longitude, timezone, located: latitude !== null, source: { location, timezone: tzSource } };
}

/** For sunrise and sunset: the home, or .env.example's location if none is set yet. */
export function solarLocation(): { lat: number; lon: number } {
  const h = getHomeSettings();
  return h.latitude !== null && h.longitude !== null
    ? { lat: h.latitude, lon: h.longitude }
    : { lat: EXAMPLE.latitude, lon: EXAMPLE.longitude };
}

export function saveHomeSettings(input: { latitude?: unknown; longitude?: unknown; timezone?: unknown }): HomeSettings {
  const upsert = getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const hasLat = input.latitude !== undefined, hasLon = input.longitude !== undefined;
  if (hasLat !== hasLon) throw new HomeSettingsError('Send latitude and longitude together');
  if (hasLat) {
    const lat = Number(input.latitude), lon = Number(input.longitude);
    if (input.latitude === null || input.latitude === '' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new HomeSettingsError('Latitude must be a number from -90 to 90');
    }
    if (input.longitude === null || input.longitude === '' || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new HomeSettingsError('Longitude must be a number from -180 to 180');
    }
    // Five decimal places is about a metre: plenty for sunrise times.
    upsert.run(KEYS.latitude, String(Math.round(lat * 1e5) / 1e5));
    upsert.run(KEYS.longitude, String(Math.round(lon * 1e5) / 1e5));
  }
  if (input.timezone !== undefined) {
    if (typeof input.timezone !== 'string' || !isTimezone(input.timezone)) {
      throw new HomeSettingsError('Choose a time zone such as America/New_York');
    }
    upsert.run(KEYS.timezone, input.timezone);
  }
  applyHomeTimezone();
  return getHomeSettings();
}

/**
 * Point this process's clock at the home's time zone. Node picks up a change
 * to process.env.TZ straight away, for Dates and Intl alike.
 */
export function applyHomeTimezone(): void {
  // Remember .env's TZ once, so the fallback survives this process changing TZ.
  if (process.env.HOMEHUB_ENV_TZ === undefined) process.env.HOMEHUB_ENV_TZ = process.env.TZ ?? '';
  const { timezone, source } = getHomeSettings();
  if (source.timezone !== 'default') process.env.TZ = timezone;
}
