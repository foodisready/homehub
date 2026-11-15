/**
 * Daily check-ins, against a temp SQLite DB, in New York time so the clock change is real:
 * what counts as a sign someone is there, when the family is told, and when they aren't.
 */
process.env.TZ = 'America/New_York';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-checkin-test-'));

let db: Database.Database;
let c: typeof import('./checkin');
const told: { title: string; body: string }[] = [];

const at = (d: number, h: number, min = 0, m = 10) => new Date(2026, m, d, h, min).getTime();   // November 2026
const iso = (t: number) => new Date(t).toISOString();
const sql = (t: number) => iso(t).slice(0, 19).replace('T', ' ');
const event = (deviceId: number, source: string, t: number, extra: { via?: string; user?: string; detail?: string; state?: 0 | 1 } = {}) =>
  db.prepare("INSERT INTO device_events (device_id, device_alias, kind, state, source, detail, via, user_name, at) VALUES (?, ?, 'power', ?, ?, ?, ?, ?, ?)")
    .run(deviceId, deviceId === 1 ? 'Kitchen light' : 'Bedside lamp', extra.state ?? 1, source, extra.detail ?? null, extra.via ?? null, extra.user ?? null, iso(t));
const running = (from: number, to: number) => db.prepare('INSERT INTO homehub_uptime (started_at, last_seen) VALUES (?, ?)').run(iso(from), iso(to));
const base = { from: '05:00', by: '10:00', devices: null, motion: null, appUsers: null, voice: true, water: true };

