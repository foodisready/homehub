/**
 * Schedules' "Turn off after", against a temp DB. Modules load in before(),
 * after DB_PATH is set.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-schedules-test-'));
let server: http.Server;
let base = '';
let deviceId = 0;

describe('Schedules: Turn off after', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    process.env.SCHEDULER_URL = 'http://127.0.0.1:1';   // nothing to tell
    const db = (await import('../db')).getDb();
    deviceId = Number(db.prepare('INSERT INTO devices (alias, ip) VALUES (?, ?)').run('Porch light', '10.9.2.1').lastInsertRowid);
    const { schedulesRouter } = await import('./schedules');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { userId: 1, username: 't', role: 'admin' } as never; next(); });
    app.use('/api/schedules', schedulesRouter);
    await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/schedules`;
  });

  after(async () => {
    await new Promise<void>((ok) => server.close(() => ok()));
    (await import('../db')).getDb().close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  const send = async (method: string, url: string, body: unknown) => {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  const sunset = (extra: Record<string, unknown>) => ({ deviceId, label: 'Porch at sunset', triggerType: 'solar', solarEvent: 'sunset', state: true, ...extra });

  it('keeps it on a Turn ON schedule, and changes or clears it on edit', async () => {
    const created = await send('POST', base, sunset({ stayOnMinutes: 180 }));
    assert.equal(created.status, 201);
    assert.equal(created.body.stayOnMinutes, 180);

    const longer = await send('PUT', `${base}/${created.body.id}`, sunset({ stayOnMinutes: 240 }));
    assert.equal(longer.body.stayOnMinutes, 240);
    const cleared = await send('PUT', `${base}/${created.body.id}`, sunset({}));
    assert.equal(cleared.body.stayOnMinutes, null, 'left out: it stays on');
    assert.equal((await send('PUT', `${base}/${created.body.id}`, sunset({ stayOnMinutes: null }))).body.stayOnMinutes, null);
  });

  it('works on fixed-time schedules too', async () => {
    const r = await send('POST', base, { deviceId, label: 'On at 6', triggerType: 'cron', cronExpression: '0 18 * * *', state: true, stayOnMinutes: 90 });
    assert.equal(r.body.stayOnMinutes, 90);
  });

  it('ignores it on a Turn OFF or auto-off schedule', async () => {
    assert.equal((await send('POST', base, sunset({ state: false, stayOnMinutes: 60 }))).body.stayOnMinutes, null);
    const auto = await send('POST', base, { deviceId, label: 'Auto', triggerType: 'auto_off', durationMinutes: 15, state: false, stayOnMinutes: 60 });
    assert.equal(auto.body.stayOnMinutes, null);
  });

  it('refuses anything but whole minutes from 1 to a day', async () => {
    for (const stayOnMinutes of [0, -1, 2.5, 1441, '60', true]) {
      const r = await send('POST', base, sunset({ stayOnMinutes }));
      assert.equal(r.status, 400, String(stayOnMinutes));
      assert.equal(r.body.code, 'VALIDATION_ERROR');
    }
    assert.equal((await send('POST', base, sunset({ stayOnMinutes: 1440 }))).status, 201, 'a whole day is fine');
  });

  describe('a robot vacuum’s Clean schedule', () => {
    let robotId = 0;
    const seen = '2026-11-20T10:00:00.000Z';
    const room = (pmapId: string, id: string, name: string | null) => ({ key: `${pmapId}:${id}`, pmapId, id, type: 'rid', name, seenAt: seen });
    const clean = (extra: Record<string, unknown>) => ({ deviceId: robotId, label: 'Vacuum', triggerType: 'cron', cronExpression: '0 10 * * 1,3,5', state: true, ...extra });

    before(async () => {
      const db = (await import('../db')).getDb();
      robotId = Number(db.prepare("INSERT INTO devices (alias, ip, driver_type, driver_config) VALUES ('Roomba i8', '10.9.2.55', 'roomba', ?)")
        .run(JSON.stringify({ blid: 'B', password: 'secret-pw', maps: { M: 'V1', N: 'V2' },
          rooms: [room('M', '1', 'Kitchen'), room('M', '2', 'Living Room'), room('M', '3', null), room('N', '1', 'Basement')] })).lastInsertRowid);
    });

    it('keeps its rooms, in order, and lists them by name', async () => {
      const r = await send('POST', base, clean({ rooms: ['M:2', 'M:1', 'M:2'] }));
      assert.equal(r.status, 201);
      assert.deepEqual(r.body.rooms, ['M:2', 'M:1']);
      assert.deepEqual(r.body.roomNames, ['Living Room', 'Kitchen']);
      assert.equal(r.body.problem, null);
      const listed = (await (await fetch(base)).json() as any[]).find((s) => s.id === r.body.id);
      assert.deepEqual(listed.roomNames, ['Living Room', 'Kitchen']);
      assert.ok(!JSON.stringify(listed).includes('secret-pw'), 'the robot’s login stays private');
      const edited = await send('PUT', `${base}/${r.body.id}`, clean({ rooms: [] }));
      assert.equal(edited.body.rooms, null, 'no rooms: the whole house');
    });

    it('is the whole house with no rooms', async () => {
      const r = await send('POST', base, clean({}));
      assert.equal(r.body.rooms, null);
      assert.equal(r.body.roomNames, null);
    });

    it('refuses a room that isn’t named or known, or rooms on two maps', async () => {
      for (const rooms of [['M:3'], ['M:9'], ['M:1', 'N:1'], 'M:1', [1], new Array(31).fill('M:1')]) {
        const r = await send('POST', base, clean({ rooms }));
        assert.equal(r.status, 400, JSON.stringify(rooms));
        assert.equal(r.body.code, 'INVALID_ROOMS');
      }
    });

    it('has no "Turn off after", which would send it home part way, and no rooms on Send home', async () => {
      const r = await send('POST', base, clean({ rooms: ['M:1'], stayOnMinutes: 60 }));
      assert.equal(r.body.stayOnMinutes, null);
      const home = await send('POST', base, clean({ state: false, rooms: ['M:1'] }));
      assert.equal(home.body.rooms, null);
    });

    it('ignores rooms on anything but a robot', async () => {
      const r = await send('POST', base, sunset({ rooms: ['M:1'] }));
      assert.equal(r.status, 201);
      assert.equal(r.body.rooms, null);
    });

    it('says it never cleans once none of its rooms is known', async () => {
      const r = await send('POST', base, clean({ rooms: ['M:1'] }));
      const db = (await import('../db')).getDb();
      const config = JSON.parse((db.prepare('SELECT driver_config FROM devices WHERE id = ?').get(robotId) as { driver_config: string }).driver_config);
      db.prepare('UPDATE devices SET driver_config = ? WHERE id = ?').run(JSON.stringify({ ...config, rooms: config.rooms.filter((x: { key: string }) => x.key !== 'M:1') }), robotId);
      const got = (await send('GET', `${base}/${r.body.id}`, undefined));
      assert.deepEqual(got.body.roomNames, [null]);
      assert.match(got.body.problem, /None of its rooms/);
      db.prepare('UPDATE devices SET driver_config = ? WHERE id = ?').run(JSON.stringify(config), robotId);
    });
  });

  it('lists it', async () => {
    const list = await (await fetch(base)).json() as any[];
    assert.ok(list.some((s) => s.stayOnMinutes === 180 || s.stayOnMinutes === 90));
    assert.ok(list.every((s) => 'stayOnMinutes' in s));
  });
});
