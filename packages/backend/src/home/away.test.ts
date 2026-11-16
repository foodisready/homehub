/**
 * Away mode, against a temp SQLite DB with a stubbed thermostat and stubbed plug drivers.
 * The home is in San Francisco's time zone (the default location), with °F.
 * 2026-11-16 is a Monday.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { ThermostatView } from '../thermostat/thermostat';

process.env.TZ = 'America/Los_Angeles';
process.env.TEMPERATURE_UNIT = 'F';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-away-test-'));

let db: Database.Database;
let a: typeof import('./away');
let sched: typeof import('../thermostat/schedule');
let flow: typeof import('../sensors/flow-store');
let checkin: typeof import('../family/checkin');
let reminders: typeof import('../family/reminders');
let thermostatId = 0, lampId = 0, doorId = 0;
const switched: { ip: string; state: boolean }[] = [];

const at = (d: number, h = 0, min = 0) => new Date(2026, 10, d, h, min);
const f = (x: number) => Math.round(((x - 32) * 5 / 9) * 1000) / 1000;

/** A stub thermostat: what it reads as, and the changes sent to it. */
let view: ThermostatView;
const sent: { heat?: number; cool?: number }[] = [];
const fresh = (over: Partial<ThermostatView> = {}): ThermostatView => ({
  id: thermostatId, alias: 'Hall', room: null, online: true, unit: 'F', temperature: 20, heat: f(68), cool: f(76), mode: 'heat',
  modes: ['off', 'heat', 'cool', 'auto'], running: 'idle', heatLimits: [7, 30], coolLimits: [16, 32], deadband: 2.5,
  comfort: { low: f(68), high: f(76) }, allowed: { low: f(60), high: f(82) }, ...over,
});

const near = (x: number | undefined, y: number) => x !== undefined && Math.abs(x - y) < 0.05;

