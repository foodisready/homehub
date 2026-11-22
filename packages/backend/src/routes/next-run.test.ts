import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import SunCalc from 'suncalc';
import { cronMatcher, nextRuns, type NextRunInput } from './next-run';

const NY = 'America/New_York';
const where = { lat: 40.7, lon: -74.0 };
const cron = (id: number, expr: string): NextRunInput => ({ id, trigger_type: 'cron', cron_expression: expr, solar_event: null, solar_offset_minutes: 0 });
const solar = (id: number, event: string, offset = 0): NextRunInput => ({ id, trigger_type: 'solar', cron_expression: null, solar_event: event, solar_offset_minutes: offset });

describe('nextRuns', () => {
  // 2026-11-22 15:00 in New York (EST, UTC-5).
  const now = new Date('2026-11-22T20:00:00Z');

  it('finds a clock schedule later today, in the home time zone', () => {
    assert.equal(nextRuns([cron(1, '0 21 * * *')], now, NY, where).get(1), '2026-11-23T02:00:00.000Z');
  });

  it('rolls to tomorrow when today’s time has passed', () => {
    assert.equal(nextRuns([cron(1, '30 0 * * *')], now, NY, where).get(1), '2026-11-23T05:30:00.000Z');
  });

  it('honours weekdays, names and Sunday as 7', () => {
    // Sunday the 22nd: a weekday schedule waits for Monday morning.
    assert.equal(nextRuns([cron(1, '0 8 * * 1-5')], now, NY, where).get(1), '2026-11-23T13:00:00.000Z');
    assert.equal(nextRuns([cron(1, '0 8 * * mon')], now, NY, where).get(1), '2026-11-23T13:00:00.000Z');
    assert.equal(nextRuns([cron(1, '0 18 * * 7')], now, NY, where).get(1), '2026-11-22T23:00:00.000Z');
  });

  it('lists times and steps, and ignores a seconds part', () => {
    assert.equal(nextRuns([cron(1, '30 23,19 * * *')], now, NY, where).get(1), '2026-11-23T00:30:00.000Z');
    assert.equal(nextRuns([cron(1, '*/15 * * * *')], now, NY, where).get(1), '2026-11-22T20:15:00.000Z');
    assert.equal(nextRuns([cron(1, '0 0 21 * * *')], now, NY, where).get(1), '2026-11-23T02:00:00.000Z');
  });

  it('has nothing for one beyond two days, one it can’t read, or auto-off', () => {
    const r = nextRuns([cron(1, '0 9 1 1 *'), cron(2, 'every night'),
      { id: 3, trigger_type: 'auto_off', cron_expression: null, solar_event: null, solar_offset_minutes: 0 }], now, NY, where);
    assert.equal(r.get(1), null);
    assert.equal(r.get(2), null);
    assert.equal(r.get(3), null);
  });

  it('puts sunset with an offset on the clock, today while it’s ahead', () => {
    const sunset = SunCalc.getTimes(new Date('2026-11-22T17:00:00Z'), where.lat, where.lon).sunset.getTime();
    const got = Date.parse(nextRuns([solar(1, 'sunset', 60)], now, NY, where).get(1)!);
    assert.equal(got, sunset + 3_600_000);
    // Sunset in New York in late November is around 4:30 PM.
    assert.ok(got > now.getTime() && got < Date.parse('2026-11-23T00:00:00Z'));
  });

  it('moves a sun schedule to tomorrow once today’s has passed', () => {
    const got = Date.parse(nextRuns([solar(1, 'sunrise')], now, NY, where).get(1)!);
    // Tomorrow's sunrise, around 7 AM EST.
    assert.ok(got > Date.parse('2026-11-23T11:00:00Z') && got < Date.parse('2026-11-23T13:00:00Z'), new Date(got).toISOString());
  });

  it('crosses a month end for tomorrow’s sun', () => {
    const late = new Date('2026-12-01T03:00:00Z'); // 10 PM on Nov 30 in New York
    const got = Date.parse(nextRuns([solar(1, 'sunrise')], late, NY, where).get(1)!);
    assert.ok(got > Date.parse('2026-12-01T11:00:00Z') && got < Date.parse('2026-12-01T13:00:00Z'), new Date(got).toISOString());
  });
});

describe('cronMatcher', () => {
  it('reads month names and ranges', () => {
    const m = cronMatcher('0 9 * nov-dec *')!;
    assert.ok(m({ minute: 0, hour: 9, day: 5, month: 12, weekday: 1 }));
    assert.ok(!m({ minute: 0, hour: 9, day: 5, month: 6, weekday: 1 }));
  });
});
