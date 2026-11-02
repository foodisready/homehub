/**
 * Activity against a temp DB and a fake Shelly relay.
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this file
 * stays on its temp DB even under a runner that hoists static imports.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import express from 'express';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-activity-test-'));

/** A Shelly Gen 1 relay: GET /relay/0 reads it, ?turn=on|off switches it. */
const relay = { on: false, up: true };
const shelly = http.createServer((req, res) => {
  if (!relay.up) { req.socket.destroy(); return; }
  const turn = new URL(req.url!, 'http://x').searchParams.get('turn');
  if (turn) relay.on = turn === 'on';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ison: relay.on }));
});

let db: Database.Database;
let act: typeof import('./activity');
let cache: typeof import('../kasa/device.cache');
let commands: typeof import('../nlp/commands');
let app: http.Server;
let base = '';
let address = '';

const events = () => db.prepare('SELECT kind, state, source, detail, via, user_name FROM device_events ORDER BY id').all() as
  { kind: string; state: number; source: string; detail: string | null; via: string | null; user_name: string | null }[];

function addLamp(alias = 'Porch', ip = address): number {
  return Number(db.prepare("INSERT INTO devices (alias, ip, driver_type, driver_config, room) VALUES (?, ?, 'shelly', ?, 'Outside')")
    .run(alias, ip, JSON.stringify({ gen: 1 })).lastInsertRowid);
}

