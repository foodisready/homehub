/**
 * Checks a cron expression the way the scheduler will read it. The scheduler
 * skips one it can't read, so a schedule saved with it would never run; this
 * catches that when it's saved instead. Kept in step with
 * frontend/src/app/features/schedules/schedule-text.ts (cronProblem).
 */

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
