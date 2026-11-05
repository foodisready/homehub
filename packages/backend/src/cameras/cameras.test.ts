/**
 * Wyze cameras through a fake camera bridge (IDisposable's docker-wyze-bridge
 * API, with its go2rtc on the same port), against a temp DB, a temp
 * snapshots folder and a temp sign-in folder.
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
const SIGNIN = path.join(TMP, 'wyze');
const KEY = 'bridge-key';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const RIGHT = { email: 'me@example.com', password: 'right', keyId: 'kid', apiKey: 'akey' };

/**
 * A fake bridge. Like the real one, it reads the sign-in only when it starts,
 * and starts again when the sign-in's version changes.
 */
const fake = {
  up: true,
  /** Doesn't notice a new sign-in, like the bridge in the seconds before it restarts. */
  frozen: false,
  version: '',
  startedAt: Date.now(),
  signedIn: false,
  /** Empty pictures to answer before a real one, as while a camera connects. */
  emptyShots: 0,
  calls: [] as string[],
};

function restartIfNeeded(): void {
  if (fake.frozen) return;
  let v = '';
  try { v = fs.readFileSync(path.join(SIGNIN, 'version'), 'utf8'); } catch { /* signed out */ }
  if (v === fake.version) return;
  fake.version = v;
  fake.startedAt = Date.now();
  fake.signedIn = !!v && fs.readFileSync(path.join(SIGNIN, 'password'), 'utf8') === 'right';
}

function cameras() {
  return [
    { name: 'front_door', nickname: 'Front Door', model: 'WYZE_CAKP2JFUS', model_name: 'V3', ip: '192.168.1.40', mac: '2CAA8E000001', state: 'streaming' },
    { name: 'living_pan', nickname: 'Living Pan', model: 'HL_PAN3', model_name: 'Pan V3', ip: '192.168.0.32', mac: '80482C000002', state: 'connecting' },
  ];
}

