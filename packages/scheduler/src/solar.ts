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
