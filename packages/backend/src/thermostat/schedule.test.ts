/**
 * Thermostat temperature schedules, against a temp SQLite DB with a stubbed thermostat.
 * The home is in San Francisco's time zone (the default location), with °F.
 * 2026-11-16 is a Monday.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { ThermostatView } from './thermostat';

process.env.TZ = 'America/Los_Angeles';
process.env.TEMPERATURE_UNIT = 'F';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-thermostat-schedule-test-'));

let db: Database.Database;
let s: typeof import('./schedule');
let id = 0;

const at = (d: number, h = 0, min = 0) => new Date(2026, 10, d, h, min);   // November 2026
const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

const thermostat = (over: Partial<ThermostatView> = {}): ThermostatView => ({
  id, alias: 'Hall', room: null, online: true, unit: 'F', temperature: 20, heat: 20, cool: 26, mode: 'heat',
  modes: ['off', 'heat', 'cool', 'auto'], running: 'idle', heatLimits: [7, 30], coolLimits: [16, 32], deadband: 2.5,
  comfort: { low: 20, high: 24.4 }, allowed: { low: 15.6, high: 27.8 }, ...over,
});

/** A stub thermostat: what it reads as, and the changes sent to it. */
function stub(over: Partial<ThermostatView> = {}) {
  const sent: { heat?: number; cool?: number }[] = [];
  let view = thermostat(over);
  return {
    sent,
    deps: {
      read: async () => view,
      change: async (_id: number, c: { heat?: number; cool?: number }) => { sent.push(c); view = { ...view, ...c }; },
    },
  };
}

const save = (points: unknown[]) => s.saveSchedule(id, { points }, async () => thermostat());
const checked = (t: Date | null) =>
  db.prepare('UPDATE thermostats SET schedule_checked_at = ? WHERE device_id = ?').run(t ? t.toISOString() : null, id);

