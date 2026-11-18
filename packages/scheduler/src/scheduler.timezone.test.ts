/**
 * Clock schedules run in the home's time zone (Settings → Home), not the
 * container's. The container is UTC, and node-cron kept the first time zone
 * it saw, so "midnight" ran at 7 PM in New York and the daily sunrise refresh
 * at 7:01 PM, after the day's sunrise, which then never ran.
 */
process.env.TZ = 'UTC';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import cron from 'node-cron';
import Database from 'better-sqlite3';

const NY = 'America/New_York';
const inNY = (d: Date | null | undefined) =>
  d?.toLocaleString('en-CA', { timeZone: NY, hour12: false, hour: '2-digit', minute: '2-digit' });

describe('Schedules in the home\'s time zone', () => {
  let db: Database.Database;
  let service: import('./scheduler.service').SchedulerService;
  const early = cron.schedule('0 0 * * *', () => undefined);   // a job made before the time zone is known, as at start-up

  before(async () => {
    process.env.INTERNAL_API_KEY = 'test-key';
    db = new Database(':memory:');
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE schedules (
        id INTEGER PRIMARY KEY, device_id INTEGER, label TEXT, trigger_type TEXT, cron_expression TEXT,
        solar_event TEXT, solar_offset_minutes INTEGER DEFAULT 0, duration_minutes INTEGER,
        stay_on_minutes INTEGER, state INTEGER, enabled INTEGER DEFAULT 1)`);
    db.prepare("INSERT INTO settings VALUES ('home_latitude', '33.97'), ('home_longitude', '-84.44'), ('home_timezone', ?)").run(NY);
    db.prepare("INSERT INTO schedules (id, device_id, label, trigger_type, cron_expression, state) VALUES (1, 7, 'Every day at midnight', 'cron', '0 0 * * *', 0)").run();
    db.prepare("INSERT INTO schedules (id, device_id, label, trigger_type, cron_expression, state) VALUES (2, 8, 'Vinyl lamp', 'cron', '30 19,23 * * *', 1)").run();
    db.prepare("INSERT INTO schedules (id, device_id, label, trigger_type, solar_event, state) VALUES (3, 9, 'Sunrise', 'solar', 'sunrise', 1)").run();
    db.prepare("INSERT INTO schedules (id, device_id, label, trigger_type, solar_event, state) VALUES (4, 9, 'Sunset', 'solar', 'sunset', 1)").run();
    const { SchedulerService } = await import('./scheduler.service');
    service = new SchedulerService(db);
    service.load();
  });

  after(() => {
    service.clearAll();
    early.stop();
    db.close();
    process.env.TZ = 'UTC';
  });

  it('runs "midnight" at midnight at home, not at 7 PM', () => {
    assert.equal(inNY(service.nextCronRuns().get(1)), '00:00');
  });

  it('runs a 7:30 PM schedule at 7:30 PM at home', () => {
    assert.equal(inNY(service.nextCronRuns().get(2)), '19:30');
  });

  it('works out the day\'s sunrise and sunset just after midnight at home', () => {
    assert.equal(inNY(service.nextCronRuns().get('daily')), '00:01');
  });

  it('always has a next sunrise and sunset, within a day', () => {
    const runs = service.nextSolarRuns();
    for (const id of [3, 4]) {
      const at = runs.get(id);
      assert.ok(at, `schedule ${id} has a next run`);
      const ms = at.getTime() - Date.now();
      assert.ok(ms > 0 && ms <= 25 * 3600_000, `schedule ${id} runs within a day (${at.toISOString()})`);
    }
    assert.match(inNY(runs.get(3))!, /^0[67]:/);
    assert.match(inNY(runs.get(4))!, /^1[78]:/);
  });

  it('follows a time zone change on the next load', () => {
    db.prepare("UPDATE settings SET value = 'America/Los_Angeles' WHERE key = 'home_timezone'").run();
    service.load();
    const la = service.nextCronRuns().get(1)!.toLocaleString('en-CA', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit' });
    assert.equal(la, '00:00');
    db.prepare("UPDATE settings SET value = ? WHERE key = 'home_timezone'").run(NY);
    service.load();
  });
});