describe('Away mode', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    a = await import('./away');
    sched = await import('../thermostat/schedule');
    flow = await import('../sensors/flow-store');
    checkin = await import('../family/checkin');
    reminders = await import('../family/reminders');
    const { getDriver } = await import('../drivers/registry');
    for (const kind of ['kasa', 'wyze', 'meross']) {
      getDriver(kind).setPower = async (ip: string, state: boolean) => { switched.push({ ip, state }); };
    }
    const add = db.prepare('INSERT INTO devices (alias, ip, room, driver_type, driver_config) VALUES (?, ?, ?, ?, ?)');
    thermostatId = Number(add.run('Hall', 'matter:1:1', 'Hall', 'matter', '{"kind":"thermostat","nodeId":"1","endpoint":1}').lastInsertRowid);
    lampId = Number(add.run('Living room lamp', '10.0.0.1', 'Living room', 'kasa', null).lastInsertRowid);
    doorId = Number(add.run('Garage door', '10.0.0.2', 'Garage', 'meross', null).lastInsertRowid);
    a.setAwayDeps({
      read: async () => view,
      change: async (_id, c) => { sent.push(c); view = { ...view, ...c }; },
    });
  });

  after(() => { a.stopAwayMode(); sched.stopThermostatSchedules(); db.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

  beforeEach(async () => {
    db.exec("DELETE FROM settings WHERE key LIKE 'away%' OR key = 'automations_paused'; DELETE FROM thermostat_schedule; DELETE FROM thermostats;");
    view = fresh();
    sent.length = 0;
    switched.length = 0;
  });

  describe('thermostats', () => {
    it('go to the edges of their allowed range, and back to what they were when it ends', async () => {
      const v = await a.startAway({}, 'alice', at(16, 9));
      assert.equal(v.active, true);
      assert.equal(v.by, 'alice');
      assert.equal(sent.length, 1);
      assert.ok(near(sent[0].heat, f(60)) && near(sent[0].cool, f(82)), JSON.stringify(sent[0]));
      assert.equal(v.thermostats[0].set, true);

      const back = await a.endAway('person', at(16, 18));
      assert.equal(back.active, false);
      assert.ok(near(sent[1].heat, f(68)) && near(sent[1].cool, f(76)), 'what it was before');
    });

    it('go back to what the schedule says now, rather than what they were', async () => {
      await sched.saveSchedule(thermostatId, { points: [
        { days: [0, 1, 2, 3, 4, 5, 6], time: '06:30', heat: f(70) },
        { days: [0, 1, 2, 3, 4, 5, 6], time: '22:30', heat: f(62) },
      ] }, async () => view);
      await a.startAway({}, null, at(16, 9));
      // The schedule waits while away.
      db.prepare('UPDATE thermostats SET schedule_checked_at = ? WHERE device_id = ?').run(at(16, 22).toISOString(), thermostatId);
      assert.equal(await sched.runThermostatSchedule(thermostatId, at(16, 22, 31), { read: async () => view, change: async () => assert.fail('schedule ran while away') }), 'paused');
      await a.endAway('person', at(17, 8));
      assert.ok(near(sent[sent.length - 1].heat, f(70)), 'the 6:30 AM change is the one in effect');
      // And the schedule doesn't make it again.
      assert.equal(await sched.runThermostatSchedule(thermostatId, at(17, 8, 1), { read: async () => view, change: async () => assert.fail('made twice') }), 'none');
    });

    it('uses away temperatures saved in its settings, and only what the thermostat has', async () => {
      a.saveAwaySettings({ thermostats: { [thermostatId]: { heat: f(62), cool: null } } });
      view = fresh({ coolLimits: null });
      await a.startAway({}, null, at(16, 9));
      assert.deepEqual(Object.keys(sent[0]), ['heat']);
      assert.ok(near(sent[0].heat, f(62)));
    });

    it('sets one that was offline when it comes back, and leaves everything alone while automations are paused', async () => {
      view = fresh({ online: false });
      await a.startAway({}, null, at(16, 9));
      assert.equal(sent.length, 0);
      view = fresh();
      db.prepare("INSERT INTO settings (key, value) VALUES ('automations_paused', '1')").run();
      await a.tick(at(16, 9, 1));
      assert.equal(sent.length, 0, 'paused');
      db.prepare("DELETE FROM settings WHERE key = 'automations_paused'").run();
      await a.tick(at(16, 9, 2));
      assert.equal(sent.length, 1);
      await a.tick(at(16, 9, 3));
      assert.equal(sent.length, 1, 'once');
    });
  });

  describe('the day back', () => {
    it('ends by itself the warm-up time before, and says so', async () => {
      a.saveAwaySettings({ warmUpMinutes: 90 });
      const v = await a.startAway({ until: at(20, 18).toISOString() }, null, at(16, 9));
      assert.equal(v.endsAt, at(20, 16, 30).toISOString());
      await a.tick(at(20, 16, 29));
      assert.equal(a.awayView().active, true);
      await a.tick(at(20, 16, 30));
      assert.equal(a.awayView().active, false);
      assert.ok(near(sent[sent.length - 1].heat, f(68)));
    });

    it('can be changed while away, and must be later than now and within 90 days', async () => {
      await a.startAway({ until: at(20, 18).toISOString() }, null, at(16, 9));
      const v = await a.startAway({ until: at(22, 18).toISOString() }, null, at(16, 10));
      assert.equal(v.until, at(22, 18).toISOString());
      assert.equal(sent.length, 1, 'not set again');
      await assert.rejects(a.startAway({ until: at(16, 9, 2).toISOString() }, null, at(16, 10)), /later than now/);
      await assert.rejects(a.startAway({ until: new Date(2027, 5, 1).toISOString() }, null, at(16, 10)), /up to 90 days/);
      await assert.rejects(a.startAway({ until: 'Sunday' }, null, at(16, 10)), /date and time/);
    });
  });

  describe('lived-in lights', () => {
    it('plans each lamp\'s evening the same way every time, different each day', () => {
      const p = a.lightPlan(lampId, at(16))!;
      assert.deepEqual(a.lightPlan(lampId, at(16)), p);
      assert.ok(p.on.getHours() >= 16 && p.on.getHours() <= 18, `on around sunset, got ${p.on}`);
      assert.ok(p.off >= at(16, 22) && p.off <= at(16, 23, 30), `off late evening, got ${p.off}`);
      const days = new Set([16, 17, 18, 19, 20].map((d) => a.lightPlan(lampId, at(d))!.off.getMinutes()));
      assert.ok(days.size > 1, 'not the same every day');
    });

    it('turns the lamp on in its evening and off after, and off when Away ends', async () => {
      a.saveAwaySettings({ lights: [lampId] });
      await a.startAway({}, null, at(16, 12));
      const p = a.lightPlan(lampId, at(16))!;
      await a.tick(new Date(p.on.getTime() - 60_000));
      assert.deepEqual(switched, []);
      await a.tick(new Date(p.on.getTime() + 60_000));
      assert.deepEqual(switched, [{ ip: '10.0.0.1', state: true }]);
      await a.tick(new Date(p.on.getTime() + 120_000));
      assert.equal(switched.length, 1, 'once');
      await a.endAway('person', new Date(p.on.getTime() + 180_000));
      assert.deepEqual(switched[1], { ip: '10.0.0.1', state: false });
    });

    it('refuses protected devices and thermostats as lamps', () => {
      assert.throws(() => a.saveAwaySettings({ lights: [doorId] }), /Garage door can’t be used/);
      assert.throws(() => a.saveAwaySettings({ lights: [thermostatId] }), /Hall can’t be used/);
      assert.throws(() => a.saveAwaySettings({ lights: [9999] }), /no device 9999/);
      assert.deepEqual(a.awayView().lamps.map((l) => l.alias), ['Living room lamp']);
    });
  });

  describe('settings', () => {
    it('keeps away temperatures inside the allowed range', () => {
      assert.throws(() => a.saveAwaySettings({ thermostats: { [thermostatId]: { heat: f(50) } } }), /inside the allowed 60°F–82°F/);
      assert.throws(() => a.saveAwaySettings({ thermostats: { 9999: { heat: f(62) } } }), /no thermostat 9999/);
      assert.throws(() => a.saveAwaySettings({ warmUpMinutes: 500 }), /0 to 240/);
      assert.throws(() => a.saveAwaySettings({ water: 'yes' }), /true or false/);
      const s = a.saveAwaySettings({ water: false, warmUpMinutes: 0 });
      assert.equal(s.water, false);
      assert.equal(s.cameras, true, 'others kept');
    });
  });

  describe('the rest of the house', () => {
    it('counts any water flow as a leak while away, unless turned off', async () => {
      assert.equal(flow.parseSensorConfig(null).vacationMode, false);
      await a.startAway({}, null, at(16, 9));
      assert.equal(flow.parseSensorConfig('{"warnAfterMin": 10}').vacationMode, true);
      assert.equal(flow.parseSensorConfig('{"warnAfterMin": 10}').warnAfterMin, 10);
      a.saveAwaySettings({ water: false });
      assert.equal(flow.parseSensorConfig(null).vacationMode, false);
    });

    it('holds check-ins and reminders, without catching up on them afterwards', async () => {
      db.prepare("INSERT INTO settings (key, value) VALUES ('voice_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(JSON.stringify({ enabled: true, languages: ['en'] }));
      const c = checkin.saveCheckin({ name: 'Mom', from: '05:00', by: '10:00', devices: null, motion: null, appUsers: null, voice: true, water: true, days: [0, 1, 2, 3, 4, 5, 6] });
      reminders.saveReminder({ text: 'Take your pills', at: '09:00', language: 'en' });
      await a.startAway({}, null, at(16, 8));
      assert.equal(await checkin.checkOne(checkin.listCheckins().find((x) => x.id === c.id)!, at(16, 11).getTime()), 'skipped');
      assert.equal(reminders.checkReminders(at(16, 9, 1).getTime()), 0);
      await a.endAway('person', at(16, 12));
      assert.equal(await checkin.checkOne(checkin.listCheckins().find((x) => x.id === c.id)!, at(16, 12, 5).getTime()), 'skipped', 'today was already handled');
      assert.equal(checkin.listCheckins().find((x) => x.id === c.id)!.lastResult, 'away');
      assert.equal(reminders.checkReminders(at(16, 12, 5).getTime()), 0, 'not said late');
      assert.match(JSON.stringify(reminders.listReminders()), /Away mode was on/);
    });
  });
});
