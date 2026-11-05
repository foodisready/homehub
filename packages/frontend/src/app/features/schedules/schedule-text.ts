export interface ScheduleTiming {
  triggerType: 'cron' | 'solar' | 'auto_off';
  cronExpression: string | null;
  solarEvent: string | null;
  solarOffsetMinutes: number;
  durationMinutes: number | null;
}

export const SOLAR_EVENTS = [
  { value: 'sunrise',    label: 'Sunrise' },
  { value: 'sunset',     label: 'Sunset' },
  { value: 'dawn',       label: 'Dawn' },
  { value: 'dusk',       label: 'Dusk' },
  { value: 'goldenHour', label: 'Golden Hour' },
  { value: 'solarNoon',  label: 'Solar Noon' },
];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatTime(hour: number, minute: number): string {
  if (minute === 0 && hour === 0) return 'midnight';
  if (minute === 0 && hour === 12) return 'noon';
  const clock = hour % 12 || 12;
  const mins = minute === 0 ? '' : `:${String(minute).padStart(2, '0')}`;
  return `${clock}${mins} ${hour < 12 ? 'AM' : 'PM'}`;
}

function joinList(items: string[]): string {
  if (items.length < 2) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Reads a cron weekday field. Returns null for anything it can't describe. */
function describeDays(field: string): string | null {
  if (field === '*') return 'Every day';

  const days = new Set<number>();
  for (const part of field.split(',')) {
    const match = /^(\d)(?:-(\d))?$/.exec(part);
    if (!match) return null;
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (first > last || last > 7) return null;
    for (let day = first; day <= last; day++) days.add(day % 7);
  }

  const has = (...wanted: number[]) => wanted.length === days.size && wanted.every((d) => days.has(d));
  if (days.size === 7) return 'Every day';
  if (has(1, 2, 3, 4, 5)) return 'Every weekday';
  if (has(0, 6)) return 'Every weekend';

  // List Monday first, so Sunday comes last.
  const ordered = [...days].sort((a, b) => (a + 6) % 7 - (b + 6) % 7);
  if (ordered.length === 1) return `Every ${DAY_NAMES[ordered[0]]}`;
  return `Every ${joinList(ordered.map((d) => DAY_NAMES[d].slice(0, 3)))}`;
}

/** Puts a cron expression into plain words, or returns it unchanged if it's too unusual. */
export function describeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return expression;

  const [minute, hours, dayOfMonth, month, weekday] = fields;
  if (dayOfMonth !== '*' || month !== '*') return expression;
  if (!/^\d+$/.test(minute) || !/^\d+(,\d+)*$/.test(hours)) return expression;

  const min = Number(minute);
  const hourList = hours.split(',').map(Number).sort((a, b) => a - b);
  if (min > 59 || hourList.some((hour) => hour > 23)) return expression;

  const days = describeDays(weekday);
  if (!days) return expression;
  return `${days} at ${joinList(hourList.map((hour) => formatTime(hour, min)))}`;
}

export function describeTiming(schedule: ScheduleTiming): string {
  if (schedule.triggerType === 'cron') return describeCron(schedule.cronExpression ?? '');
  if (schedule.triggerType === 'auto_off') return `${schedule.durationMinutes} min after turning on`;

  const name = SOLAR_EVENTS.find((e) => e.value === schedule.solarEvent)?.label ?? schedule.solarEvent ?? '';
  const offset = schedule.solarOffsetMinutes;
  if (offset === 0) return name;
  return `${Math.abs(offset)} min ${offset < 0 ? 'before' : 'after'} ${name.toLowerCase()}`;
}

/** "3 h", "90 min" or "1 h 30 min", for a Turn ON schedule's "Turn off after". */
export function describeDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Orders one device's schedules: sun events, then fixed times, then auto-off. */
export function timingOrder(schedule: ScheduleTiming): number {
  if (schedule.triggerType === 'auto_off') return 3000;
  if (schedule.triggerType === 'solar') {
    return SOLAR_EVENTS.findIndex((e) => e.value === schedule.solarEvent) - 100;
  }

  const [minute, hours] = (schedule.cronExpression ?? '').trim().split(/\s+/);
  const firstHour = Math.min(...(hours ?? '').split(',').map(Number));
  const order = firstHour * 60 + Number(minute);
  return Number.isFinite(order) ? order : 2000;
}

// ── Checking a cron expression ─────────────────────────────────
// A copy of backend/src/routes/cron-check.ts, so the form can say what's
// wrong while typing. The backend checks again when it's saved.

const FIELDS = [
  { name: 'minute',          min: 0, max: 59 },
  { name: 'hour',            min: 0, max: 23 },
  { name: 'day of the month', min: 1, max: 31 },
  { name: 'month',           min: 1, max: 12 },
  { name: 'weekday',         min: 0, max: 7 },
];
const SECONDS = { name: 'second', min: 0, max: 59 };

function fieldProblem(value: string, field: { name: string; min: number; max: number }): string | null {
  for (const part of value.split(',')) {
    const match = /^(\*|[a-z]+|\d+(?:-\d+)?)(?:\/(\d+))?$/i.exec(part);
    if (!match) return `The ${field.name} "${value}" isn't something a schedule understands.`;
    if (match[2] !== undefined && Number(match[2]) === 0) return `The ${field.name} "${value}" can't step by 0.`;
    if (match[1] === '*' || /^[a-z]+$/i.test(match[1])) continue;   // names like "mon" are checked by the scheduler
    const [first, last = first] = match[1].split('-').map(Number);
    for (const n of [first, last]) {
      if (n < field.min || n > field.max) return `The ${field.name} must be ${field.min}–${field.max}, not ${n}.`;
    }
    if (first > last) return `The ${field.name} range "${match[1]}" runs backwards.`;
  }
  return null;
}

/** What's wrong with the expression, in words, or null if the scheduler can run it. */
export function cronProblem(expression: string): string | null {
  const parts = expression.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5 && parts.length !== 6) {
    return 'A cron expression has 5 parts: minute, hour, day of the month, month and weekday.';
  }
  const fields = parts.length === 6 ? [SECONDS, ...FIELDS] : FIELDS;
  for (let i = 0; i < parts.length; i++) {
    const problem = fieldProblem(parts[i], fields[i]);
    if (!problem) continue;
    // The usual mistake: hour first. "0 30 * * *" for 12:30 AM.
    const [minute, hour] = parts.length === 6 ? parts.slice(1, 3) : parts.slice(0, 2);
    if (fields[i].name === 'hour' && /^\d+$/.test(minute) && /^\d+$/.test(hour)
        && Number(minute) <= 23 && Number(hour) <= 59) {
      return `${problem} The minute comes first: for ${Number(minute)}:${hour.padStart(2, '0')} write "${Number(hour)} ${Number(minute)} * * *".`;
    }
    return problem;
  }
  return null;
}
