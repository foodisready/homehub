/**
 * When each schedule runs next, for the Schedules page's "Coming up": the same times the
 * scheduler uses, worked out here so the page can put "1 h after sunset" on the clock.
 *
 * Clock (cron) schedules are matched minute by minute over the next two days in the home's
 * time zone; one that doesn't run in that time has no next time here. Sun schedules use the
 * same SunCalc times as the scheduler. Auto-off schedules follow the device, so they have none.
 */
import SunCalc from 'suncalc';

const LOOKAHEAD_MINUTES = 48 * 60;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface Local { minute: number; hour: number; day: number; month: number; weekday: number }

/** A cron field as the set of values it allows, or null for "*" (any). Names like "mon" are read. */
function field(text: string, min: number, max: number, names?: string[]): Set<number> | null {
  if (text === '*') return null;
  const out = new Set<number>();
  const value = (s: string) => {
    const i = names?.indexOf(s.slice(0, 3).toLowerCase()) ?? -1;
    return i >= 0 ? i + (names === MONTHS ? 1 : 0) : Number(s);
  };
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText ? Number(stepText) : 1;
    let lo = min, hi = max;
    if (range !== '*') {
      const [a, b] = range.split('-');
      lo = value(a);
      hi = b !== undefined ? value(b) : stepText ? max : lo;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(step > 0)) return new Set();
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface CronMatcher { (t: Local): boolean }

/** A matcher for a 5- or 6-part cron expression (seconds are ignored), or null if it can't be read. */
export function cronMatcher(expression: string): CronMatcher | null {
  let parts = expression.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 6) parts = parts.slice(1);
  if (parts.length !== 5) return null;
  const [mi, ho, dom, mo, dow] = [
    field(parts[0], 0, 59), field(parts[1], 0, 23), field(parts[2], 1, 31), field(parts[3], 1, 12, MONTHS), field(parts[4], 0, 7, DAYS),
  ];
  // 7 is Sunday too. node-cron needs the day of the month and the weekday both to match.
  if (dow?.has(7)) dow.add(0);
  return (t) => (!mi || mi.has(t.minute)) && (!ho || ho.has(t.hour)) && (!dom || dom.has(t.day))
    && (!mo || mo.has(t.month)) && (!dow || dow.has(t.weekday));
}

/** Each minute of the next two days, as the home's clock reads it. */
function minutesAhead(now: Date, timeZone: string): Array<{ at: number; t: Local }> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short',
  });
  const start = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
  const out: Array<{ at: number; t: Local }> = [];
  for (let i = 0; i < LOOKAHEAD_MINUTES; i++) {
    const at = start + i * 60_000;
    const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
    out.push({ at, t: { minute: Number(p.minute), hour: Number(p.hour) % 24, day: Number(p.day), month: Number(p.month), weekday: DAYS.indexOf(p.weekday.slice(0, 3).toLowerCase()) } });
  }
  return out;
}

/** The home's calendar date now: [year, month, day]. */
function localDate(now: Date, timeZone: string): [number, number, number] {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return [Number(p.year), Number(p.month), Number(p.day)];
}

/**
 * A sun event on a calendar day, moved by an offset. SunCalc answers for the solar day nearest
 * the time it's given, so it's asked at that day's solar noon where the home is.
 */
function sunTime(y: number, m: number, d: number, event: string, offset: number, lat: number, lon: number): number | null {
  const noon = new Date(Date.UTC(y, m - 1, d, 12) - (lon / 15) * 3_600_000);
  const base = (SunCalc.getTimes(noon, lat, lon) as unknown as Record<string, Date | undefined>)[event];
  if (!base || Number.isNaN(base.getTime())) return null;
  return base.getTime() + offset * 60_000;
}

export interface NextRunInput {
  id: number;
  trigger_type: 'cron' | 'solar' | 'auto_off';
  cron_expression: string | null;
  solar_event: string | null;
  solar_offset_minutes: number;
}

/** Each schedule's next run, as an ISO time, or null when there's none in the next two days. */
export function nextRuns(rows: NextRunInput[], now: Date, timeZone: string, where: { lat: number; lon: number }): Map<number, string | null> {
  const out = new Map<number, string | null>();
  let minutes: Array<{ at: number; t: Local }> | null = null;
  const [y, m, d] = localDate(now, timeZone);
  for (const row of rows) {
    let next: number | null = null;
    if (row.trigger_type === 'cron' && row.cron_expression) {
      const match = cronMatcher(row.cron_expression);
      if (match) {
        minutes ??= minutesAhead(now, timeZone);
        next = minutes.find((x) => match(x.t))?.at ?? null;
      }
    } else if (row.trigger_type === 'solar' && row.solar_event) {
      // Today's, if it's still ahead; else tomorrow's. Date.UTC rolls the day over the month's end.
      for (const add of [0, 1]) {
        const day = new Date(Date.UTC(y, m - 1, d + add));
        const t = sunTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), row.solar_event, row.solar_offset_minutes, where.lat, where.lon);
        if (t !== null && t > now.getTime()) { next = t; break; }
      }
    }
    out.set(row.id, next === null ? null : new Date(next).toISOString());
  }
  return out;
}
