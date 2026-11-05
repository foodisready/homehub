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
import crypto from 'node:crypto';
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
  /** Streams restarted, by camera name. */
  restarts: [] as string[],
  calls: [] as string[],
  /** Pan and tilt commands go2rtc was sent, as "<cam> <action>". */
  ptz: [] as string[],
  /** An older bridge image, whose go2rtc lacks pan and tilt. */
  noPtz: false,
  /** The camera doesn't answer pan and tilt commands. */
  ptzSilent: false,
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
  if (url.pathname === '/api/wyze/ptz' && req.method === 'POST') {
    if (fake.noPtz) { res.writeHead(404); return res.end('404 page not found'); }
    const src = url.searchParams.get('src') ?? '';
    if (!['front_door', 'living_pan'].includes(src)) { res.writeHead(404); return res.end('wyze: no such Wyze stream'); }
    if (fake.ptzSilent) { res.writeHead(502); return res.end('wyze: command 11002: timeout waiting for response'); }
    fake.ptz.push(`${src} ${url.searchParams.get('action')}`);
    return json(200, { camera_reply: '01' });
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
  const restart = url.pathname.match(/^\/api\/cameras\/([^/]+)\/restart$/);
  if (restart && req.method === 'POST') { fake.restarts.push(restart[1]); return json(200, { status: 'ok' }); }
  const snap = url.pathname.match(/^\/api\/snapshot\/([^/]+)$/);
  if (snap) {
    if (fake.emptyShots > 0) { fake.emptyShots--; res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    return res.end(JPEG);
  }
  json(404, { error: 'not found' });
});

/** A fake Wyze cloud: sign-in, token refresh, and each camera's power, keyed by MAC. */
const wyze = {
  logins: 0,
  refreshes: 0,
  token: '',
  /** The next request with a token answers "expired", as Wyze does after about a day. */
  expireNext: false,
  power: {} as Record<string, boolean>,
  actions: [] as string[],
  /** The account's events, as Wyze lists them. */
  events: [] as Record<string, unknown>[],
  /** Whether event pictures download (Wyze's signed links can expire). */
  picturesWork: true,
  eventRequests: [] as Record<string, any>[],
  requestsLeft: 2000,
};
const WYZE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 9, 9, 9, 0xff, 0xd9]);
const md5x3 = (pw: string) => { let o = pw; for (let i = 0; i < 3; i++) o = crypto.createHash('md5').update(o).digest('hex'); return o; };
const wyzeServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const json = (b: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    const url = req.url ?? '';
    res.setHeader('x-ratelimit-remaining', String(wyze.requestsLeft));
    if (url.startsWith('/pictures/')) {
      if (!wyze.picturesWork) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error": "Access token is invalid."}'); }
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(WYZE_JPEG);
    }
    if (url === '/app/v4/device/get_event_list') {
      // Signed with the token in the headers, not carried in the body.
      if (req.headers.access_token !== wyze.token || req.headers.appid !== '9319141212m2ik' || !req.headers.signature2) return json({ code: '2001', msg: 'access token is error' });
      wyze.eventRequests.push(body);
      const list = wyze.events
        .filter((e) => (body.device_id_list as string[]).includes(e.device_id as string) && (e.event_ts as number) >= body.begin_time && (e.event_ts as number) <= body.end_time)
        .sort((a, b) => (a.event_ts as number) - (b.event_ts as number))
        .slice(0, body.count);
      return json({ code: '1', data: { event_list: list } });
    }
    if (url === '/api/user/login') {
      if (req.headers.apikey !== 'akey' || req.headers.keyid !== 'kid' || body.password !== md5x3('right')) return json({ code: '1000', msg: 'Invalid credentials, please check username, password, keyid or apikey' });
      wyze.logins++;
      wyze.token = `tok${wyze.logins}`;
      return json({ access_token: wyze.token, refresh_token: 'ref', user_id: 'u1' });
    }
    if (url === '/app/user/refresh_token') {
      wyze.refreshes++;
      wyze.token = `tok-r${wyze.refreshes}`;
      return json({ code: '1', data: { access_token: wyze.token, refresh_token: 'ref' } });
    }
    if (body.access_token !== wyze.token || wyze.expireNext) { wyze.expireNext = false; return json({ code: '2001', msg: 'access token is error' }); }
    if (url === '/app/v2/auto/run_action') {
      wyze.actions.push(`${body.action_key} ${body.instance_id} ${body.provider_key}`);
      wyze.power[body.instance_id] = body.action_key === 'power_on';
      return json({ code: '1', data: { result: 'ok' } });
    }
    if (url === '/app/v2/device/get_device_Info') {
      return json({ code: '1', data: { property_list: [{ pid: 'P1', value: '1' }, { pid: 'P3', value: wyze.power[body.device_mac] === false ? '0' : '1' }] } });
    }
    json({ code: '404', msg: 'unknown' });
  });
});

