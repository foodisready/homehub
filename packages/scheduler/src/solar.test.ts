import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getSolarEventTime, nextSolarEventTime } from './solar';

const LAT = 33.97;
const LON = -84.44;

const sunsetDay = (when: string) => {
  const sunset = getSolarEventTime(new Date(when), 'sunset', 0, LAT, LON);
  return sunset?.toLocaleDateString('en-CA');
};

describe('getSolarEventTime', () => {
  const originalTz = process.env.TZ;

  before(() => { process.env.TZ = 'America/New_York'; });
  after(() => { process.env.TZ = originalTz; });

  it('gives today\'s sunset just after midnight', () => {
    assert.equal(sunsetDay('2026-07-15T00:01:00-04:00'), '2026-07-15');
  });

  it('gives the same day from morning to late evening', () => {
    assert.equal(sunsetDay('2026-07-15T06:00:00-04:00'), '2026-07-15');
    assert.equal(sunsetDay('2026-07-15T23:59:00-04:00'), '2026-07-15');
  });

  it('handles the day the clocks change', () => {
    assert.equal(sunsetDay('2026-11-01T00:01:00-04:00'), '2026-11-01');
  });

  it('applies the offset', () => {
    const when = new Date('2026-07-15T00:01:00-04:00');
    const base  = getSolarEventTime(when, 'sunset', 0, LAT, LON)!;
    const early = getSolarEventTime(when, 'sunset', -30, LAT, LON)!;
    assert.equal(base.getTime() - early.getTime(), 30 * 60_000);
  });
});

describe('nextSolarEventTime', () => {
  const originalTz = process.env.TZ;

  before(() => { process.env.TZ = 'America/New_York'; });
  after(() => { process.env.TZ = originalTz; });

  const local = (d: Date | null) => d?.toLocaleString('en-CA', { timeZone: 'America/New_York', hour12: false });

  it('gives this morning\'s sunrise before it comes', () => {
    const next = nextSolarEventTime(new Date('2026-11-18T05:00:00-05:00'), 'sunrise', 0, LAT, LON);
    assert.match(local(next)!, /^2026-11-18, 07:1\d/);
  });

  it('gives tomorrow\'s sunrise once this morning\'s has passed', () => {
    // The old daily refresh ran at 7:01 PM here and skipped the day's sunrise.
    for (const when of ['2026-11-18T07:30:00-05:00', '2026-11-18T19:01:00-05:00', '2026-11-18T23:59:00-05:00']) {
      const next = nextSolarEventTime(new Date(when), 'sunrise', 0, LAT, LON);
      assert.match(local(next)!, /^2026-11-19, 07:1\d/, when);
    }
  });

  it('gives tonight\'s sunset in the afternoon, and tomorrow\'s after it', () => {
    assert.match(local(nextSolarEventTime(new Date('2026-11-18T15:00:00-05:00'), 'sunset', 0, LAT, LON))!, /^2026-11-18, 17:3\d/);
    assert.match(local(nextSolarEventTime(new Date('2026-11-18T17:40:00-05:00'), 'sunset', 0, LAT, LON))!, /^2026-11-19, 17:3\d/);
  });

  it('counts the offset when deciding whether today\'s has passed', () => {
    // Sunrise is about 7:14; "30 minutes after sunrise" is still ahead at 7:20.
    assert.match(local(nextSolarEventTime(new Date('2026-11-18T07:20:00-05:00'), 'sunrise', 30, LAT, LON))!, /^2026-11-18, 07:4\d/);
  });

  it('crosses the day the clocks change', () => {
    assert.match(local(nextSolarEventTime(new Date('2026-10-31T20:00:00-04:00'), 'sunrise', 0, LAT, LON))!, /^2026-11-01, 06:5\d/);
  });
});
