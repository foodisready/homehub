/**
 * Thermostat history, against a temp SQLite DB: runs from the thermostat's reports, running
 * hours cut to days and months, degree-days, and outdoor temperatures. Times are local, built
 * with new Date(y, m, d, h), so the tests pass in any time zone.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-thermostat-history-test-'));

let db: Database.Database;
let h: typeof import('./history');
let home: typeof import('../home/home-settings');
let id = 0;

const at = (m: number, d: number, hour = 0, min = 0) => new Date(2026, m, d, hour, min).getTime();
const view = (running: 'heating' | 'cooling' | 'fan' | 'idle' | null, extra: Record<string, unknown> = {}) => ({
  id, alias: 'Hall', room: null, online: true, unit: 'F' as const, temperature: 20, heat: 20, cool: 26, mode: 'heat' as const,
  modes: ['off', 'heat'] as ('off' | 'heat')[], running, heatLimits: [7, 30] as [number, number], coolLimits: null, deadband: 2.5,
  comfort: { low: 20, high: 24 }, allowed: { low: 16, high: 28 }, ...extra,
});
const runs = () => db.prepare('SELECT kind, started_at, ended_at FROM thermostat_runs WHERE device_id = ? ORDER BY id').all(id) as
  { kind: string; started_at: string; ended_at: string | null }[];
const hours = (day: string, temp: number, n = 24) => {
  const put = db.prepare('INSERT OR REPLACE INTO outdoor_hours (hour, temp_c) VALUES (?, ?)');
  for (let i = 0; i < n; i++) put.run(`${day}T${String(i).padStart(2, '0')}:00`, temp);
};

describe('thermostat history', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    h = await import('./history');
    home = await import('../home/home-settings');
    id = Number(db.prepare("INSERT INTO devices (alias, ip, driver_type, driver_config) VALUES ('Hall', 'matter:1:1', 'matter', '{\"kind\":\"thermostat\"}')").run().lastInsertRowid);
  });
  after(() => { h.stopHistory(); db.close(); fs.rmSync(TMP, { recursive: true, force: true }); });
  beforeEach(() => { db.exec('DELETE FROM thermostat_runs; DELETE FROM thermostat_samples; DELETE FROM outdoor_hours;'); });

  it('starts and ends a run when the thermostat says heating or cooling starts or stops', () => {
    h.noteRunning(id, 'heating', at(10, 1, 6));
    h.noteRunning(id, 'heating', at(10, 1, 6, 5));       // still heating: the same run
    h.noteRunning(id, 'idle', at(10, 1, 6, 40));
    h.noteRunning(id, null, at(10, 1, 7));                // says nothing: nothing changes
    h.noteRunning(id, 'cooling', at(10, 1, 14));
    h.noteRunning(id, 'fan', at(10, 1, 14, 30));          // fan only isn't a run
    assert.deepEqual(runs().map((r) => [r.kind, Date.parse(r.started_at), r.ended_at && Date.parse(r.ended_at)]), [
      ['heating', at(10, 1, 6), at(10, 1, 6, 40)],
      ['cooling', at(10, 1, 14), at(10, 1, 14, 30)],
    ]);
    // Straight from heating to cooling ends one and starts the other.
    h.noteRunning(id, 'heating', at(10, 1, 20));
    h.noteRunning(id, 'cooling', at(10, 1, 21));
    assert.deepEqual(runs().slice(-2).map((r) => [r.kind, r.ended_at && Date.parse(r.ended_at)]), [['heating', at(10, 1, 21)], ['cooling', null]]);
  });

  it('counts minutes inside a time range, cutting runs to fit; a run still going counts to now', () => {
    h.noteRunning(id, 'heating', at(10, 1, 23));
    h.noteRunning(id, 'idle', at(10, 2, 1));              // 23:00 to 01:00, across midnight
    h.noteRunning(id, 'heating', at(10, 2, 7));           // still heating
    assert.deepEqual(h.runMinutes(id, at(10, 1), at(10, 2), at(10, 2, 8)), { heating: 60, cooling: 0 });
    assert.deepEqual(h.runMinutes(id, at(10, 2), at(10, 3), at(10, 2, 8)), { heating: 120, cooling: 0 }, '1 h after midnight, 1 h this morning');
  });

  it('records samples while online, and the runs in them', () => {
    h.recordSample(view('heating') as never, at(10, 3, 9));
    h.recordSample(view('idle', { online: false }) as never, at(10, 3, 9, 5));   // offline: no sample, run left as is
    assert.equal((db.prepare('SELECT COUNT(*) n FROM thermostat_samples').get() as { n: number }).n, 1);
    assert.equal(runs()[0].ended_at, null);
  });

  it('ends a run left open while HomeHub was off at the last sample, not now', () => {
    h.recordSample(view('heating') as never, at(10, 4, 9));
    h.recordSample(view('heating') as never, at(10, 4, 9, 30));
    h.closeStaleRuns();
    assert.equal(Date.parse(runs()[0].ended_at!), at(10, 4, 9, 30));
  });

  it('works out degree-days from each day’s average, in °F degree-days from 65 °F', () => {
    hours('2026-11-05', 10);           // 50 °F all day: 15 heating degree-days
    hours('2026-11-06', 25);           // 77 °F: 12 cooling degree-days
    hours('2026-11-07', 0, 10);        // only 10 hours known: left out
    const dd = h.degreeDays(new Date(2026, 10, 5), new Date(2026, 10, 8));
    assert.deepEqual(dd, { hdd: 15, cdd: 12, days: 2 });
  });

  it('sums each month, oldest first, with this month so far last', () => {
    // Across the end of September, away from a clock change.
    h.recordSample(view('heating') as never, at(8, 30, 22));
    h.noteRunning(id, 'idle', at(9, 1, 2));               // 2 h in September, 2 h in October
    hours('2026-10-01', 10);
    const now = at(9, 15, 12);
    const m = h.months(id, 3, now);
    assert.deepEqual(m.map((x) => x.month), ['2026-08', '2026-09', '2026-10']);
    assert.deepEqual(m.map((x) => [x.heatHours, x.recorded, x.partial]), [[0, false, false], [2, true, false], [2, true, true]]);
    assert.deepEqual([m[2].hdd, m[2].weatherDays], [15, 1]);
    assert.equal(m[1].inside, 20);
  });

  it('counts real time across a clock change', () => {
    // US clocks go back an hour at 2 am on 1 November 2026: midnight to 2 am is 3 hours there.
    h.noteRunning(id, 'heating', at(10, 1, 0));
    h.noteRunning(id, 'idle', at(10, 1, 2));
    const real = (at(10, 1, 2) - at(10, 1, 0)) / 60_000;
    assert.deepEqual(h.runMinutes(id, at(10, 1), at(10, 2), at(10, 2)), { heating: real, cooling: 0 });
  });

  it('gives one day: samples, runs cut to the day, outdoor hours, and its hours', () => {
    h.noteRunning(id, 'heating', at(10, 9, 23));
    h.recordSample(view('heating') as never, at(10, 10, 0, 10));
    h.noteRunning(id, 'idle', at(10, 10, 0, 30));
    hours('2026-11-10', 5, 24);
    const d = h.day(id, '2026-11-10', at(10, 11));
    assert.equal(d.samples.length, 1);
    assert.deepEqual(d.runs.map((r) => [Date.parse(r.from), Date.parse(r.to)]), [[at(10, 10), at(10, 10, 0, 30)]]);
    assert.equal(d.outdoor.length, 24);
    assert.equal(Date.parse(d.outdoor[3].at), at(10, 10, 3));
    assert.equal(d.heatHours, 0.5);
    assert.throws(() => h.day(id, '10/11/2026'), /YYYY-MM-DD/);
  });

  it('knows whether a thermostat reports running at all', () => {
    assert.equal(h.reportsRunning(id), false);
    h.recordSample(view(null) as never, at(10, 12, 9));
    assert.equal(h.reportsRunning(id), false, 'samples that never say');
    h.recordSample(view('idle') as never, at(10, 12, 9, 5));
    assert.equal(h.reportsRunning(id), true);
  });

  it('fetches outdoor hours that have happened, three months back the first time', async () => {
    assert.equal(await h.fetchOutdoor({ fetchImpl: (() => { throw new Error('not called'); }) as never }), 0, 'no location: nothing');
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    home.saveHomeSettings({ latitude: 37.34, longitude: -121.89, timezone: tz });
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => ({ hourly: { time: ['2026-11-14T10:00', '2026-11-14T11:00', '2026-11-14T12:00', '2026-11-14T13:00'], temperature_2m: [12, 13, null, 15] } }) };
    }) as unknown as typeof fetch;
    const kept = await h.fetchOutdoor({ fetchImpl: fake, now: at(10, 14, 12, 30) });
    assert.equal(kept, 2, '10:00 and 11:00; 12:00 has no value, 13:00 hasn’t happened');
    assert.match(urls[0], /past_days=92/);
    assert.match(urls[0], /temperature_unit=celsius/);
    await h.fetchOutdoor({ fetchImpl: fake, now: at(10, 14, 13, 30) });
    assert.match(urls[1], /past_days=3/, 'caught up: three days back');
  });
});