let db: Database.Database;
let bridge: typeof import('./bridge');
let cloud: typeof import('./wyze-cloud');
let pictures: typeof import('./picture-status');
let deviceCache: typeof import('../kasa/device.cache');
let health: typeof import('../system/health');
const ARP = path.join(TMP, 'arp');
const arpTable = (rows: [string, string][]) => fs.writeFileSync(ARP,
  'IP address       HW type     Flags       HW address            Mask     Device\n' +
  rows.map(([ip, mac]) => `${ip}  0x1  0x2  ${mac}  *  wlan0`).join('\n') + '\n');
const setPaused = (id: number, paused: boolean) => deviceCache.getAllCachedStates().set(id, { state: !paused, online: true, wattage: null, lastPolled: new Date() });
let snaps: typeof import('./snapshots');
let watch: typeof import('./watch');
let power: typeof import('../devices/power');
let WyzeDriver: typeof import('../drivers/WyzeDriver');
let ptz: typeof import('./ptz');
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
    await new Promise<void>((ok) => wyzeServer.listen(0, '127.0.0.1', ok));
    const wyzePort = (wyzeServer.address() as { port: number }).port;
    process.env.WYZE_AUTH_URL = `http://127.0.0.1:${wyzePort}`;
    process.env.WYZE_API_URL = `http://127.0.0.1:${wyzePort}/app`;
    process.env.WYZE_CLOUD_URL = `http://127.0.0.1:${wyzePort}/app`;
    process.env.WYZE_IMAGE_URL_PREFIX = `http://127.0.0.1:${wyzePort}/pictures/`;
    const port = (bridgeServer.address() as { port: number }).port;
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    process.env.WYZE_BRIDGE_URL = `http://127.0.0.1:${port}`;
    process.env.WYZE_GO2RTC_URL = `http://127.0.0.1:${port}`;
    process.env.WYZE_BRIDGE_API_KEY = KEY;
    process.env.WYZE_SIGNIN_DIR = SIGNIN;
    process.env.WYZE_RECONNECT_AFTER_MS = '30';

    db = (await import('../db')).getDb();
    bridge = await import('./bridge');
    cloud = await import('./wyze-cloud');
    pictures = await import('./picture-status');
    deviceCache = await import('../kasa/device.cache');
    health = await import('../system/health');
    process.env.HOMEHUB_ARP_FILE = ARP;
    snaps = await import('./snapshots');
    watch = await import('./watch');
    power = await import('../devices/power');
    WyzeDriver = await import('../drivers/WyzeDriver');
    ptz = await import('./ptz');
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
    wyzeServer.closeAllConnections();
    wyzeServer.close();
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
    Object.assign(fake, { up: true, frozen: false, version: '', signedIn: false, emptyShots: 0, calls: [], restarts: [], ptz: [], noPtz: false, ptzSilent: false });
    ptz.resetPtz();
    process.env.WYZE_BRIDGE_API_KEY = KEY;
    watch.resetMotionState();
    WyzeDriver.clearPowerCache();
    cloud.resetCloud();
    pictures.resetPictureStatus();
    deviceCache.getAllCachedStates().clear();
    fs.rmSync(ARP, { force: true });
    Object.assign(wyze, { logins: 0, refreshes: 0, token: '', expireNext: false, power: {}, actions: [], events: [], picturesWork: true, eventRequests: [], requestsLeft: 2000 });
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
      fake.startedAt = at - 10 * 60_000;   // five minutes on, the same old bridge
      const stuck = await bridge.getState(at + 5 * 60_000);
      assert.equal(stuck.state, 'unreachable', 'a bridge that never restarts is a problem, not "starting"');
      assert.match((stuck as { detail: string }).detail, /hasn't restarted/);
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

  describe('Wyze cloud', () => {
    const pan = { mac: '80482C000002', model: 'HL_PAN3' };

    it('keeps its token, in a file only it reads, rather than signing in each time', async () => {
      await cloud.getCameraPower(pan);
      await cloud.setCameraPower(pan, false);
      assert.equal(wyze.logins, 1);
      const file = path.join(SIGNIN, 'homehub-auth.json');
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      cloud.resetCloud();   // as after a restart
      assert.equal(await cloud.getCameraPower(pan), false);
      assert.equal(wyze.logins, 1, 'the saved token was used');
    });

    it('refreshes an expired token and tries again', async () => {
      await cloud.getCameraPower(pan);
      wyze.expireNext = true;
      await cloud.setCameraPower(pan, false);
      assert.deepEqual([wyze.logins, wyze.refreshes], [1, 1]);
      assert.deepEqual(wyze.actions, ['power_off 80482C000002 HL_PAN3']);
    });

    it('explains a rejected sign-in, and waits before trying again', async () => {
      bridge.saveSignIn({ ...RIGHT, password: 'wrong' });
      await assert.rejects(cloud.getCameraPower(pan), /didn't accept the saved sign-in/);
      await assert.rejects(cloud.getCameraPower(pan), (err: Error & { code?: string }) => err.code === 'BACKOFF');
      assert.equal(wyze.logins, 0);
    });

    it('starts afresh after a new sign-in, and forgets its token on sign-out', async () => {
      await cloud.getCameraPower(pan);
      bridge.saveSignIn(RIGHT);
      await cloud.getCameraPower(pan);
      assert.equal(wyze.logins, 2, 'a new sign-in gets a new token');
      bridge.clearSignIn();
      assert.equal(fs.existsSync(path.join(SIGNIN, 'homehub-auth.json')), false);
      await assert.rejects(cloud.getCameraPower(pan), (err: Error & { status?: number }) => err.status === 409);
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

    it('pauses and resumes a camera through Wyze, and caches its state', async () => {
      const d = new WyzeDriver.WyzeDriver();
      await d.setPower('ip', false, { cam: 'living_pan' });
      assert.deepEqual(wyze.actions, ['power_off 80482C000002 HL_PAN3']);
      assert.equal(await d.getPower('ip', { cam: 'living_pan' }), false, 'from the cache');
      WyzeDriver.clearPowerCache();
      assert.equal(await d.getPower('ip', { cam: 'living_pan' }), false, 'from Wyze');
      await d.setPower('ip', true, { cam: 'living_pan' });
      WyzeDriver.clearPowerCache();
      assert.equal(await d.getPower('ip', { cam: 'living_pan' }), true);
      assert.equal(wyze.logins, 1, 'signed in once');
    });

    it('says when the camera bridge lacks the camera', async () => {
      await assert.rejects(new WyzeDriver.WyzeDriver().setPower('ip', false, { cam: 'gone' }), /doesn't have this camera/);
      assert.deepEqual(wyze.actions, []);
    });

    it('falls back to the bridge when Wyze can\'t be asked', async () => {
      process.env.WYZE_API_URL = 'http://127.0.0.1:1/app';
      try {
        assert.equal(await new WyzeDriver.WyzeDriver().getPower('ip', { cam: 'front_door' }), true);
      } finally {
        process.env.WYZE_API_URL = `${process.env.WYZE_AUTH_URL}/app`;
      }
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


    it('validates settings', () => {
      assert.deepEqual(snaps.saveSettings({ keepDays: 7, notify: true }), { enabled: true, motionSnapshots: true, notify: true, keepDays: 7, cooldownSeconds: 30 });
      assert.throws(() => snaps.saveSettings({ enabled: 1 as never }), /enabled/);
      assert.throws(() => snaps.saveSettings({ keepDays: 0 }), /keepDays/);
      assert.throws(() => snaps.saveSettings({ notify: 'yes' as never }), /notify/);
    });
  });

  describe('motion snapshots', () => {
    const FRONT = '2CAA8E000001';
    const PAN = '80482C000002';
    let started = 0;
    let n = 0;
    const event = (mac: string, at: number, extra: Record<string, unknown> = {}) => {
      const id = `ev${++n}`;
      wyze.events.push({ event_id: id, device_id: mac, event_ts: at, event_value: '13', tag_list: [], file_list: [{ type: 1, url: `${process.env.WYZE_IMAGE_URL_PREFIX}${id}.jpg` }, { type: 2, url: 'https://example.invalid/clip.mp4' }], ...extra });
      return id;
    };
    beforeEach(() => {
      started = Date.now() - 10 * 60_000;
      watch.resetMotionState(started);
    });

    it('signs event requests the way Wyze checks them', () => {
      // The body and signature docker-wyze-bridge 2.x's Python code produces for these values.
      const body = cloud.sortedJson({ nonce: '1700000000000', count: 20, order_by: 1, device_id_list: ['AABBCCDDEEFF'], begin_time: 1, end_time: 2, event_value_list: [], event_tag_list: [], z: { b: 1, a: [3, { d: 1, c: 2 }] } });
      assert.equal(body, '{"begin_time":1,"count":20,"device_id_list":["AABBCCDDEEFF"],"end_time":2,"event_tag_list":[],"event_value_list":[],"nonce":"1700000000000","order_by":1,"z":{"a":[3,{"c":2,"d":1}],"b":1}}');
      assert.equal(cloud.signBody(body, 'test-token'), '1fde9756cf0dac8c62ff4a59eae818aa');
    });

    it("saves Wyze's own picture of new motion, at the time it happened", async () => {
      const id = addCamera('Front Door', 'front_door', '192.168.1.40', FRONT);
      const now = Date.now();
      event(FRONT, now - 20_000, { tag_list: [101] });
      assert.equal(await watch.checkMotion(now), 1);
      const [snap] = snaps.listSnapshots();
      assert.deepEqual([snap.deviceId, snap.trigger, snap.cameraName], [id, 'motion', 'Front Door']);
      assert.deepEqual(fs.readFileSync(snaps.snapshotFile(snap.id)!), WYZE_JPEG);
      assert.equal(Date.parse(snap.takenAt), Math.floor((now - 20_000) / 1000) * 1000);
      assert.deepEqual(wyze.eventRequests[0].device_id_list, [FRONT]);
      assert.equal(watch.lastMotionFor(id), new Date(now - 20_000).toISOString());
    });

    it("uses a frame from the bridge when Wyze's picture won't download", async () => {
      addCamera('Front Door', 'front_door', '192.168.1.40', FRONT);
      wyze.picturesWork = false;
      event(FRONT, Date.now() - 5000);
      assert.equal(await watch.checkMotion(), 1);
      assert.deepEqual(fs.readFileSync(snaps.snapshotFile(snaps.listSnapshots()[0].id)!), JPEG);
    });

    it('saves each event once, though every check looks back a few minutes', async () => {
      addCamera('Front Door', 'front_door', '192.168.1.40', FRONT);
      event(FRONT, Date.now() - 5000);
      assert.equal(await watch.checkMotion(), 1);
      assert.equal(await watch.checkMotion(), 0);
      assert.equal(wyze.eventRequests.length, 2);
    });

    it('treats events from before it started as old news, and looks back only a few minutes', async () => {
      const id = addCamera('Front Door', 'front_door', '192.168.1.40', FRONT);
      const now = Date.now();
      watch.resetMotionState(now - 30_000);
      event(FRONT, now - 50_000);   // before HomeHub started watching
      assert.equal(await watch.checkMotion(now), 0);
      assert.equal(watch.lastMotionFor(id), new Date(now - 50_000).toISOString(), 'still shown as the last motion');
      wyze.events = [];
      watch.resetMotionState(now - 20 * 60_000);
      event(FRONT, now - 4 * 60_000);
      assert.equal(await watch.checkMotion(now), 0, 'outside the look-back');
      assert.ok(wyze.eventRequests.at(-1)!.begin_time >= now - 3 * 60_000);
    });

    it('ignores sound, cameras not in HomeHub, and the setting turned off', async () => {
      addCamera('Front Door', 'front_door', '192.168.1.40', FRONT);
      event(FRONT, Date.now() - 9000, { event_value: '2' });
      event(PAN, Date.now() - 8000);
      assert.equal(await watch.checkMotion(), 0);
      snaps.saveSettings({ motionSnapshots: false });
      event(FRONT, Date.now() - 4000);
      assert.equal(await watch.checkMotion(), 0);
      assert.equal(snaps.listSnapshots().length, 0);
    });

    it('waits out the cooldown between snapshots from one camera', async () => {
      addCamera('Front Door', 'front_door', '192.168.1.40', FRONT);
      addCamera('Living Pan', 'living_pan', '192.168.0.32', PAN);
      const now = Date.now();
      event(FRONT, now - 60_000);
      event(FRONT, now - 50_000);   // 10 s later: within 30 s
      event(PAN, now - 49_000);     // another camera: its own cooldown
      event(FRONT, now - 20_000);   // 40 s later
      assert.equal(await watch.checkMotion(now), 3);
    });

    it('reads past a full page of events', async () => {
      addCamera('Front Door', 'front_door', '192.168.1.40', FRONT);
      snaps.saveSettings({ cooldownSeconds: 5 });
      const now = Date.now();
      for (let i = 0; i < 25; i++) event(FRONT, now - 150_000 + i * 6000);
      assert.equal(await watch.checkMotion(now), 25);
      assert.equal(wyze.eventRequests.length, 2);
    });

    it('notes how many requests Wyze says are left', async () => {
      addCamera('Front Door', 'front_door', '192.168.1.40', FRONT);
      wyze.requestsLeft = 42;
      await watch.checkMotion();
      assert.equal(cloud.wyzeRequestsLeft(), 42);
    });

    it('shows the last motion on the camera list', async () => {
      const id = addCamera('Front Door', 'front_door', '192.168.1.40', FRONT);
      const at = Date.now() - 7000;
      event(FRONT, at);
      await watch.checkMotion();
      const body = await (await api('GET', '')).json() as any;
      assert.equal(body.cameras.find((c: any) => c.deviceId === id).lastMotionAt, new Date(at).toISOString());
    });
  });

  describe('picture status', () => {
    it('calls a camera broken after two failures in a row, not one', async () => {
      fake.emptyShots = 1;
      await assert.rejects(bridge.snapshot('front_door', 1));
      assert.equal(pictures.pictureHealth('front_door').state, 'unknown', 'one failure, never a picture');
      await bridge.snapshot('front_door');
      assert.equal(pictures.pictureHealth('front_door').state, 'ok');
      fake.emptyShots = 1;
      await assert.rejects(bridge.snapshot('front_door', 1));
      assert.equal(pictures.pictureHealth('front_door').state, 'ok', 'a hiccup after good pictures');
      fake.emptyShots = 2;
      await assert.rejects(bridge.snapshot('front_door', 2));
      const h = pictures.pictureHealth('front_door');
      assert.equal(h.state, 'failing');
      assert.ok(h.failingSince && h.lastOkAt);
      assert.equal(pictures.pictureHealth('front_door', Date.now() + 20 * 60_000).state, 'unknown', 'old news');
    });

    it("doesn't blame the camera when the bridge is down or rejects HomeHub", async () => {
      fake.up = false;
      await assert.rejects(bridge.snapshot('front_door', 1));
      await assert.rejects(bridge.snapshot('front_door', 1));
      fake.up = true;
      process.env.WYZE_BRIDGE_API_KEY = 'wrong';
      await assert.rejects(bridge.snapshot('front_door', 1));
      assert.equal(pictures.lastAsked('front_door'), null);
    });

    it("says whether a camera with no picture is on HomeHub's network", async () => {
      arpTable([['192.168.1.40', '04:e4:b6:ac:81:d8']]);   // another device has the camera's address
      assert.match(await pictures.noPictureHint('front_door', '2CAA8E000001', '192.168.1.40'), /can't find this camera on its network/);
      arpTable([['192.168.1.41', '2c:aa:8e:00:00:01']]);
      assert.match(await pictures.noPictureHint('front_door', '2CAA8E000001', null), /can't find/, 'remembered for two minutes');
      assert.match(await pictures.noPictureHint('front_door', '2CAA8E000001', null, Date.now() + 3 * 60_000), /on the network but isn't sending video/);
      fs.rmSync(ARP);
      assert.match(await pictures.noPictureHint('living_pan', '80482C000002', null), /Check that the camera is on/, 'no address table');
    });

    it('checks cameras nobody has looked at lately, but not paused ones', async () => {
      addCamera('Front Door', 'front_door', '192.168.1.40', '2CAA8E000001');
      const pan = addCamera('Living Pan', 'living_pan', '192.168.0.32', '80482C000002');
      setPaused(pan, true);
      assert.equal(await watch.checkPictures(), 1);
      assert.equal(pictures.pictureHealth('front_door').state, 'ok');
      assert.equal(pictures.lastAsked('living_pan'), null, 'paused: not asked');
      assert.equal(await watch.checkPictures(), 0, 'just checked');
      assert.equal(await watch.checkPictures(Date.now() + 6 * 60_000), 1);
    });

    it('restarts the stream of a camera that is on the network but sends nothing, now and then', async () => {
      const front = { id: 1, alias: 'Front Door', cam: 'front_door', mac: '2CAA8E000001' };
      arpTable([['192.168.1.40', '2c:aa:8e:00:00:01']]);
      assert.equal(await watch.repairIfStuck(front, null), false, 'not failing');
      fake.emptyShots = 4;
      await assert.rejects(bridge.snapshot('front_door', 2));
      await assert.rejects(bridge.snapshot('front_door', 2));
      assert.equal(await watch.repairIfStuck(front, null), true);
      assert.equal(await watch.repairIfStuck(front, null), false, 'not again so soon');
      assert.equal(await watch.repairIfStuck(front, null, Date.now() + 11 * 60_000), true, 'still stuck ten minutes on: try again');
      assert.deepEqual(fake.restarts, ['front_door', 'front_door']);
    });

    it("doesn't restart a camera that isn't on the network, which a restart can't fix", async () => {
      arpTable([['192.168.1.40', '04:e4:b6:ac:81:d8']]);
      fake.emptyShots = 4;
      await assert.rejects(bridge.snapshot('front_door', 2));
      await assert.rejects(bridge.snapshot('front_door', 2));
      assert.equal(await watch.repairIfStuck({ id: 1, alias: 'Front Door', cam: 'front_door', mac: '2CAA8E000001' }, null), false);
      assert.deepEqual(fake.restarts, []);
    });

    it('reconnects a camera on the bridge after resuming it', async () => {
      await new WyzeDriver.WyzeDriver().setPower('ip', true, { cam: 'living_pan' });
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(fake.restarts, ['living_pan']);
      await new WyzeDriver.WyzeDriver().setPower('ip', false, { cam: 'living_pan' });
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(fake.restarts, ['living_pan'], 'not after pausing');
    });

    it("shows each camera's picture status, with a hint when there is none", async () => {
      const id = addCamera('Front Door', 'front_door', '192.168.1.40', '2CAA8E000001');
      arpTable([]);
      fake.emptyShots = 4;
      await assert.rejects(bridge.snapshot('front_door', 2));
      await assert.rejects(bridge.snapshot('front_door', 2));
      const cam = ((await (await api('GET', '')).json()) as any).cameras.find((c: any) => c.deviceId === id);
      assert.equal(cam.picture, 'failing');
      assert.ok(cam.noPictureSince);
      assert.match(cam.noPictureHint, /can't find this camera/);
    });

    it('warns on the Health page after ten minutes without a picture', async () => {
      addCamera('Front Door', 'front_door', '192.168.1.40', '2CAA8E000001');
      const item = async (now: number) => (await health.checkHealth({ probe: async () => true, now })).items.find((i) => i.id === 'camera-pictures');
      await bridge.snapshot('front_door');
      assert.equal((await item(Date.now()))?.level, 'ok');
      fake.emptyShots = 4;
      await assert.rejects(bridge.snapshot('front_door', 2));
      await assert.rejects(bridge.snapshot('front_door', 2));
      assert.equal((await item(Date.now()))?.level, 'info', 'not yet');
      const later = await item(Date.now() + 11 * 60_000);
      assert.equal(later?.level, 'warn');
      assert.match(later!.detail, /No picture from Front Door\. The last one was 11 minutes ago/);
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

  describe('pan and tilt', () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('marks Pan cameras as able to turn', async () => {
      addCamera('Front Door', 'front_door', '192.168.1.40');
      addCamera('Living Pan', 'living_pan', '192.168.0.32');
      const body = await (await api('GET', '')).json() as any;
      assert.deepEqual(body.cameras.map((c: any) => [c.cam, c.canPan]).sort(), [['front_door', false], ['living_pan', true]]);
      assert.equal(ptz.canPan({ model: 'HL_PAN2', modelName: null }), true);
      assert.equal(ptz.canPan({ model: null, modelName: 'Pan v3' }), true);
      assert.equal(ptz.canPan({ model: 'WYZE_CAKP2JFUS', modelName: 'V3' }), false);
      assert.equal(ptz.canPan(undefined), false);
    });

    it('turns while the arrow is held, and stops when it is let go', async () => {
      const id = addCamera('Living Pan', 'living_pan', '192.168.0.32');
      assert.equal((await api('POST', `/${id}/ptz`, { action: 'left' }, 'member')).status, 204, 'anyone signed in can turn a camera');
      // Repeats say the arrow is still held; the camera is already turning, so they don't reach it.
      for (let i = 0; i < 3; i++) assert.equal((await api('POST', `/${id}/ptz`, { action: 'left' })).status, 204);
      assert.equal((await api('POST', `/${id}/ptz`, { action: 'stop' })).status, 204);
      assert.equal((await api('POST', `/${id}/ptz`, { action: 'up' })).status, 204);
      assert.equal((await api('POST', `/${id}/ptz`, { action: 'stop' })).status, 204);
      assert.deepEqual(fake.ptz, ['living_pan left', 'living_pan stop', 'living_pan up', 'living_pan stop']);
    });

    it('stops a camera itself when the page stops saying the arrow is held', async () => {
      process.env.WYZE_PTZ_HOLD_MS = '120';
      try {
        const id = addCamera('Living Pan', 'living_pan', '192.168.0.32');
        await api('POST', `/${id}/ptz`, { action: 'right' });
        await wait(70);
        await api('POST', `/${id}/ptz`, { action: 'right' });   // still held
        await wait(70);
        assert.deepEqual(fake.ptz, ['living_pan right'], 'a repeat keeps it going');
        await wait(150);
        assert.deepEqual(fake.ptz, ['living_pan right', 'living_pan stop'], 'stopped once the repeats stopped');
        // A new direction replaces the old move, without a stop in between.
        await api('POST', `/${id}/ptz`, { action: 'down' });
        await api('POST', `/${id}/ptz`, { action: 'left' });
        await wait(200);
        assert.deepEqual(fake.ptz.slice(2), ['living_pan down', 'living_pan left', 'living_pan stop']);
      } finally {
        delete process.env.WYZE_PTZ_HOLD_MS;
      }
    });

    it('refuses cameras that don\'t turn and actions it doesn\'t know', async () => {
      const fixed = addCamera('Front Door', 'front_door', '192.168.1.40');
      const pan = addCamera('Living Pan', 'living_pan', '192.168.0.32');
      assert.equal((await api('POST', `/${fixed}/ptz`, { action: 'left' })).status, 409);
      for (const action of ['spin', '', 5, undefined]) {
        assert.equal((await api('POST', `/${pan}/ptz`, { action })).status, 400, String(action));
      }
      assert.equal((await api('POST', '/999/ptz', { action: 'left' })).status, 404);
      assert.deepEqual(fake.ptz, []);
    });

    it('says when the bridge is too old to turn cameras, or the camera doesn\'t answer', async () => {
      const id = addCamera('Living Pan', 'living_pan', '192.168.0.32');
      fake.noPtz = true;
      const old = await api('POST', `/${id}/ptz`, { action: 'left' });
      assert.equal(old.status, 501);
      assert.match(((await old.json()) as any).error, /Update HomeHub/);
      fake.noPtz = false;
      fake.ptzSilent = true;
      const silent = await api('POST', `/${id}/ptz`, { action: 'left' });
      assert.equal(silent.status, 502);
      assert.match(((await silent.json()) as any).error, /didn't turn/);
      fake.ptzSilent = false;
      // A failed move isn't remembered as under way, so the next press tries the camera again.
      assert.equal((await api('POST', `/${id}/ptz`, { action: 'left' })).status, 204);
      assert.deepEqual(fake.ptz, ['living_pan left']);
    });
  });
});
