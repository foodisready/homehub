import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getSolarEventTime } from './solar';

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