describe('Activity', () => {
  before(async () => {
    await new Promise<void>((ok) => shelly.listen(0, '127.0.0.1', ok));
    address = `127.0.0.1:${(shelly.address() as { port: number }).port}`;
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    act = await import('./activity');
    cache = await import('../kasa/device.cache');
    commands = await import('../nlp/commands');
    const { devicesRouter } = await import('../routes/devices');
    const { activityRouter } = await import('../routes/activity');

    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.user = { sub: 7, name: (req.headers['x-test-user'] as string) ?? 'alice', role: (req.headers['x-test-role'] as string) ?? 'admin' } as never;
      next();
    });
    server.use('/api', act.activityMiddleware((req) => (req.headers['x-homehub-client'] === 'mcp' ? 'assistant' : 'app')));
    server.use('/api/devices', devicesRouter);
    server.use('/api/activity', activityRouter);
    await new Promise<void>((ok) => { app = server.listen(0, '127.0.0.1', () => ok()); });
    base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  });

  after(async () => {
    app.closeAllConnections();
    await new Promise<void>((ok) => app.close(() => ok()));
    shelly.close();
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.pragma('foreign_keys = OFF');
    for (const t of ['device_events', 'scene_actions', 'scenes', 'devices']) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare("DELETE FROM settings WHERE key = 'activity_keep_days'").run();
    db.pragma('foreign_keys = ON');
    cache.getAllCachedStates().clear();
    Object.assign(relay, { on: false, up: true });
  });

  it('records who switched a device in the app', async () => {
    const id = addLamp();
    const res = await fetch(`${base}/api/devices/${id}/on`, { method: 'POST', headers: { 'x-test-user': 'alice' } });
    assert.equal(res.status, 200);
    assert.deepEqual(events(), [{ kind: 'power', state: 1, source: 'app', detail: null, via: null, user_name: 'alice' }]);
  });

  it('records the AI assistant as the cause', async () => {
    const id = addLamp();
    await fetch(`${base}/api/devices/${id}/on`, { method: 'POST', headers: { 'x-homehub-client': 'mcp' } });
    assert.equal(events()[0].source, 'assistant');
  });

  it('records a scene run from Chat as the scene, from Chat', async () => {
    const id = addLamp();
    const scene = Number(db.prepare("INSERT INTO scenes (name) VALUES ('Evening')").run().lastInsertRowid);
    db.prepare('INSERT INTO scene_actions (scene_id, device_id, state) VALUES (?, ?, 1)').run(scene, id);
    await act.withActivity({ source: 'chat', userName: 'bob' }, () => commands.runPowerCommand('run evening'));
    assert.deepEqual(events(), [{ kind: 'power', state: 1, source: 'scene', detail: 'Evening', via: 'chat', user_name: 'bob' }]);
  });

  it("doesn't record a switch to the state a device is already in", () => {
    const id = addLamp();
    act.recordPower(id, true, { source: 'app' });
    act.recordPower(id, true, { source: 'motion' });
    act.recordPower(id, false, { source: 'timer' });
    assert.deepEqual(events().map((e) => [e.state, e.source]), [[1, 'app'], [0, 'timer']]);
  });

  it('records changes made outside HomeHub, but not its own', async () => {
    const id = addLamp();
    await cache.pollDeviceNow(id);                 // first look: off, nothing recorded yet
    assert.deepEqual(events(), []);
    relay.on = true;                               // the wall switch
    await cache.pollDeviceNow(id);
    await fetch(`${base}/api/devices/${id}/off`, { method: 'POST' });
    await cache.pollDeviceNow(id);                 // sees off, which HomeHub already recorded
    assert.deepEqual(events().map((e) => [e.state, e.source]), [[1, 'outside'], [0, 'app']]);
  });

  it('notices a change made while HomeHub was off', async () => {
    const id = addLamp();
    act.recordPower(id, false, { source: 'app' });
    relay.on = true;
    await cache.pollDeviceNow(id);                 // no cached state yet, as after a restart
    assert.deepEqual(events().map((e) => [e.state, e.source]), [[0, 'app'], [1, 'outside']]);
  });

  it('records a device going offline and coming back', async () => {
    const id = addLamp();
    await cache.pollDeviceNow(id);
    relay.up = false;
    await cache.pollDeviceNow(id);
    await cache.pollDeviceNow(id);                 // still offline: no repeat
    relay.up = true;
    await cache.pollDeviceNow(id);
    assert.deepEqual(events().filter((e) => e.kind === 'online').map((e) => e.state), [0, 1]);
  });

  it('works out how long a device was on, and lists newest first with filters', async () => {
    const id = addLamp();
    const other = addLamp('Hall', '127.0.0.1:1');
    const ins = db.prepare("INSERT INTO device_events (device_id, device_alias, kind, state, source, at) VALUES (?, ?, 'power', ?, ?, ?)");
    ins.run(id, 'Porch', 1, 'schedule', '2026-11-01T18:00:00.000Z');
    ins.run(other, 'Hall', 1, 'app', '2026-11-01T18:30:00.000Z');
    ins.run(id, 'Porch', 0, 'timer', '2026-11-01T20:15:30.000Z');

    const all = act.listActivity();
    assert.deepEqual(all.map((e) => [e.deviceName, e.state, e.onForSeconds]), [['Porch', false, 8130], ['Hall', true, null], ['Porch', true, null]]);
    assert.equal(all[0].room, 'Outside');

    const res = await (await fetch(`${base}/api/activity?deviceId=${id}&source=timer`)).json() as any[];
    assert.deepEqual(res.map((e) => e.source), ['timer']);
    assert.equal((await fetch(`${base}/api/activity?source=nope`)).status, 400);
    assert.equal(act.listActivity({ before: all[1].id }).length, 1);
  });

  it("shows each device's latest change on the device list", async () => {
    const id = addLamp();
    act.recordPower(id, true, { source: 'motion', detail: 'Kitchen sensor' });
    const list = await (await fetch(`${base}/api/devices`)).json() as any[];
    assert.equal(list[0].lastChange.source, 'motion');
    assert.equal(list[0].lastChange.detail, 'Kitchen sensor');
    assert.equal(list[0].lastChange.state, true);
  });

  it('keeps the name of a deleted device', () => {
    const id = addLamp();
    act.recordPower(id, true, { source: 'app' });
    db.prepare('DELETE FROM devices WHERE id = ?').run(id);
    const [e] = act.listActivity();
    assert.equal(e.deviceId, null);
    assert.equal(e.deviceName, 'Porch');
  });

  it('deletes activity older than the keep setting', () => {
    const id = addLamp();
    const ins = db.prepare("INSERT INTO device_events (device_id, device_alias, kind, state, source, at) VALUES (?, 'Porch', 'power', ?, 'app', ?)");
    ins.run(id, 1, new Date(Date.now() - 100 * 86_400_000).toISOString());
    ins.run(id, 0, new Date(Date.now() - 10 * 86_400_000).toISOString());
    assert.equal(act.pruneActivity(), 1);
    act.setKeepDays(7);
    assert.equal(act.pruneActivity(), 1);
    assert.throws(() => act.setKeepDays(3), /from 7 to 730/);
  });

  it('lets only admins change how long activity is kept', async () => {
    const put = (role: string) => fetch(`${base}/api/activity/settings`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-test-role': role }, body: JSON.stringify({ keepDays: 30 }),
    });
    assert.equal((await put('member')).status, 403);
    assert.equal((await put('admin')).status, 200);
    assert.equal(((await (await fetch(`${base}/api/activity/settings`)).json()) as any).keepDays, 30);
  });
});