describe('daily check-in', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    c = await import('./checkin');
    c.setTellForTests(async (title, body) => { told.push({ title, body }); });
    db.prepare("INSERT INTO devices (id, alias, ip, driver_type) VALUES (1, 'Kitchen light', '192.0.2.1', 'kasa'), (2, 'Bedside lamp', '192.0.2.2', 'kasa')").run();
    db.prepare("INSERT INTO motion_rules (id, name, token, device_id, off_after_minutes, ring_camera_id) VALUES (1, 'Hallway', 't1', 1, 5, NULL), (2, 'Front door', 't2', 1, 5, 7)").run();
    db.prepare("INSERT INTO sensors (id, sensor_id, type, alias) VALUES (1, 'flow-1', 'flow', 'Water')").run();
  });
  after(() => { db.close(); fs.rmSync(TMP, { recursive: true, force: true }); });
  beforeEach(() => {
    db.exec('DELETE FROM device_events; DELETE FROM voice_commands; DELETE FROM flow_events; DELETE FROM motion_seen; DELETE FROM homehub_uptime; DELETE FROM checkins;');
    told.length = 0;
  });

  describe('signs someone is there', () => {
    const signs = (s = {}) => c.signsBetween({ ...base, ...s }, at(16, 5), at(16, 10)).map((x) => x.what);

    it('counts a wall switch, a voice or chat command, but not schedules, timers or HomeHub', () => {
      event(1, 'schedule', at(16, 6));
      event(1, 'timer', at(16, 6, 5));
      event(1, 'homehub', at(16, 6, 10));
      assert.deepEqual(signs(), []);
      event(2, 'outside', at(16, 7));
      event(1, 'voice', at(16, 7, 30), { state: 0 });
      assert.deepEqual(signs(), ['Bedside lamp turned on at the switch', 'Kitchen light turned off by voice']);
    });

    it('counts a scene a person started, not one a schedule ran', () => {
      event(1, 'scene', at(16, 6), { via: 'schedule', detail: 'Morning' });
      event(2, 'scene', at(16, 7), { via: 'voice', detail: 'Good morning' });
      assert.deepEqual(signs(), ['Bedside lamp turned on by the scene Good morning']);
    });

    it('counts app use only by the people chosen', () => {
      event(1, 'app', at(16, 6), { user: 'daughter' });
      event(2, 'app', at(16, 7), { user: 'mom' });
      assert.equal(signs().length, 2);
      assert.deepEqual(signs({ appUsers: ['mom'] }), ['Bedside lamp turned on in the app by mom']);
      // A scene run from the app is someone in the app too.
      event(1, 'scene', at(16, 8), { via: 'app', user: 'daughter', detail: 'Lights' });
      assert.deepEqual(signs({ appUsers: ['mom'] }), ['Bedside lamp turned on in the app by mom']);
    });

    it('counts only the devices chosen', () => {
      event(1, 'outside', at(16, 6));
      event(2, 'outside', at(16, 7));
      assert.deepEqual(signs({ devices: [2] }), ['Bedside lamp turned on at the switch']);
    });

    it('counts a voice command understood, not a miss: a TV wakes the speaker too', () => {
      db.prepare('INSERT INTO voice_commands (text, understood, created_at) VALUES (?, 0, ?), (?, 1, ?)')
        .run('I heard words', sql(at(16, 6)), '開廚房燈', sql(at(16, 8)));
      assert.deepEqual(signs(), ['a voice command: “開廚房燈”']);
      assert.deepEqual(signs({ voice: false }), []);
    });

    it('counts water starting to run', () => {
      db.prepare("INSERT INTO flow_events (sensor_id, start_time, status) VALUES (1, ?, 'closed')").run(sql(at(16, 6, 40)));
      db.prepare("INSERT INTO flow_events (sensor_id, start_time, status) VALUES (1, ?, 'closed')").run(sql(at(16, 4, 0)));   // before the window
      assert.deepEqual(signs(), ['water used']);
      assert.deepEqual(signs({ water: false }), []);
    });

    it('counts motion, but not from a Ring camera unless chosen', () => {
      db.prepare('INSERT INTO motion_seen (rule_id, at) VALUES (2, ?), (1, ?)').run(iso(at(16, 6)), iso(at(16, 9)));
      assert.deepEqual(signs(), ['motion: Hallway']);
      assert.deepEqual(signs({ motion: [2] }), ['motion: Front door']);
      // A light that motion turned on is motion too.
      event(1, 'motion', at(16, 7), { detail: 'Hallway' });
      event(1, 'motion', at(16, 7, 30), { detail: 'Front door' });
      assert.deepEqual(signs(), ['Kitchen light turned on by motion', 'motion: Hallway']);
    });

    it('lists signs earliest first, whatever kind', () => {
      db.prepare("INSERT INTO flow_events (sensor_id, start_time, status) VALUES (1, ?, 'closed')").run(sql(at(16, 9)));
      event(2, 'outside', at(16, 6));
      assert.deepEqual(signs(), ['Bedside lamp turned on at the switch', 'water used']);
    });
  });

  describe('checking', () => {
    const make = (s: Record<string, unknown> = {}) => {
      const made = c.saveCheckin({ name: 'Mom', ...base, ...s });
      // Saved "now" (after 10:00 in real time, maybe): start fresh for the day being tested.
      db.prepare('UPDATE checkins SET last_day = NULL, last_result = NULL WHERE id = ?').run(made.id);
      return c.getCheckin(made.id)!;
    };

    it('waits until the check time, then is happy with any sign', async () => {
      const ci = make();
      running(at(16, 0), at(16, 12));
      event(2, 'outside', at(16, 7, 12));
      assert.equal(await c.checkOne(ci, at(16, 9, 59)), 'waiting');
      assert.equal(await c.checkOne(ci, at(16, 10)), 'ok');
      const saved = c.getCheckin(ci.id)!;
      assert.equal(saved.lastResult, 'ok');
      assert.equal(saved.lastSign, 'Bedside lamp turned on at the switch');
      assert.equal(await c.checkOne(saved, at(16, 10, 1)), 'skipped');
      assert.equal(told.length, 0);
    });

    it('tells the family when nothing happened, then again at the first sign', async () => {
      const ci = make();
      running(at(16, 0), at(16, 23));
      assert.equal(await c.checkOne(ci, at(16, 10, 0)), 'alerted');
      assert.equal(told.length, 1);
      assert.equal(told[0].title, 'No sign of Mom this morning');
      assert.match(told[0].body, /since 5:00\sAM: no lights or plugs switched, no voice commands, no water used, no motion\./);
      assert.doesNotMatch(told[0].body, /HomeHub was off/);
      let saved = c.getCheckin(ci.id)!;
      assert.equal(await c.checkOne(saved, at(16, 10, 30)), 'waiting');
      event(1, 'outside', at(16, 10, 42));
      assert.equal(await c.checkOne(saved, at(16, 10, 43)), 'all-clear');
      assert.equal(told.length, 2);
      assert.match(told[1].body, /^Activity at home at 10:42\sAM: Kitchen light turned on at the switch\.$/);
      saved = c.getCheckin(ci.id)!;
      assert.equal(await c.checkOne(saved, at(16, 11)), 'skipped');
      assert.equal(told.length, 2);
    });

    it('says when HomeHub was off for part of the morning', async () => {
      const ci = make();
      // Before HomeHub first kept track, it counts as running: so it kept track the day before.
      running(at(15, 0), at(15, 23));
      running(at(16, 8), at(16, 12));
      assert.equal(await c.checkOne(ci, at(16, 10)), 'alerted');
      assert.match(told[0].body, /HomeHub was off for part of that time/);
    });

    it('checks late after HomeHub was off at the time, counting signs up to now', async () => {
      const ci = make();
      running(at(16, 0), at(16, 8));
      running(at(16, 11), at(16, 12));
      event(1, 'outside', at(16, 10, 30));
      assert.equal(await c.checkOne(ci, at(16, 11, 5)), 'ok');
      assert.equal(told.length, 0);
    });

    it("doesn't alert hours late: it notes the check was missed", async () => {
      const ci = make();
      assert.equal(await c.checkOne(ci, at(16, 13, 30)), 'missed');
      assert.equal(told.length, 0);
    });

    it('skips days not chosen, paused days and a turned-off check-in', async () => {
      // 2026-11-15 is a Sunday.
      const weekdays = make({ days: [1, 2, 3, 4, 5] });
      assert.equal(await c.checkOne(weekdays, at(15, 10)), 'skipped');
      const paused = make({ pausedUntil: '2026-11-20' });
      assert.equal(await c.checkOne(paused, at(16, 10)), 'skipped');
      assert.equal(await c.checkOne(paused, at(21, 10)), 'alerted');
      const off = make({ enabled: false });
      assert.equal(await c.checkOne(off, at(16, 10)), 'skipped');
    });

    it('checks the right hours on the days the clocks change', async () => {
      // 2027-03-14: clocks go forward at 2:00. 2026-11-01: back at 2:00.
      assert.equal(new Date(c.localTime('2027-03-14', '10:00')).getHours(), 10);
      assert.equal(c.localTime('2027-03-14', '10:00') - c.localTime('2027-03-14', '01:00'), 8 * 3600_000);
      assert.equal(c.localTime('2026-11-01', '10:00') - c.localTime('2026-11-01', '01:00'), 10 * 3600_000);
      const ci = make({ from: '01:00' });
      const spring = (h: number) => new Date(2027, 2, 14, h).getTime();
      running(spring(0), spring(12));
      event(1, 'outside', spring(4));
      assert.equal(await c.checkOne(ci, spring(10)), 'ok');
    });

    it('starts tomorrow when made after the check time, and rechecks today when the time moves', () => {
      const late = c.saveCheckin({ name: 'Dad', ...base, by: '00:01', from: '00:00' });
      assert.equal(late.lastDay, c.dayKey(new Date()));
      const edited = c.saveCheckin({ by: '23:59' }, late.id);
      assert.equal(edited.lastDay, null);
    });

    it('rejects a check time before it starts looking, and bad times', () => {
      assert.throws(() => c.saveCheckin({ name: 'Mom', from: '11:00', by: '10:00' }), /after the time it starts/);
      assert.throws(() => c.saveCheckin({ name: 'Mom', by: '25:00' }), /HH:MM/);
      assert.throws(() => c.saveCheckin({ name: '' }), /name is required/);
      assert.throws(() => c.saveCheckin({ name: 'Mom', devices: ['x'] }), /list of ids/);
    });
  });

  describe('the last two weeks', () => {
    it('shows the first sign each day, which days would alert, and mornings HomeHub was off', () => {
      const now = new Date(2026, 10, 15, 12);
      // Nov 1 to 14. HomeHub ran every day but Nov 3.
      for (let d = 1; d <= 14; d++) if (d !== 3) running(at(d, 0), at(d, 23, 59));
      for (let d = 1; d <= 14; d++) if (d !== 7 && d !== 3) event(2, 'outside', at(d, 6 + (d % 3)));
      event(2, 'outside', at(7, 10, 37));   // after the check time
      const days = c.preview(base, [0, 1, 2, 3, 4, 5, 6], 14, now);
      assert.equal(days.length, 14);
      assert.equal(days[0].day, '2026-11-01');
      assert.equal(days[13].day, '2026-11-14');
      assert.deepEqual(days.filter((d) => d.alert).map((d) => d.day), ['2026-11-07']);
      assert.deepEqual(days.filter((d) => d.homehubOff).map((d) => d.day), ['2026-11-03']);
      assert.equal(days[1].first?.what, 'Bedside lamp turned on at the switch');
      // A later check time wouldn't have alerted.
      assert.deepEqual(c.preview({ ...base, by: '11:00' }, undefined, 14, now).filter((d) => d.alert), []);
    });
  });
});
