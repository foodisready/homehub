/**
 * Wyze cameras through a fake docker-wyze-bridge, against a temp DB and a
 * temp snapshots folder.
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-cameras-test-'));
const KEY = 'bridge-key';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

/** A fake bridge: /api, camera commands, snapshots, /login, and an HLS server on the same port. */
const fake = {
  signedIn: true,
  power: { front: 'on', pan: 'on' } as Record<string, string>,
  motionTs: { front: 1000, pan: 0 } as Record<string, number>,
  calls: [] as string[],
  login: null as Record<string, string> | null,
};

function cameras() {
  return {
    front: { name_uri: 'front', nickname: 'Front Door', product_model: 'WYZE_CAKP2JFUS', model_name: 'Wyze Cam v3', ip: '192.168.1.40', mac: '2C:AA:8E:00:00:01', connected: true, enabled: true, motion: false, motion_ts: fake.motionTs.front },
    pan: { name_uri: 'pan', nickname: 'Living Pan', product_model: 'HL_PAN3', ip: '192.168.0.32', mac: '80482C000002', connected: true, motion: false, motion_ts: fake.motionTs.pan || null },
  };
}

const bridgeServer = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  fake.calls.push(`${req.method} ${url.pathname}`);
  const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { fake.login = Object.fromEntries(new URLSearchParams(body)); fake.signedIn = true; res.writeHead(302, { location: '/' }); res.end(); });
    return;
  }
  if (url.pathname.startsWith('/hls/')) {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    return res.end(`#EXTM3U\n#path=${url.pathname}${url.search}\n`);
  }
  if (req.headers.api !== KEY) return json(401, { error: 'Unauthorized' });
  if (!fake.signedIn) { res.writeHead(302, { location: '/login' }); return res.end(); }
  if (url.pathname === '/api') return json(200, cameras());
  const cmd = url.pathname.match(/^\/api\/([^/]+)\/power(?:\/(on|off))?$/);
  if (cmd) {
    if (cmd[2]) fake.power[cmd[1]] = cmd[2];
    return json(200, { status: 'success', command: 'power', value: fake.power[cmd[1]] });
  }
  const snap = url.pathname.match(/^\/(snapshot|img)\/([^/]+)\.jpg$/);
  if (snap) {
    if (fake.power[snap[2]] === 'off') { res.writeHead(307, { location: '/static/notavailable.svg' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    return res.end(JPEG);
  }
  json(404, { error: 'not found' });
});

let db: Database.Database;
let bridge: typeof import('./bridge');
let snaps: typeof import('./snapshots');
let watch: typeof import('./watch');
let power: typeof import('../devices/power');
let WyzeDriver: typeof import('../drivers/WyzeDriver');
let app: http.Server;
let base = '';

const api = (method: string, url: string, body?: unknown, role = 'admin') => fetch(`${base}/api/cameras${url}`, {
  method,
  headers: { 'content-type': 'application/json', 'x-test-role': role },
  body: body === undefined ? undefined : JSON.stringify(body),
});

function addCamera(alias: string, cam: string, ip: string): number {
  return Number(db.prepare("INSERT INTO devices (alias, ip, driver_type, driver_config) VALUES (?, ?, 'wyze', ?)")
    .run(alias, ip, JSON.stringify({ cam })).lastInsertRowid);
}

describe('Wyze cameras', () => {
  before(async () => {
    await new Promise<void>((ok) => bridgeServer.listen(0, '127.0.0.1', ok));
    const port = (bridgeServer.address() as { port: number }).port;
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    process.env.WYZE_BRIDGE_URL = `http://127.0.0.1:${port}`;
    process.env.WYZE_BRIDGE_HLS_URL = `http://127.0.0.1:${port}/hls`;
    process.env.WYZE_BRIDGE_API_KEY = KEY;

    db = (await import('../db')).getDb();
    bridge = await import('./bridge');
    snaps = await import('./snapshots');
    watch = await import('./watch');
    power = await import('../devices/power');
    WyzeDriver = await import('../drivers/WyzeDriver');
    const { camerasRouter } = await import('../routes/cameras');

    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.user = { userId: 1, username: 't', role: (req.headers['x-test-role'] as string) ?? 'admin' } as never;
      next();
    });
    server.use('/api/cameras', camerasRouter);
    await new Promise<void>((ok) => { app = server.listen(0, '127.0.0.1', () => ok()); });
    base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  });

  after(async () => {
    app.closeAllConnections();
    await new Promise<void>((ok) => app.close(() => ok()));
    bridgeServer.close();
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM camera_snapshots').run();
    db.prepare('DELETE FROM devices').run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'camera_%'").run();
    db.pragma('foreign_keys = ON');
    fs.rmSync(snaps.snapshotDir(), { recursive: true, force: true });
    Object.assign(fake, { signedIn: true, power: { front: 'on', pan: 'on' }, motionTs: { front: 1000, pan: 0 }, calls: [], login: null });
    watch.resetMotionState();
    WyzeDriver.clearPowerCache();
  });

  describe('bridge client', () => {
    it('reads the camera list in either shape', () => {
      const list = bridge.parseCameraList(cameras());
      assert.deepEqual(list.map((c) => [c.id, c.name, c.ip, c.mac]), [
        ['front', 'Front Door', '192.168.1.40', '2CAA8E000001'],
        ['pan', 'Living Pan', '192.168.0.32', '80482C000002'],
      ]);
      assert.equal(bridge.parseCameraList({ total: 2, cameras: cameras() }).length, 2);
      assert.deepEqual(bridge.parseCameraList(null), []);
    });

    it('reports whether the bridge is ready, signed out or rejecting the key', async () => {
      assert.deepEqual(await bridge.getState(), { state: 'ready', cameras: 2 });
      fake.signedIn = false;
      assert.deepEqual(await bridge.getState(), { state: 'signed-out' });
      process.env.WYZE_BRIDGE_API_KEY = 'wrong';
      assert.deepEqual(await bridge.getState(), { state: 'unauthorized' });
      process.env.WYZE_BRIDGE_API_KEY = '';
      assert.deepEqual(await bridge.getState(), { state: 'not-configured' });
      process.env.WYZE_BRIDGE_API_KEY = KEY;
    });

    it('passes a Wyze sign-in to the bridge', async () => {
      fake.signedIn = false;
      await bridge.signIn({ email: 'me@example.com', password: 'pw', keyId: 'kid', apiKey: 'akey' });
      assert.deepEqual(fake.login, { email: 'me@example.com', password: 'pw', keyId: 'kid', apiKey: 'akey' });
    });
  });

  describe('driver', () => {
    it('pauses and resumes a camera, and caches its state', async () => {
      const d = new WyzeDriver.WyzeDriver();
      await d.setPower('ip', false, { cam: 'front' });
      assert.equal(fake.power.front, 'off');
      fake.calls = [];
      assert.equal(await d.getPower('ip', { cam: 'front' }), false);
      assert.deepEqual(fake.calls, [], 'answered from the cache');
      WyzeDriver.clearPowerCache();
      assert.equal(await d.getPower('ip', { cam: 'pan' }), true);
      assert.deepEqual(fake.calls, ['GET /api/pan/power']);
    });

    it('discovers the cameras on the account', async () => {
      const found = await new WyzeDriver.WyzeDriver().discover();
      assert.deepEqual(found.map((f) => [f.alias, f.ip, f.model, f.driverConfig, f.mac]), [
        ['Front Door', '192.168.1.40', 'Wyze Cam v3', { cam: 'front' }, '2CAA8E000001'],
        ['Living Pan', '192.168.0.32', 'HL_PAN3', { cam: 'pan' }, '80482C000002'],
      ]);
    });

    it('finds nothing when the bridge is signed out', async () => {
      fake.signedIn = false;
      assert.deepEqual(await new WyzeDriver.WyzeDriver().discover(), []);
    });
  });

  describe('protection', () => {
    it('lets Chat and voice resume a camera but not pause it', () => {
      const cam = { id: 1, alias: 'Front Door', is_protected: 0, driver_type: 'wyze' };
      assert.equal(power.isProtectedDevice(cam), true);
      assert.equal(power.assistantMaySwitch(cam, true), true);
      assert.equal(power.assistantMaySwitch(cam, false), false);
      assert.equal(power.assistantMaySwitch({ ...cam, is_protected: 1 }, true), false, 'a camera marked protected stays fully protected');
      assert.equal(power.assistantMaySwitch({ id: 2, alias: 'Garage', is_protected: 0, driver_type: 'meross' }, true), false);
      assert.equal(power.assistantMaySwitch({ id: 3, alias: 'Lamp', is_protected: 0, driver_type: 'kasa' }, false), true);
    });
  });

  describe('motion snapshots', () => {
    it('saves a snapshot for new motion, not for motion from before it started', async () => {
      const id = addCamera('Front Door', 'front', '192.168.1.40');
      assert.equal(await watch.checkMotion(10_000), 0, 'first reading is old news');
      fake.motionTs.front = 1100;
      assert.equal(await watch.checkMotion(20_000), 1);

      const [snap] = snaps.listSnapshots();
      assert.equal(snap.deviceId, id);
      assert.equal(snap.trigger, 'motion');
      assert.equal(snap.cameraName, 'Front Door');
      assert.deepEqual(fs.readFileSync(snaps.snapshotFile(snap.id)!), JPEG);
      assert.match(path.relative(snaps.snapshotDir(), snaps.snapshotFile(snap.id)!), /^front\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}\.jpg$/);
    });

    it('waits out the cooldown between snapshots', async () => {
      addCamera('Front Door', 'front', '192.168.1.40');
      await watch.checkMotion(0);
      fake.motionTs.front = 1100;
      assert.equal(await watch.checkMotion(100_000), 1);
      fake.motionTs.front = 1110;
      assert.equal(await watch.checkMotion(110_000), 0, 'within 30 s');
      fake.motionTs.front = 1140;
      assert.equal(await watch.checkMotion(140_000), 1);
    });

    it("catches a camera's first motion ever", async () => {
      addCamera('Living Pan', 'pan', '192.168.0.32');
      await watch.checkMotion(0);           // pan has never seen motion
      fake.motionTs.pan = 1500;
      assert.equal(await watch.checkMotion(100_000), 1);
    });

    it('ignores cameras not added to HomeHub, and respects the setting', async () => {
      addCamera('Front Door', 'front', '192.168.1.40');
      await watch.checkMotion(0);
      fake.motionTs.pan = 2000;
      fake.motionTs.front = 1100;
      snaps.saveSettings({ motionSnapshots: false });
      assert.equal(await watch.checkMotion(100_000), 0);
      assert.equal(snaps.listSnapshots().length, 0);
    });

    it('deletes snapshots older than the keep setting', async () => {
      const id = addCamera('Front Door', 'front', '192.168.1.40');
      const old = await snaps.capture({ id, alias: 'Front Door', cam: 'front' }, 'manual', new Date(Date.now() - 40 * 86_400_000));
      const recent = await snaps.capture({ id, alias: 'Front Door', cam: 'front' }, 'manual');
      const oldFile = snaps.snapshotFile(old.id)!;
      assert.equal(snaps.pruneSnapshots(), 1);
      assert.equal(fs.existsSync(oldFile), false);
      assert.equal(fs.existsSync(path.dirname(oldFile)), false, 'empty day folder removed');
      assert.deepEqual(snaps.listSnapshots().map((s) => s.id), [recent.id]);
    });

    it('validates settings', () => {
      assert.deepEqual(snaps.saveSettings({ keepDays: 7, notify: true }), { motionSnapshots: true, notify: true, keepDays: 7, cooldownSeconds: 30 });
      assert.throws(() => snaps.saveSettings({ keepDays: 0 }), /keepDays/);
      assert.throws(() => snaps.saveSettings({ notify: 'yes' as never }), /notify/);
    });
  });

  describe('routes', () => {
    it('lists added cameras with what the bridge knows', async () => {
      const id = addCamera('Front Door', 'front', '192.168.1.40');
      const body = await (await api('GET', '')).json() as any;
      assert.equal(body.bridgeError, null);
      assert.equal(body.cameras.length, 1);
      assert.equal(body.cameras[0].deviceId, id);
      assert.equal(body.cameras[0].streaming, true);
      assert.equal(body.cameras[0].model, 'Wyze Cam v3');
      assert.equal(body.cameras[0].lastMotionAt, new Date(1000 * 1000).toISOString());
    });

    it('serves a live picture, saves one, and lists and serves saved ones', async () => {
      const id = addCamera('Front Door', 'front', '192.168.1.40');
      const live = await api('GET', `/${id}/live.jpg`);
      assert.equal(live.headers.get('content-type'), 'image/jpeg');
      assert.deepEqual(Buffer.from(await live.arrayBuffer()), JPEG);

      const created = await (await api('POST', `/${id}/snapshots`, {}, 'member')).json() as any;
      assert.equal(created.trigger, 'manual');
      const list = await (await api('GET', `/snapshots?deviceId=${id}`)).json() as any[];
      assert.deepEqual(list.map((s) => s.id), [created.id]);
      const img = await api('GET', `/snapshots/${created.id}/image`);
      assert.deepEqual(Buffer.from(await img.arrayBuffer()), JPEG);
    });

    it('says when a paused camera has no picture', async () => {
      const id = addCamera('Front Door', 'front', '192.168.1.40');
      fake.power.front = 'off';
      assert.equal((await api('GET', `/${id}/live.jpg`)).status, 404);
    });

    it('lets only admins delete snapshots, sign in or change settings', async () => {
      const id = addCamera('Front Door', 'front', '192.168.1.40');
      const snap = await snaps.capture({ id, alias: 'Front Door', cam: 'front' }, 'manual');
      assert.equal((await api('DELETE', `/snapshots/${snap.id}`, undefined, 'member')).status, 403);
      assert.equal((await api('PUT', '/settings', { keepDays: 5 }, 'member')).status, 403);
      assert.equal((await api('POST', '/bridge/login', { email: 'a', password: 'b', keyId: 'c', apiKey: 'd' }, 'member')).status, 403);
      assert.equal((await api('DELETE', `/snapshots/${snap.id}`)).status, 204);
      assert.equal((await api('DELETE', `/snapshots/${snap.id}`)).status, 404);
      assert.equal((await api('GET', '/snapshots/abc/image')).status, 404);
    });

    it('relays live video from the bridge', async () => {
      const id = addCamera('Front Door', 'front', '192.168.1.40');
      const res = await api('GET', `/${id}/hls/index.m3u8?_HLS_msn=4`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/vnd.apple.mpegurl');
      assert.match(await res.text(), /#path=\/hls\/front\/index\.m3u8\?_HLS_msn=4/);
      assert.equal((await api('GET', `/${id}/hls/..%2F..%2Fapi`)).status, 400);
      assert.equal((await api('GET', '/999/hls/index.m3u8')).status, 404);
    });

    it('lists the account\'s cameras for admins, marking ones already added', async () => {
      addCamera('Front Door', 'front', '192.168.1.40');
      const list = await (await api('GET', '/bridge/cameras')).json() as any[];
      assert.deepEqual(list.map((c) => [c.cam, c.added]), [['front', true], ['pan', false]]);
      assert.equal((await api('GET', '/bridge/cameras', undefined, 'member')).status, 403);
    });

    it('requires all four sign-in fields', async () => {
      const res = await api('POST', '/bridge/login', { email: 'me@example.com', password: 'pw' });
      assert.equal(res.status, 400);
    });
  });
});