const bridgeServer = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  fake.calls.push(`${req.method} ${url.pathname}${url.search}`);
  const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (!fake.up) { res.destroy(); return; }
  // go2rtc, which HomeHub reaches directly on 127.0.0.1
  if (url.pathname === '/api/stream.m3u8' || url.pathname.startsWith('/api/hls/')) {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    return res.end(`#EXTM3U\n#path=${url.pathname}${url.search}\n`);
  }
  restartIfNeeded();
  if (url.pathname === '/api/health') {
    const issues = fake.version && !fake.signedIn
      ? [{ ID: 'wyzeapi/auth', Message: 'Wyze API authentication failed', Detail: 'login: wyze api error: code=1000 msg=Invalid credentials' }]
      : undefined;
    return json(200, { status: issues ? 'degraded' : 'ok', uptime: Math.floor((Date.now() - fake.startedAt) / 1000), ...(issues ? { issues } : {}) });
  }
  if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); return res.end('Unauthorized'); }
  if (url.pathname === '/api/cameras') return json(200, fake.signedIn ? cameras() : []);
  const snap = url.pathname.match(/^\/api\/snapshot\/([^/]+)$/);
  if (snap) {
    if (fake.emptyShots > 0) { fake.emptyShots--; res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(); }
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

function addCamera(alias: string, cam: string, ip: string, mac: string | null = null): number {
  return Number(db.prepare("INSERT INTO devices (alias, ip, driver_type, driver_config, mac) VALUES (?, ?, 'wyze', ?, ?)")
    .run(alias, ip, JSON.stringify({ cam }), mac).lastInsertRowid);
}

/** Signed in, with the fake bridge already restarted on it. */
function signedIn(): void {
  bridge.saveSignIn(RIGHT, Date.now() - 60_000);
  restartIfNeeded();
  fake.startedAt = Date.now() - 30_000;
}

describe('Wyze cameras', () => {
  before(async () => {
    await new Promise<void>((ok) => bridgeServer.listen(0, '127.0.0.1', ok));
    const port = (bridgeServer.address() as { port: number }).port;
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    process.env.WYZE_BRIDGE_URL = `http://127.0.0.1:${port}`;
    process.env.WYZE_GO2RTC_URL = `http://127.0.0.1:${port}`;
    process.env.WYZE_BRIDGE_API_KEY = KEY;
    process.env.WYZE_SIGNIN_DIR = SIGNIN;

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
    bridgeServer.closeAllConnections();
    bridgeServer.close();
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM camera_snapshots').run();
    db.prepare('DELETE FROM devices').run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'camera%'").run();
    db.pragma('foreign_keys = ON');
    fs.rmSync(snaps.snapshotDir(), { recursive: true, force: true });
    fs.rmSync(SIGNIN, { recursive: true, force: true });
    Object.assign(fake, { up: true, frozen: false, version: '', signedIn: false, emptyShots: 0, calls: [] });
    process.env.WYZE_BRIDGE_API_KEY = KEY;
    watch.resetMotionState();
    WyzeDriver.clearPowerCache();
    signedIn();
  });

  describe('bridge client', () => {
    it('reads the camera list', () => {
      const list = bridge.parseCameraList(cameras());
      assert.deepEqual(list.map((c) => [c.id, c.name, c.modelName, c.ip, c.mac, c.connected]), [
        ['front_door', 'Front Door', 'V3', '192.168.1.40', '2CAA8E000001', true],
        ['living_pan', 'Living Pan', 'Pan V3', '192.168.0.32', '80482C000002', false],
      ]);
      assert.deepEqual(bridge.parseCameraList(null), []);
      assert.deepEqual(bridge.parseCameraList({ cameras: [] }), []);
    });

    it('reports whether the bridge is ready, signed out or rejecting the key', async () => {
      assert.deepEqual(await bridge.getState(), { state: 'ready', cameras: 2 });
      process.env.WYZE_BRIDGE_API_KEY = 'wrong';
      assert.deepEqual(await bridge.getState(), { state: 'unauthorized' });
      process.env.WYZE_BRIDGE_API_KEY = '';
      assert.deepEqual(await bridge.getState(), { state: 'not-configured' });
      process.env.WYZE_BRIDGE_API_KEY = KEY;
      bridge.clearSignIn();
      assert.deepEqual(await bridge.getState(), { state: 'signed-out' });
    });

    it('waits for the bridge to restart after a sign-in, rather than trusting the old one', async () => {
      fake.frozen = true;   // the bridge from before hasn't noticed the new sign-in yet
      const at = Date.now();
      bridge.saveSignIn(RIGHT, at);
      assert.deepEqual(await bridge.getState(at + 1000), { state: 'starting' });
      fake.up = false;
      assert.deepEqual(await bridge.getState(at + 5000), { state: 'starting' }, 'down while restarting');
      assert.equal((await bridge.getState(at + 10 * 60_000)).state, 'unreachable', 'down for long');
      Object.assign(fake, { up: true, frozen: false });
      assert.equal((await bridge.getState()).state, 'ready');
    });

    it('saves a sign-in for the bridge alone, and waits for it to work', async () => {
      bridge.clearSignIn();
      const state = await bridge.signIn(RIGHT, { pollMs: 10 });
      assert.deepEqual(state, { state: 'ready', cameras: 2 });
      assert.equal(fs.statSync(SIGNIN).mode & 0o777, 0o700);
      for (const [file, value] of [['email', 'me@example.com'], ['password', 'right'], ['key-id', 'kid'], ['api-key', 'akey']]) {
        assert.equal(fs.readFileSync(path.join(SIGNIN, file), 'utf8'), value);
        assert.equal(fs.statSync(path.join(SIGNIN, file)).mode & 0o777, 0o600, file);
      }
    });

    it('says when Wyze turns the sign-in down', async () => {
      await assert.rejects(bridge.signIn({ ...RIGHT, password: 'wrong' }, { pollMs: 10 }), (err: Error & { status?: number }) => {
        assert.equal(err.status, 422);
        assert.match(err.message, /didn't accept the email, password/);
        return true;
      });
      assert.equal((await bridge.getState()).state, 'sign-in-failed');
    });

    it('signs out, which stops the bridge', async () => {
      bridge.clearSignIn();
      assert.equal(bridge.signInSavedAt(), null);
      assert.deepEqual(fs.readdirSync(SIGNIN), []);
      assert.deepEqual(await bridge.getState(), { state: 'signed-out' });
    });

    it('tries a picture again when the first comes back empty', async () => {
      fake.emptyShots = 1;
      assert.deepEqual(await bridge.snapshot('front_door'), JPEG);
      fake.emptyShots = 1;
      await assert.rejects(bridge.snapshot('front_door', 1), /No picture/);
    });
  });

  describe('driver', () => {
    it('reads a camera on the bridge as watching, and one it lacks as offline', async () => {
      const d = new WyzeDriver.WyzeDriver();
      assert.equal(await d.getPower('ip', { cam: 'front_door' }), true);
      await assert.rejects(d.getPower('ip', { cam: 'gone' }));
      const calls = fake.calls.filter((c) => c.startsWith('GET /api/cameras')).length;
      await d.getPower('ip', { cam: 'living_pan' });
      assert.equal(fake.calls.filter((c) => c.startsWith('GET /api/cameras')).length, calls, 'the list is cached');
    });

    it("explains that pausing isn't available", async () => {
      await assert.rejects(new WyzeDriver.WyzeDriver().setPower('ip', false, { cam: 'front_door' }), (err: Error & { status?: number }) => {
        assert.equal(err.status, 501);
        assert.match(err.message, /isn't available/);
        return true;
      });
    });

    it('discovers the cameras on the account', async () => {
      const found = await new WyzeDriver.WyzeDriver().discover();
      assert.deepEqual(found.map((f) => [f.alias, f.ip, f.model, f.driverConfig, f.mac]), [
        ['Front Door', '192.168.1.40', 'V3', { cam: 'front_door' }, '2CAA8E000001'],
        ['Living Pan', '192.168.0.32', 'Pan V3', { cam: 'living_pan' }, '80482C000002'],
      ]);
    });

    it('finds nothing when signed out', async () => {
      bridge.clearSignIn();
      assert.deepEqual(await new WyzeDriver.WyzeDriver().discover(), []);
    });
  });

  describe('relinking', () => {
    it('follows a camera to its new bridge name by its hardware address', async () => {
      const id = addCamera('Front Door', 'front-door', '192.168.1.40', '2CAA8E000001');
      const other = addCamera('Old', 'old-cam', '192.168.1.99', 'AABBCCDDEEFF');
      await watch.liveCameras();
      const cam = (deviceId: number) => JSON.parse((db.prepare('SELECT driver_config FROM devices WHERE id = ?').get(deviceId) as { driver_config: string }).driver_config).cam;
      assert.equal(cam(id), 'front_door');
      assert.equal(cam(other), 'old-cam', 'no match: left alone');
      assert.equal(watch.relinkCameras(bridge.parseCameraList(cameras())), 0, 'nothing more to do');
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

  describe('snapshots', () => {
    it('deletes snapshots older than the keep setting', async () => {
      const id = addCamera('Front Door', 'front_door', '192.168.1.40');
      const old = await snaps.capture({ id, alias: 'Front Door', cam: 'front_door' }, 'manual', new Date(Date.now() - 40 * 86_400_000));
      const recent = await snaps.capture({ id, alias: 'Front Door', cam: 'front_door' }, 'manual');
      const oldFile = snaps.snapshotFile(old.id)!;
      assert.match(path.relative(snaps.snapshotDir(), oldFile), /^front_door\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}\.jpg$/);
      assert.equal(snaps.pruneSnapshots(), 1);
      assert.equal(fs.existsSync(oldFile), false);
      assert.equal(fs.existsSync(path.dirname(oldFile)), false, 'empty day folder removed');
      assert.deepEqual(snaps.listSnapshots().map((s) => s.id), [recent.id]);
    });

    it('takes no motion snapshots, since this bridge reports no motion', async () => {
      addCamera('Front Door', 'front_door', '192.168.1.40');
      assert.equal(await watch.checkMotion(0), 0);
      assert.equal(await watch.checkMotion(100_000), 0);
    });

    it('validates settings', () => {
      assert.deepEqual(snaps.saveSettings({ keepDays: 7, notify: true }), { enabled: true, motionSnapshots: true, notify: true, keepDays: 7, cooldownSeconds: 30 });
      assert.throws(() => snaps.saveSettings({ enabled: 1 as never }), /enabled/);
      assert.throws(() => snaps.saveSettings({ keepDays: 0 }), /keepDays/);
      assert.throws(() => snaps.saveSettings({ notify: 'yes' as never }), /notify/);
    });
  });

  describe('turning cameras off in Settings', () => {
    it('reports the bridge as off until turned back on', async () => {
      assert.equal((await (await api('PUT', '/settings', { enabled: false })).json() as any).enabled, false);
      assert.deepEqual(await (await api('GET', '/bridge')).json(), { state: 'off' });
      const settings = await (await api('GET', '/settings', undefined, 'member')).json() as any;
      assert.deepEqual([settings.enabled, settings.bridgeInstalled], [false, true], 'members see it too, for the menu');

      await api('PUT', '/settings', { enabled: true });
      assert.equal(((await (await api('GET', '/bridge')).json()) as any).state, 'ready');
    });
  });

  describe('routes', () => {
    it('lists added cameras with what the bridge knows', async () => {
      const id = addCamera('Front Door', 'front_door', '192.168.1.40');
      const body = await (await api('GET', '')).json() as any;
      assert.equal(body.bridgeError, null);
      assert.equal(body.cameras.length, 1);
      assert.equal(body.cameras[0].deviceId, id);
      assert.equal(body.cameras[0].streaming, true);
      assert.equal(body.cameras[0].model, 'V3');
      assert.equal(body.cameras[0].lastMotionAt, null);
    });

    it('serves a live picture, saves one, and lists and serves saved ones', async () => {
      const id = addCamera('Front Door', 'front_door', '192.168.1.40');
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

    it('says when a camera has no picture right now', async () => {
      const id = addCamera('Front Door', 'front_door', '192.168.1.40');
      fake.emptyShots = 1;
      assert.equal((await api('GET', `/${id}/live.jpg?cached=1`)).status, 404, 'thumbnails try once');
    });

    it('lets only admins delete snapshots, sign in or out, or change settings', async () => {
      const id = addCamera('Front Door', 'front_door', '192.168.1.40');
      const snap = await snaps.capture({ id, alias: 'Front Door', cam: 'front_door' }, 'manual');
      assert.equal((await api('DELETE', `/snapshots/${snap.id}`, undefined, 'member')).status, 403);
      assert.equal((await api('PUT', '/settings', { keepDays: 5 }, 'member')).status, 403);
      assert.equal((await api('POST', '/bridge/login', RIGHT, 'member')).status, 403);
      assert.equal((await api('DELETE', '/bridge/login', undefined, 'member')).status, 403);
      assert.ok(bridge.signInSavedAt(), 'still signed in');
      assert.equal((await api('DELETE', `/snapshots/${snap.id}`)).status, 204);
      assert.equal((await api('DELETE', `/snapshots/${snap.id}`)).status, 404);
      assert.equal((await api('GET', '/snapshots/abc/image')).status, 404);
    });

    it('relays live video from go2rtc', async () => {
      const id = addCamera('Front Door', 'front_door', '192.168.1.40');
      const res = await api('GET', `/${id}/hls/index.m3u8`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/vnd.apple.mpegurl');
      assert.match(await res.text(), /#path=\/api\/stream\.m3u8\?src=front_door/);
      assert.match(await (await api('GET', `/${id}/hls/hls/playlist.m3u8?id=abc`)).text(), /#path=\/api\/hls\/playlist\.m3u8\?id=abc/);
      assert.match(await (await api('GET', `/${id}/hls/hls/segment.ts?id=abc&n=3`)).text(), /#path=\/api\/hls\/segment\.ts\?id=abc&n=3/);
      for (const bad of ['..%2F..%2Fapi', 'streams', 'hls/..%2Fstreams', 'hls/a/b.ts']) {
        assert.equal((await api('GET', `/${id}/hls/${bad}`)).status, 400, bad);
      }
      assert.equal((await api('GET', '/999/hls/index.m3u8')).status, 404);
    });

    it('lists the account\'s cameras for admins, marking ones already added', async () => {
      addCamera('Front Door', 'front_door', '192.168.1.40');
      const list = await (await api('GET', '/bridge/cameras')).json() as any[];
      assert.deepEqual(list.map((c) => [c.cam, c.added]), [['front_door', true], ['living_pan', false]]);
      assert.equal((await api('GET', '/bridge/cameras', undefined, 'member')).status, 403);
    });

    it('requires all four sign-in fields, on one line each', async () => {
      assert.equal((await api('POST', '/bridge/login', { email: 'me@example.com', password: 'pw' })).status, 400);
      assert.equal((await api('POST', '/bridge/login', { ...RIGHT, password: 'pw\nWYZE_EMAIL=x' })).status, 400);
    });

    it('signs out', async () => {
      assert.deepEqual(await (await api('DELETE', '/bridge/login')).json(), { state: 'signed-out' });
      assert.equal(bridge.signInSavedAt(), null);
    });
  });
});
