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

  it('lists it', async () => {
    const list = await (await fetch(base)).json() as any[];
    assert.ok(list.some((s) => s.stayOnMinutes === 180 || s.stayOnMinutes === 90));
    assert.ok(list.every((s) => 'stayOnMinutes' in s));
  });
});
