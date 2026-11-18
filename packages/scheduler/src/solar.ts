import SunCalc from 'suncalc';

export const SOLAR_EVENTS = ['sunrise', 'sunset', 'dawn', 'dusk', 'goldenHour', 'solarNoon'] as const;
export type SolarEvent = typeof SOLAR_EVENTS[number];

/**
 * Returns the Date for a solar event on the given day, adjusted by an offset.
 * Returns null if the event is not available (e.g. polar night).
 *
 * SunCalc picks the solar day nearest the time it's given, so just after
 * midnight it returns yesterday's events. Asking at local noon always gives
 * the calendar day of `date`.
 */
export function getSolarEventTime(
  date: Date,
  event: SolarEvent,
  offsetMinutes: number,
  lat: number,
  lon: number,
): Date | null {
  const noon = new Date(date);
  noon.setHours(12, 0, 0, 0);
  const times = SunCalc.getTimes(noon, lat, lon);
  const base  = times[event as keyof SunCalc.GetTimesResult] as Date | undefined;
  if (!base || isNaN(base.getTime())) return null;
  return new Date(base.getTime() + offsetMinutes * 60_000);
}

/**
 * The next time a solar schedule should run: today's event if it's still
 * ahead, else tomorrow's. So a schedule loaded after this morning's sunrise
 * (an update, a saved schedule, a late daily refresh) still runs tomorrow.
 */
export function nextSolarEventTime(
  now: Date,
  event: SolarEvent,
  offsetMinutes: number,
  lat: number,
  lon: number,
): Date | null {
  const today = getSolarEventTime(now, event, offsetMinutes, lat, lon);
  if (today && today.getTime() > now.getTime()) return today;
  const tomorrow = new Date(now);
  tomorrow.setHours(12, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const next = getSolarEventTime(tomorrow, event, offsetMinutes, lat, lon);
  return next && next.getTime() > now.getTime() ? next : null;
}