describe('thermostat schedules', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    s = await import('./schedule');
    id = Number(db.prepare("INSERT INTO devices (alias, ip, driver_type, driver_config) VALUES ('Hall', 'matter:1:1', 'matter', '{\"kind\":\"thermostat\",\"nodeId\":\"1\",\"endpoint\":1}')").run().lastInsertRowid);
  });
  after(() => { s.stopThermostatSchedules(); db.close(); fs.rmSync(TMP, { recursive: true, force: true }); });
  beforeEach(() => {
    db.exec("DELETE FROM thermostat_schedule; DELETE FROM thermostats; DELETE FROM settings WHERE key = 'automations_paused'");
  });

  describe('when changes come due', () => {
    const points = (list: Partial<import('./schedule').SchedulePoint>[]) =>
      list.map((p, i) => ({ id: i + 1, days: EVERY_DAY, time: null, sun: null, heat: 20, cool: null, enabled: true, ...p }));

    it('finds the latest change due since the last look, on its days only', () => {
      const p = points([{ days: WEEKDAYS, time: '06:30', heat: 20 }, { days: WEEKDAYS, time: '22:30', heat: 17 }, { days: [0, 6], time: '08:00', heat: 21 }]);
      assert.equal(s.latestDue(p, at(16, 6, 0), at(16, 6, 31))?.point.id, 1, 'Monday 6:30');
      assert.equal(s.latestDue(p, at(16, 6, 31), at(16, 22, 0)), null, 'nothing between');
      // HomeHub was down from Friday night to Sunday 9 AM: Sunday 8:00 is the one in effect.
      const due = s.latestDue(p, at(20, 23, 0), at(22, 9, 0));
      assert.equal(due?.point.id, 3);
      assert.equal(due?.at.getTime(), at(22, 8, 0).getTime());
      // Saturday 7 AM: Sunday's 8:00 hasn't come, Friday 22:30 has.
      assert.equal(s.latestDue(p, at(20, 12), at(21, 7))?.point.id, 2);
    });

    it('leaves out disabled changes, and looks back a week at most', () => {
      const p = points([{ time: '06:00', heat: 20 }, { time: '07:00', heat: 21, enabled: false }]);
      assert.equal(s.latestDue(p, at(16, 5), at(16, 8))?.point.id, 1);
      assert.equal(s.latestDue(p, new Date(2020, 0, 1), at(16, 5))?.at.getTime(), at(15, 6).getTime());
    });

    it('gives the next change, tomorrow or later in the week', () => {
      const p = points([{ days: WEEKDAYS, time: '06:30' }, { days: WEEKDAYS, time: '22:30', heat: 17 }]);
      assert.equal(s.nextDue(p, at(16, 12))?.at.getTime(), at(16, 22, 30).getTime());
      assert.equal(s.nextDue(p, at(16, 23))?.at.getTime(), at(17, 6, 30).getTime());
      assert.equal(s.nextDue(p, at(20, 23))?.at.getTime(), at(23, 6, 30).getTime(), 'Friday night to Monday');
      assert.equal(s.nextDue([], at(16)), null);
    });

    it('puts sunrise and sunset changes at that day\'s sun, with the minutes before or after', () => {
      const [p] = points([{ sun: { event: 'sunset', offset: -30 } }]);
      const t = s.occursOn(p, at(16));
      assert.ok(t);
      // San Francisco by default: sunset in mid-November is about 4:55 PM, so 30 min before is about 4:25.
      const minutes = t!.getHours() * 60 + t!.getMinutes();
      assert.ok(minutes > 15 * 60 && minutes < 19 * 60, `sunset-ish, got ${t!.toString()}`);
    });
  });

  describe('saving', () => {
    it('saves and reads back a schedule, in order and with days sorted', async () => {
      const r = await save([
        { days: [5, 1, 2, 3, 4], time: '06:30', heat: 20, cool: 25 },
        { days: [0, 6], sun: { event: 'sunset', offset: 15 }, heat: 18, enabled: false },
      ]);
      assert.deepEqual(r.map(({ id: _id, ...p }) => p), [
        { days: [1, 2, 3, 4, 5], time: '06:30', sun: null, heat: 20, cool: 25, enabled: true },
        { days: [0, 6], time: null, sun: { event: 'sunset', offset: 15 }, heat: 18, cool: null, enabled: false },
      ]);
      // Saving counts as a look: nothing already past is made then.
      const c = (db.prepare('SELECT schedule_checked_at c FROM thermostats WHERE device_id = ?').get(id) as { c: string }).c;
      assert.ok(Math.abs(Date.parse(c) - Date.now()) < 5000);
      assert.deepEqual(await save([]), []);
    });

    it('refuses targets outside the allowed range, in the home\'s unit', () => {
      const v = thermostat();
      const bad = (p: Record<string, unknown>, re: RegExp) =>
        assert.throws(() => s.parseSchedule({ points: [{ days: [1], time: '06:00', ...p }] }, v), re);
      bad({ heat: 12 }, /At 6:00 AM: 54°F is below the lowest allowed for Hall, 60°F/);
      bad({ cool: 30 }, /above the highest allowed for Hall, 82°F/);
      bad({ heat: 22, cool: 23 }, /cooling must be at least 5°F above heating/);
      bad({}, /set a heating or cooling target/);
      bad({ heat: 'warm' }, /must be a number/);
    });

    it('refuses what the thermostat can\'t do, once it has said what it can', () => {
      const heatOnly = thermostat({ coolLimits: null });
      assert.throws(() => s.parseSchedule({ points: [{ days: [1], time: '06:00', cool: 24 }] }, heatOnly), /Hall doesn’t cool/);
      // Never heard from: only the allowed range applies.
      const unknown = thermostat({ heatLimits: null, coolLimits: null, online: false });
      assert.equal(s.parseSchedule({ points: [{ days: [1], time: '06:00', cool: 24 }] }, unknown).length, 1);
    });

    it('refuses bad days, times, sun offsets and two changes at once', () => {
      const v = thermostat();
      const bad = (p: Record<string, unknown>, re: RegExp) => assert.throws(() => s.parseSchedule({ points: [p] }, v), re);
      bad({ days: [], time: '06:00', heat: 20 }, /at least one day/);
      bad({ days: [7], time: '06:00', heat: 20 }, /at least one day/);
      bad({ days: [1], time: '6:00', heat: 20 }, /HH:MM/);
      bad({ days: [1], time: '24:00', heat: 20 }, /HH:MM/);
      bad({ days: [1], heat: 20 }, /give a time, or sunrise or sunset/);
      bad({ days: [1], time: '06:00', sun: { event: 'sunset' }, heat: 20 }, /give a time, or sunrise or sunset/);
      bad({ days: [1], sun: { event: 'noon' }, heat: 20 }, /sunrise or sunset/);
      bad({ days: [1], sun: { event: 'sunset', offset: 200 }, heat: 20 }, /up to 180/);
      assert.throws(() => s.parseSchedule({ points: [
        { days: EVERY_DAY, time: '22:00', heat: 17 }, { days: [1], time: '22:00', heat: 16 },
      ] }, v), /There’s already a change at 10:00 PM on Mondays/);
      assert.throws(() => s.parseSchedule({ points: 'x' }, v), /list/);
      assert.throws(() => s.parseSchedule({ points: Array(51).fill({ days: [1], time: '06:00', heat: 20 }) }, v), /at most 50/);
    });

    it('refuses an unknown thermostat', async () => {
      await assert.rejects(s.saveSchedule(9999, { points: [] }), /No thermostat/);
    });
  });

  describe('running', () => {
    const insert = (p: { days: number[]; time: string; heat?: number | null; cool?: number | null }) => {
      const mask = p.days.reduce((m, d) => m | (1 << d), 0);
      const [h, m] = p.time.split(':').map(Number);
      db.prepare('INSERT INTO thermostat_schedule (device_id, days, at_minute, heat, cool) VALUES (?, ?, ?, ?, ?)')
        .run(id, mask, h * 60 + m, p.heat ?? null, p.cool ?? null);
    };
    const ensure = () => db.prepare('INSERT OR IGNORE INTO thermostats (device_id, comfort_low, comfort_high, allowed_low, allowed_high) VALUES (?, 20, 24.4, 15.6, 27.8)').run(id);

    it('makes nothing on its first look, then the change when it comes due', async () => {
      insert({ days: EVERY_DAY, time: '22:30', heat: 17 });
      const t = stub();
      assert.equal(await s.runThermostatSchedule(id, at(16, 22, 0), t.deps), 'none');
      assert.equal(await s.runThermostatSchedule(id, at(16, 22, 29), t.deps), 'none');
      assert.equal(await s.runThermostatSchedule(id, at(16, 22, 30, ), t.deps), 'set');
      assert.deepEqual(t.sent, [{ heat: 17 }]);
      // Once only: a person's change afterwards holds until the next one.
      assert.equal(await s.runThermostatSchedule(id, at(16, 23, 0), t.deps), 'none');
      assert.equal(t.sent.length, 1);
    });

    it('catches up after HomeHub was down, with the latest change only', async () => {
      insert({ days: EVERY_DAY, time: '06:30', heat: 20 });
      insert({ days: EVERY_DAY, time: '22:30', heat: 17 });
      ensure(); checked(at(16, 21));                     // went down at 9 PM Monday
      const t = stub({ heat: 17 });
      assert.equal(await s.runThermostatSchedule(id, at(17, 7), t.deps), 'set');   // back at 7 AM Tuesday
      assert.deepEqual(t.sent, [{ heat: 20 }]);
    });

    it('sends only what the thermostat has, and nothing when it\'s already there', async () => {
      insert({ days: EVERY_DAY, time: '06:30', heat: 21, cool: 25 });
      ensure(); checked(at(16, 6));
      const heatOnly = stub({ coolLimits: null });
      await s.runThermostatSchedule(id, at(16, 7), heatOnly.deps);
      assert.deepEqual(heatOnly.sent, [{ heat: 21 }]);
      checked(at(16, 6));
      const there = stub({ heat: 21, cool: 25 });
      assert.equal(await s.runThermostatSchedule(id, at(16, 7), there.deps), 'none');
      assert.deepEqual(there.sent, []);
    });

    it('keeps inside the allowed range even if it was narrowed after saving', async () => {
      insert({ days: EVERY_DAY, time: '22:30', heat: 15.6 });
      ensure(); checked(at(16, 22));
      db.prepare('UPDATE thermostats SET allowed_low = 17 WHERE device_id = ?').run(id);
      const t = stub();
      await s.runThermostatSchedule(id, at(16, 23), t.deps);
      assert.deepEqual(t.sent, [{ heat: 17 }]);
    });

    it('tries again while the thermostat is offline, and skips changes due while paused', async () => {
      insert({ days: EVERY_DAY, time: '22:30', heat: 17 });
      ensure(); checked(at(16, 22));
      const off = stub({ online: false });
      assert.equal(await s.runThermostatSchedule(id, at(16, 22, 31), off.deps), 'offline');
      const back = stub();
      assert.equal(await s.runThermostatSchedule(id, at(16, 22, 45), back.deps), 'set', 'still due when it\'s back');

      checked(at(17, 22));
      db.prepare("INSERT INTO settings (key, value) VALUES ('automations_paused', '1')").run();
      const paused = stub();
      assert.equal(await s.runThermostatSchedule(id, at(17, 22, 31), paused.deps), 'paused');
      db.prepare("DELETE FROM settings WHERE key = 'automations_paused'").run();
      assert.equal(await s.runThermostatSchedule(id, at(17, 22, 40), paused.deps), 'none', 'not made after the pause either');
      assert.deepEqual(paused.sent, []);
    });

    it('moves on after a change the thermostat refuses', async () => {
      insert({ days: EVERY_DAY, time: '22:30', heat: 17 });
      ensure(); checked(at(16, 22));
      const { ThermostatError } = await import('./thermostat');
      const deps = { read: async () => thermostat(), change: async () => { throw new ThermostatError('nope'); } };
      assert.equal(await s.runThermostatSchedule(id, at(16, 23), deps), 'failed');
      assert.equal(await s.runThermostatSchedule(id, at(16, 23, 1), deps), 'none');
    });
  });
});
