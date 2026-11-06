/**
 * Runs motion rules against a real SQLite DB and fake devices.
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this file
 * stays on its temp DB even under a runner that hoists static imports.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type Database from 'better-sqlite3';

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-motion-test-'));
const MINUTE = 60_000;
const START = Date.parse('2026-11-01T12:00:00.000Z');

describe('motion rules', () => {
  let db: Database.Database;
  let motion: typeof import('./motion');
  let cache: Map<number, { state: boolean; wattage: null; online: boolean; lastPolled: Date }>;
  let calls: { ip: string; state: boolean }[];
  let failing: boolean;
  let lightId: number;
  let token: string;
  let server: http.Server;
  let baseUrl: string;
  let sensor: http.Server;
  let sensorRequests: { url: string; auth?: string }[];
  let sensorSaved: string[];
  let sensorForgets: boolean;
  let sensorFormat: string;
  let sensorLux: number | 'silent';

  const at = (minutes: number) => START + minutes * MINUTE;
  const iso = (minutes: number) => new Date(at(minutes)).toISOString();
  const sqlite = (minutes: number) => iso(minutes).replace('T', ' ').slice(0, 19);
  const setLight = (fields: Record<string, unknown>) => {
    for (const [column, value] of Object.entries(fields)) {
      db.prepare(`UPDATE devices SET ${column} = ? WHERE id = ?`).run(value, lightId);
    }
  };

  before(async () => {
    process.env.DB_PATH = path.join(TMP_BASE, 'db.sqlite');
    const { getDb } = await import('../db');
    motion = await import('./motion');
    const { getDriver } = await import('../drivers/registry');
    const { getAllCachedStates } = await import('../kasa/device.cache');
    const { motionEventsRouter, motionRouter } = await import('../routes/motion');
    db = getDb();
    cache = getAllCachedStates() as never;

    getDriver('kasa').setPower = async (ip: string, state: boolean) => {
      if (failing) throw new Error('unreachable');
      calls.push({ ip, state });
    };

    lightId = Number(db.prepare("INSERT INTO devices (alias, ip) VALUES ('Kitchen lights', '10.0.0.1')").run().lastInsertRowid);

    const app = express();
    app.use(express.json());
    app.use('/motion', motionEventsRouter);
    app.use('/api/motion', motionRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    sensor = http.createServer((req, res) => {
      sensorRequests.push({ url: req.url ?? '', auth: req.headers.authorization });
      res.statusCode = req.headers.authorization === `Basic ${Buffer.from('admin:right').toString('base64')}` ? 200 : 401;
      // A Gen 1 Shelly Motion's light reading, as its /status reports it.
      if (req.url === '/status') {
        if (sensorLux === 'silent') return;   // never answers
        return res.end(JSON.stringify({ lux: { value: sensorLux, illumination: 'twilight', is_valid: true } }));
      }
      // Like the real sensor, this ignores a format it doesn't accept and still answers 200.
      const url = new RegExp(`[?&]${sensorFormat}=([^&]*)`).exec(req.url ?? '')?.[1];
      if (url && !sensorForgets) sensorSaved.push(decodeURIComponent(url));
      // The real sensor's escaping isn't known, so cover the escaped form.
      res.end(JSON.stringify({ actions: sensorSaved }).replace(/\//g, '\\/'));
    });
    await new Promise<void>((resolve) => { sensor.listen(0, '127.0.0.1', () => resolve()); });
  });

  after(() => {
    server.close();
    sensor.close();
    db.close();
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  });

  beforeEach(() => {
    calls = [];
    failing = false;
    sensorRequests = [];
    sensorSaved = [];
    sensorForgets = false;
    sensorFormat = 'urls\\[0\\]\\[url\\]';
    sensorLux = 40;
    db.prepare('DELETE FROM motion_rules').run();
    setLight({ alias: 'Kitchen lights', turned_on_at: sqlite(0), override_until: null, override_state: null, timer_off_at: null, is_protected: 0 });
    cache.set(lightId, { state: true, wattage: null, online: true, lastPolled: new Date() });
    token = motion.createMotionRule('Kitchen', lightId, 10).token;
  });

  describe('turning on with motion', () => {
    const lightOff = () => cache.set(lightId, { state: false, wattage: null, online: true, lastPolled: new Date() });
    beforeEach(() => {
      lightOff();
      db.prepare('UPDATE motion_rules SET turn_on_with_motion = 1').run();
    });

    it('turns the light on when motion starts', async () => {
      assert.equal(await motion.handleMotion(token, true), true);
      assert.deepEqual(calls, [{ ip: '10.0.0.1', state: true }]);
    });

    it('turns the light on even if the cached state says it is on', async () => {
      cache.set(lightId, { state: true, wattage: null, online: true, lastPolled: new Date() });
      await motion.handleMotion(token, true);
      assert.deepEqual(calls, [{ ip: '10.0.0.1', state: true }]);
    });

    it('leaves a light on a keep-on timer alone', async () => {
      setLight({ timer_off_at: sqlite(60) });
      await motion.handleMotion(token, true);
      assert.deepEqual(calls, []);
      const row = db.prepare('SELECT timer_off_at FROM devices WHERE id = ?').get(lightId) as any;
      assert.ok(row.timer_off_at);
    });

    it('does nothing when the clear event arrives', async () => {
      await motion.handleMotion(token, false);
      assert.deepEqual(calls, []);
    });

    it('is off unless the rule asks for it', async () => {
      db.prepare('UPDATE motion_rules SET turn_on_with_motion = 0').run();
      await motion.handleMotion(token, true);
      assert.deepEqual(calls, []);
    });

    it('respects an active override', async () => {
      setLight({ override_state: 0, override_until: new Date(Date.now() + 60 * MINUTE).toISOString() });
      await motion.handleMotion(token, true);
      assert.deepEqual(calls, []);
    });

    it('never switches a protected device', async () => {
      setLight({ is_protected: 1 });
      await motion.handleMotion(token, true);
      assert.deepEqual(calls, []);
    });

    it('still records motion if the light cannot be reached', async () => {
      failing = true;
      assert.equal(await motion.handleMotion(token, true), true);
      assert.ok((db.prepare('SELECT last_motion_at FROM motion_rules').get() as any).last_motion_at);
    });

    it('reports an unknown token', async () => {
      assert.equal(await motion.handleMotion('wrong', true), false);
    });

    describe('only when it is dark', () => {
      const sensorAddress = () => `127.0.0.1:${(sensor.address() as { port: number }).port}`;
      const rule = () => db.prepare('SELECT * FROM motion_rules').get() as any;
      const useSensor = (password = 'right') => db.prepare(
        "UPDATE motion_rules SET turn_on_when = 'dark', sensor_ip = ?, sensor_username = 'admin', sensor_password = ?",
      ).run(sensorAddress(), password);

      it('turns the light on when the sensor reads dark, and keeps the reading', async () => {
        useSensor();
        sensorLux = 40;
        await motion.handleMotion(token, true);
        assert.deepEqual(calls, [{ ip: '10.0.0.1', state: true }]);
        assert.equal(rule().last_lux, 40);
        assert.equal(rule().skipped_at, null);
      });

      it('leaves the light off when the room is bright, and says why', async () => {
        useSensor();
        sensorLux = 650;
        await motion.handleMotion(token, true);
        assert.deepEqual(calls, []);
        assert.equal(rule().last_lux, 650);
        assert.match(rule().skipped_reason, /bright enough \(650 lux; turns on below 100\)/);
      });

      it('uses the rule\'s own threshold', async () => {
        useSensor();
        db.prepare('UPDATE motion_rules SET dark_below_lux = 300').run();
        sensorLux = 250;
        await motion.handleMotion(token, true);
        assert.equal(calls.length, 1);
      });

      it('turns the light on when the sensor can\'t be read', async () => {
        useSensor('wrong');   // refused
        await motion.handleMotion(token, true);
        assert.equal(calls.length, 1);
        useSensor();
        sensorLux = 'silent';   // never answers
        calls = [];
        await motion.handleMotion(token, true);
        assert.equal(calls.length, 1);
      });

      it('clears the reason once motion turns the light on again', async () => {
        useSensor();
        sensorLux = 650;
        await motion.handleMotion(token, true);
        sensorLux = 20;
        await motion.handleMotion(token, true);
        assert.equal(rule().skipped_at, null);
      });
    });

    describe('only between sunset and sunrise', () => {
      // .env.example's location (San Francisco) until the home's is set.
      beforeEach(() => db.prepare("UPDATE motion_rules SET turn_on_when = 'sun', sun_offset_minutes = 0").run());

      it('leaves the light off at midday', async () => {
        await motion.handleMotion(token, true, new Date('2026-11-06T20:00:00Z'));   // noon there
        assert.deepEqual(calls, []);
        assert.match((db.prepare('SELECT skipped_reason FROM motion_rules').get() as any).skipped_reason, /^daylight/);
      });

      it('turns the light on at night', async () => {
        await motion.handleMotion(token, true, new Date('2026-11-06T08:00:00Z'));   // midnight there
        assert.equal(calls.length, 1);
      });

      it('starts earlier with an offset', async () => {
        // Sunset there on 6 November 2026 is about 01:05 UTC (17:05 local); 00:30 UTC is before it.
        await motion.handleMotion(token, true, new Date('2026-11-07T00:30:00Z'));
        assert.deepEqual(calls, []);
        db.prepare('UPDATE motion_rules SET sun_offset_minutes = 60').run();
        await motion.handleMotion(token, true, new Date('2026-11-07T00:30:00Z'));
        assert.equal(calls.length, 1);
      });
    });

    describe('only between set hours', () => {
      const local = (h: number, m = 0) => new Date(2026, 10, 6, h, m);
      beforeEach(() => db.prepare("UPDATE motion_rules SET turn_on_when = 'hours', hours_from = '17:00', hours_to = '08:00'").run());

      it('runs past midnight', async () => {
        for (const [time, on] of [[local(12), false], [local(16, 59), false], [local(17), true], [local(23, 30), true], [local(7, 59), true], [local(8), false]] as const) {
          calls = [];
          await motion.handleMotion(token, true, time);
          assert.equal(calls.length, on ? 1 : 0, `at ${time.toTimeString().slice(0, 5)}`);
        }
      });

      it('handles a range within one day', async () => {
        db.prepare("UPDATE motion_rules SET hours_from = '06:00', hours_to = '09:00'").run();
        await motion.handleMotion(token, true, local(7));
        assert.equal(calls.length, 1);
        await motion.handleMotion(token, true, local(10));
        assert.equal(calls.length, 1);
        assert.match((db.prepare('SELECT skipped_reason FROM motion_rules').get() as any).skipped_reason, /outside 06:00–09:00/);
      });
    });
  });

  describe('motionStatus', () => {
    const status = (now: number) => motion.motionStatus(db.prepare(`
      SELECT d.*, r.* FROM motion_rules r JOIN devices d ON d.id = r.device_id
    `).get() as never, now);

    it('waits for the first report', () => {
      assert.equal(status(at(1)).kind, 'waiting');
    });

    it('counts down from the last motion', () => {
      motion.recordMotion(token, false, new Date(at(1)));
      assert.deepEqual(status(at(5)), { kind: 'counting', offAt: iso(11) });
    });

    it('has no countdown while the room is occupied', () => {
      motion.recordMotion(token, true, new Date(at(1)));
      assert.equal(status(at(5)).kind, 'occupied');
    });

    it('clears the countdown as soon as the light is switched off', () => {
      motion.recordMotion(token, false, new Date(at(1)));
      setLight({ turned_on_at: null });
      assert.equal(status(at(5)).kind, 'off');
    });

    it('clears the countdown when a poll finds the light off', () => {
      motion.recordMotion(token, false, new Date(at(1)));
      cache.set(lightId, { state: false, wattage: null, online: true, lastPolled: new Date() });
      assert.equal(status(at(5)).kind, 'off');
    });

    it('shows when the sensor is still in its cooldown', () => {
      motion.recordMotion(token, true, new Date(at(1)));
      setLight({ turned_on_at: null });
      assert.equal(status(at(1.5)).kind, 'off_cooldown');
    });

    it('treats a light with no poll yet by its turned-on time', () => {
      motion.recordMotion(token, false, new Date(at(1)));
      cache.delete(lightId);
      assert.equal(status(at(5)).kind, 'counting');
      setLight({ turned_on_at: null });
      assert.equal(status(at(5)).kind, 'off');
    });

    it('shows a held light and an offline one', () => {
      motion.recordMotion(token, false, new Date(at(1)));
      setLight({ timer_off_at: sqlite(60) });
      assert.equal(status(at(5)).kind, 'held');
      cache.set(lightId, { state: true, wattage: null, online: false, lastPolled: new Date() });
      assert.equal(status(at(5)).kind, 'offline');
    });
  });

  it('turns the light off once the room has been clear long enough', async () => {
    motion.recordMotion(token, false, new Date(at(1)));

    await motion.sweepMotionRules(at(10));
    assert.deepEqual(calls, []);

    await motion.sweepMotionRules(at(11));
    assert.deepEqual(calls, [{ ip: '10.0.0.1', state: false }]);
  });

  it('keeps the light on while the room is occupied', async () => {
    motion.recordMotion(token, true, new Date(at(1)));
    await motion.sweepMotionRules(at(60));
    assert.deepEqual(calls, []);
  });

  it('restarts the time on new motion', async () => {
    motion.recordMotion(token, false, new Date(at(1)));
    motion.recordMotion(token, true, new Date(at(9)));
    motion.recordMotion(token, false, new Date(at(10)));

    await motion.sweepMotionRules(at(15));
    assert.deepEqual(calls, []);
    await motion.sweepMotionRules(at(20));
    assert.equal(calls.length, 1);
  });

  it('does nothing until the sensor has reported', async () => {
    await motion.sweepMotionRules(at(600));
    assert.deepEqual(calls, []);
  });

  it('gives a light switched on later the full time', async () => {
    motion.recordMotion(token, false, new Date(at(1)));
    setLight({ turned_on_at: sqlite(30) });

    await motion.sweepMotionRules(at(35));
    assert.deepEqual(calls, []);
    await motion.sweepMotionRules(at(40));
    assert.equal(calls.length, 1);
  });

  it('does not stay occupied forever if the clear event is lost', async () => {
    motion.recordMotion(token, true, new Date(at(1)));
    await motion.sweepMotionRules(at(1 + 119));
    assert.deepEqual(calls, []);
    await motion.sweepMotionRules(at(1 + 120));
    assert.equal(calls.length, 1);
  });

  it('leaves a light on a keep-on timer alone', async () => {
    motion.recordMotion(token, false, new Date(at(1)));
    setLight({ timer_off_at: sqlite(60) });
    await motion.sweepMotionRules(at(30));
    assert.deepEqual(calls, []);
  });

  it('leaves a light with an active override alone', async () => {
    motion.recordMotion(token, false, new Date(at(1)));
    setLight({ override_state: 1, override_until: sqlite(60) });
    await motion.sweepMotionRules(at(30));
    assert.deepEqual(calls, []);
  });

  it('skips lights that are off or offline', async () => {
    motion.recordMotion(token, false, new Date(at(1)));

    cache.set(lightId, { state: false, wattage: null, online: true, lastPolled: new Date() });
    await motion.sweepMotionRules(at(30));
    cache.set(lightId, { state: true, wattage: null, online: false, lastPolled: new Date() });
    await motion.sweepMotionRules(at(30));
    assert.deepEqual(calls, []);
  });

  it('never switches a device that became protected', async () => {
    motion.recordMotion(token, false, new Date(at(1)));
    setLight({ is_protected: 1 });
    await motion.sweepMotionRules(at(30));
    assert.deepEqual(calls, []);
  });

  it('survives a device that cannot be reached', async () => {
    motion.recordMotion(token, false, new Date(at(1)));
    failing = true;
    await motion.sweepMotionRules(at(30));
    assert.deepEqual(calls, []);
  });

  describe('routes', () => {
    const send = (method: string, url: string, body?: unknown) => fetch(`${baseUrl}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const ruleId = () => (db.prepare('SELECT id FROM motion_rules ORDER BY id').get() as { id: number }).id;

    it('records motion from the sensor URL', async () => {
      assert.equal((await send('GET', `/motion/${token}/on`)).status, 204);
      const row = db.prepare('SELECT occupied, last_motion_at FROM motion_rules').get() as any;
      assert.equal(row.occupied, 1);
      assert.ok(row.last_motion_at);

      await send('GET', `/motion/${token}/off`);
      assert.equal((db.prepare('SELECT occupied FROM motion_rules').get() as any).occupied, 0);
    });

    it('rejects an unknown token or event', async () => {
      assert.equal((await send('GET', '/motion/wrong/on')).status, 404);
      assert.equal((await send('GET', `/motion/${token}/maybe`)).status, 404);
    });

    it('never lists the token', async () => {
      const text = await (await send('GET', '/api/motion')).text();
      assert.ok(text.includes('Kitchen lights'));
      assert.ok(!text.includes(token));
    });

    it('refuses a protected device', async () => {
      const valve = Number(db.prepare("INSERT INTO devices (alias, ip) VALUES ('Main Valve', '10.0.0.9')").run().lastInsertRowid);
      const response = await send('POST', '/api/motion', { name: 'Water', deviceId: valve, offAfterMinutes: 5 });
      assert.equal(response.status, 400);
      db.prepare('DELETE FROM devices WHERE id = ?').run(valve);
    });

    it('saves when motion may turn the light on, and checks it', async () => {
      const id = ruleId();
      const patch = async (body: unknown) => send('PATCH', `/api/motion/${id}`, body);
      const fresh = await (await send('GET', '/api/motion')).json() as any[];
      assert.equal(fresh[0].turnOnWhen, 'always');   // as before, until someone chooses

      const hours = await (await patch({ turnOnWhen: 'hours', hoursFrom: '18:30', hoursTo: '07:15' })).json() as any;
      assert.deepEqual([hours.turnOnWhen, hours.hoursFrom, hours.hoursTo], ['hours', '18:30', '07:15']);
      const sun = await (await patch({ turnOnWhen: 'sun', sunOffsetMinutes: 30 })).json() as any;
      assert.equal(sun.sunOffsetMinutes, 30);
      assert.ok(Date.parse(sun.sunToday.darkFrom) && Date.parse(sun.sunToday.darkUntil));
      assert.equal(sun.sunToday.located, false);   // the Sensors page asks for the home's location

      for (const bad of [
        { turnOnWhen: 'sometimes' }, { turnOnWhen: 'dark' },   // no sensor connected yet
        { darkBelowLux: 0 }, { darkBelowLux: 2.5 }, { sunOffsetMinutes: 181 },
        { hoursFrom: '25:00' }, { hoursTo: '7:00' }, { hoursFrom: '07:15' },   // same as the end
      ]) {
        assert.equal((await patch(bad)).status, 400, JSON.stringify(bad));
      }

      db.prepare("UPDATE motion_rules SET sensor_ip = '10.0.0.9'").run();
      const dark = await (await patch({ turnOnWhen: 'dark', darkBelowLux: 250 })).json() as any;
      assert.deepEqual([dark.turnOnWhen, dark.darkBelowLux], ['dark', 250]);
    });

    it('validates the minutes and changes them', async () => {
      assert.equal((await send('POST', '/api/motion', { name: 'x', deviceId: lightId, offAfterMinutes: 0 })).status, 400);
      const response = await send('PATCH', `/api/motion/${ruleId()}`, { offAfterMinutes: 25 });
      assert.equal((await response.json() as any).offAfterMinutes, 25);
    });

    it('changes the name and light, and keeps the sensor token', async () => {
      const other = Number(db.prepare("INSERT INTO devices (alias, ip) VALUES ('Counter', '10.0.0.5')").run().lastInsertRowid);
      const response = await send('PATCH', `/api/motion/${ruleId()}`, { name: ' Counter sensor ', deviceId: other });
      const body = await response.json() as any;

      assert.equal(body.name, 'Counter sensor');
      assert.equal(body.deviceAlias, 'Counter');
      assert.equal(body.offAfterMinutes, 10);
      assert.equal((db.prepare('SELECT token FROM motion_rules').get() as any).token, token);
      db.prepare('DELETE FROM devices WHERE id = ?').run(other);
    });

    it('refuses a blank name, a duplicate name, an unknown light or a protected one', async () => {
      const id = ruleId();
      motion.createMotionRule('Other', lightId, 5);
      const valve = Number(db.prepare("INSERT INTO devices (alias, ip) VALUES ('Main Valve', '10.0.0.9')").run().lastInsertRowid);

      assert.equal((await send('PATCH', `/api/motion/${id}`, { name: ' ' })).status, 400);
      assert.equal((await send('PATCH', `/api/motion/${id}`, { name: 'Other' })).status, 409);
      assert.equal((await send('PATCH', `/api/motion/${id}`, { deviceId: 99999 })).status, 404);
      assert.equal((await send('PATCH', `/api/motion/${id}`, { deviceId: valve })).status, 400);
      db.prepare('DELETE FROM devices WHERE id = ?').run(valve);
    });

    it('saves the login but never returns the password', async () => {
      await send('POST', `/api/motion/${ruleId()}/connect`, { sensorIp: '192.0.2.1', username: 'admin', password: 'kept-secret' });

      const row = db.prepare('SELECT sensor_ip, sensor_username, sensor_password FROM motion_rules').get() as any;
      assert.deepEqual(row, { sensor_ip: '192.0.2.1', sensor_username: 'admin', sensor_password: 'kept-secret' });

      const listed = await (await send('GET', '/api/motion')).text();
      assert.ok(!listed.includes('kept-secret'));
      assert.equal((JSON.parse(listed)[0] as any).hasSensorPassword, true);
      assert.equal((JSON.parse(listed)[0] as any).sensorIp, '192.0.2.1');
    });

    it('reports a sensor it cannot reach', async () => {
      const response = await send('POST', `/api/motion/${ruleId()}/connect`, { sensorIp: '127.0.0.1' });
      assert.ok([400, 502].includes(response.status));
    });
  });

  describe('rearmSensors', () => {
    const sensorAddress = () => `127.0.0.1:${(sensor.address() as { port: number }).port}`;
    const useSensor = (password: string) => db.prepare(
      "UPDATE motion_rules SET sensor_ip = ?, sensor_username = 'admin', sensor_password = ?",
    ).run(sensorAddress(), password);
    const detection = () => sensorRequests.map(({ url }) => url);

    it('switches detection off and on while the sensor is in its cooldown', async () => {
      useSensor('right');
      motion.recordMotion(token, true);
      await motion.rearmSensors(lightId);
      assert.deepEqual(detection(), ['/settings?motion_enable=false', '/settings?motion_enable=true']);
    });

    it('leaves a sensor alone when the room is clear', async () => {
      useSensor('right');
      motion.recordMotion(token, false);
      await motion.rearmSensors(lightId);
      assert.deepEqual(detection(), []);
    });

    it('leaves a sensor alone when it has no saved address', async () => {
      motion.recordMotion(token, true);
      await motion.rearmSensors(lightId);
      assert.deepEqual(detection(), []);
    });

    it('only resets sensors for that light', async () => {
      useSensor('right');
      motion.recordMotion(token, true);
      await motion.rearmSensors(lightId + 1000);
      assert.deepEqual(detection(), []);
    });

    it('still tries to turn detection back on after a failure', async () => {
      useSensor('wrong');
      motion.recordMotion(token, true);
      await motion.rearmSensors(lightId);
      assert.equal(detection().at(-1), '/settings?motion_enable=true');
    });
  });

  describe('connectSensor', () => {
    const sensorAddress = () => `127.0.0.1:${(sensor.address() as { port: number }).port}`;
    const rule = () => db.prepare('SELECT * FROM motion_rules').get() as never;

    it('stops at a rejected password and keeps nothing', async () => {
      await assert.rejects(motion.connectSensor(rule(), sensorAddress(), 'admin', 'wrong'), motion.SensorLoginError);
      assert.equal(sensorRequests.length, 1);
      assert.ok(!JSON.stringify(db.prepare('SELECT * FROM motion_rules').all()).includes('wrong'));
    });

    it('sets the motion and clear actions to this rule\'s URLs', async () => {
      await motion.connectSensor(rule(), sensorAddress(), 'admin', 'right');

      const names = sensorRequests.map(({ url }) => new URL(url, 'http://sensor').searchParams.get('name'));
      assert.deepEqual(names.filter(Boolean), ['motion_on', 'motion_off']);
      assert.ok(sensorSaved[0].endsWith(`/motion/${token}/on`));
      assert.ok(sensorSaved[1].endsWith(`/motion/${token}/off`));
    });

    it('falls back to the older URL format', async () => {
      sensorFormat = 'urls\\[\\]';
      await motion.connectSensor(rule(), sensorAddress(), 'admin', 'right');
      assert.equal(sensorSaved.length, 2);
    });

    it('fails if the sensor did not save the settings', async () => {
      sensorForgets = true;
      await assert.rejects(motion.connectSensor(rule(), sensorAddress(), 'admin', 'right'), /did not save motion_on/);
    });
  });
  it('finds Shelly Motion sensors, and says which rule uses each', async () => {
    const { getDriver } = await import('../drivers/registry');
    const shelly = getDriver('shelly');
    const real = shelly.discover.bind(shelly);
    shelly.discover = async () => [
      { ip: '10.0.0.50', alias: 'shellymotionsensor-60A423', model: 'SHMOS-01', hasEmeter: false, driverType: 'shelly', needsLogin: true },
      { ip: '10.0.0.51', alias: '10.0.0.51', model: 'SHMOS-02', hasEmeter: false, driverType: 'shelly' },
      { ip: '10.0.0.52', alias: 'Porch relay', model: 'SHSW-1', hasEmeter: false, driverType: 'shelly' },
      { ip: '10.0.0.53', alias: 'Bathroom H&T', model: 'SHHT-1', hasEmeter: false, driverType: 'shelly' },
    ];
    db.prepare("UPDATE motion_rules SET sensor_ip = '10.0.0.50' WHERE name = 'Kitchen'").run();
    try {
      const res = await fetch(`${baseUrl}/api/motion/discover`, { method: 'POST' });
      assert.deepEqual(await res.json(), [
        { ip: '10.0.0.50', name: 'shellymotionsensor-60A423', model: 'SHMOS-01', needsLogin: true, usedBy: 'Kitchen' },
        { ip: '10.0.0.51', name: 'Shelly Motion', model: 'SHMOS-02', needsLogin: false, usedBy: null },
      ]);
    } finally {
      shelly.discover = real;
    }
  });
});
