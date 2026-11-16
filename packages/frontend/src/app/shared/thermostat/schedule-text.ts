import { shown, type SchedulePoint } from './thermostat.service';

const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Monday first, Sunday last, as people read a week. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const WEEKDAYS = [1, 2, 3, 4, 5];
export const WEEKENDS = [0, 6];
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

const same = (a: number[], b: number[]) => a.length === b.length && b.every((d) => a.includes(d));

/** "Every day", "Weekdays", "Weekends", "Mon, Wed and Fri" or "Tuesdays". */
export function describeDays(days: number[]): string {
  if (same(days, EVERY_DAY)) return 'Every day';
  if (same(days, WEEKDAYS)) return 'Weekdays';
  if (same(days, WEEKENDS)) return 'Weekends';
  const ordered = WEEK_ORDER.filter((d) => days.includes(d));
  if (ordered.length === 1) return `${LONG[ordered[0]]}s`;
  const names = ordered.map((d) => SHORT[d]);
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "6:30 AM" from "06:30". */
export function clock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  if (h === 0 && m === 0) return 'Midnight';
  if (h === 12 && m === 0) return 'Noon';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "6:30 AM", "Sunset" or "30 min before sunrise". */
export function describeWhen(p: Pick<SchedulePoint, 'time' | 'sun'>): string {
  if (p.time) return clock(p.time);
  if (!p.sun) return '';
  const name = p.sun.event === 'sunrise' ? 'sunrise' : 'sunset';
  if (!p.sun.offset) return name[0].toUpperCase() + name.slice(1);
  return `${Math.abs(p.sun.offset)} min ${p.sun.offset < 0 ? 'before' : 'after'} ${name}`;
}

/** "Heat 68° · Cool 76°", or just the one it sets. */
export function describeTargets(p: Pick<SchedulePoint, 'heat' | 'cool'>, unit: 'F' | 'C'): string {
  const parts: string[] = [];
  if (p.heat !== null) parts.push(`Heat ${shown(p.heat, unit)}°`);
  if (p.cool !== null) parts.push(`Cool ${shown(p.cool, unit)}°`);
  return parts.join(' · ');
}

/** Sorts a schedule by the first day of the week it's on, then time of day (sun events by their usual hour). */
export function pointOrder(p: SchedulePoint): number {
  const first = Math.min(...p.days.map((d) => WEEK_ORDER.indexOf(d)));
  const minute = p.time
    ? Number(p.time.slice(0, 2)) * 60 + Number(p.time.slice(3))
    : (p.sun?.event === 'sunrise' ? 7 * 60 : 17 * 60) + (p.sun?.offset ?? 0);
  // Every day and weekdays come before single days: the usual week reads first.
  return (p.days.length >= 5 ? 0 : 10_000 + first * 2000) + minute;
}

/** "10:30 PM today", "6:30 AM tomorrow" or "8:00 AM Saturday", in the home's time zone. */
export function describeNext(iso: string, timezone: string, now = new Date()): string {
  const at = new Date(iso);
  const opts = { timeZone: timezone || undefined };
  const dayKey = (d: Date) => d.toLocaleDateString('en-CA', opts);
  const time = at.toLocaleTimeString('en-US', { ...opts, hour: 'numeric', minute: '2-digit' });
  const tomorrow = new Date(now.getTime() + 24 * 3600_000);
  if (dayKey(at) === dayKey(now)) return `${time} today`;
  if (dayKey(at) === dayKey(tomorrow)) return `${time} tomorrow`;
  return `${time} ${at.toLocaleDateString('en-US', { ...opts, weekday: 'long' })}`;
}
