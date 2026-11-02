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
