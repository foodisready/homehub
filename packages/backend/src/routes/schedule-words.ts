/**
 * A schedule's time in words, as the Schedules page says it: "Every day at 11:30 PM",
 * "60 min after sunset". Kept in step with frontend/src/app/features/schedules/schedule-text.ts
 * (describeTiming): a schedule whose label is these words is named by its time, and renamed with it.
 */
const SOLAR: Record<string, string> = {
  sunrise: 'Sunrise', sunset: 'Sunset', dawn: 'Dawn', dusk: 'Dusk', goldenHour: 'Golden Hour', solarNoon: 'Solar Noon',
};
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatTime(hour: number, minute: number): string {
  if (minute === 0 && hour === 0) return 'midnight';
  if (minute === 0 && hour === 12) return 'noon';
  return `${hour % 12 || 12}${minute === 0 ? '' : `:${String(minute).padStart(2, '0')}`} ${hour < 12 ? 'AM' : 'PM'}`;
}

const joinList = (items: string[]) => (items.length < 2 ? items[0] ?? '' : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

function describeDays(field: string): string | null {
  if (field === '*') return 'Every day';
  const days = new Set<number>();
  for (const part of field.split(',')) {
    const m = /^(\d)(?:-(\d))?$/.exec(part);
    if (!m) return null;
    const first = Number(m[1]), last = Number(m[2] ?? m[1]);
    if (first > last || last > 7) return null;
    for (let d = first; d <= last; d++) days.add(d % 7);
  }
  const has = (...w: number[]) => w.length === days.size && w.every((d) => days.has(d));
  if (days.size === 7) return 'Every day';
  if (has(1, 2, 3, 4, 5)) return 'Every weekday';
  if (has(0, 6)) return 'Every weekend';
  const ordered = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (ordered.length === 1) return `Every ${DAY_NAMES[ordered[0]]}`;
  return `Every ${joinList(ordered.map((d) => DAY_NAMES[d].slice(0, 3)))}`;
}

export function describeCron(expression: string): string {
  const f = expression.trim().split(/\s+/);
  if (f.length !== 5) return expression;
  const [minute, hours, dom, month, weekday] = f;
  if (dom !== '*' || month !== '*' || !/^\d+$/.test(minute) || !/^\d+(,\d+)*$/.test(hours)) return expression;
  const min = Number(minute);
  const hourList = hours.split(',').map(Number).sort((a, b) => a - b);
  if (min > 59 || hourList.some((h) => h > 23)) return expression;
  const days = describeDays(weekday);
  return days ? `${days} at ${joinList(hourList.map((h) => formatTime(h, min)))}` : expression;
}

export function describeTiming(s: { trigger_type: string; cron_expression: string | null; solar_event: string | null; solar_offset_minutes: number; duration_minutes?: number | null }): string {
  if (s.trigger_type === 'cron') return describeCron(s.cron_expression ?? '');
  if (s.trigger_type === 'auto_off') return `${s.duration_minutes} min after turning on`;
  const name = SOLAR[s.solar_event ?? ''] ?? s.solar_event ?? '';
  const off = s.solar_offset_minutes;
  return off === 0 ? name : `${Math.abs(off)} min ${off < 0 ? 'before' : 'after'} ${name.toLowerCase()}`;
}

/** For a sentence: "every day at 11:30 PM", "at sunset", "60 min after sunset". */
export function timingPhrase(s: Parameters<typeof describeTiming>[0]): string {
  const words = describeTiming(s);
  if (s.trigger_type === 'cron' && words === s.cron_expression) return `at “${words}”`;
  if (s.trigger_type === 'solar' && s.solar_offset_minutes === 0) return `at ${words.toLowerCase()}`;
  return words.charAt(0).toLowerCase() + words.slice(1);
}
