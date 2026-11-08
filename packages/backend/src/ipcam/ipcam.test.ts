/**
 * IP cameras through a fake ONVIF camera, a fake camera relay (go2rtc) and a
 * fake camera snapshot address that wants a Digest login, against a temp DB
 * and a temp snapshots folder. Nothing touches the real network.
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this file
 * stays on its temp DB even under a runner that hoists static imports.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import type Database from 'better-sqlite3';
import type { CameraLogin, MotionEvent, OnvifConnector, PanAction, ProbeResult } from './onvif-client';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-ipcam-test-'));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7, 0xff, 0xd9]);
const FRAME = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 8, 8, 8, 0xff, 0xd9]);
const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');

// ── A fake camera's snapshot address, which wants Digest ──────────────
const cam = { snapshots: 0, user: 'admin', pass: 'right' };
const camServer = http.createServer((req, res) => {
  const auth = req.headers.authorization ?? '';
  const f: Record<string, string> = {};
  for (const m of auth.matchAll(/(\w+)="?([^",]*)"?/g)) f[m[1]] = m[2];
  const ha1 = md5(`${cam.user}:cam:${cam.pass}`);
  const ok = auth.startsWith('Digest ') && f.response === md5(`${ha1}:n1:${f.nc}:${f.cnonce}:auth:${md5(`GET:${f.uri}`)}`);
  if (!ok) {
    res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="cam", nonce="n1", qop="auth"' });
    return res.end();
  }
  cam.snapshots++;
  res.writeHead(200, { 'content-type': 'image/jpeg' });
  res.end(JPEG);
});

// ── A fake camera relay ──────────────────────────────────────────────
const relay = { streams: {} as Record<string, string>, puts: [] as string[], up: true, busy: 0, overlapped: false };
const relayServer = http.createServer((req, res) => {
  if (!relay.up) { res.writeHead(500); return res.end(); }
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/api') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"version":"1.9.14"}');
  }
  if (url.pathname === '/api/streams' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    // go2rtc hides passwords in this list, so HomeHub can't compare sources from it.
    return res.end(JSON.stringify(Object.fromEntries(Object.keys(relay.streams).map((k) => [k, { producers: [{ url: 'rtsp://***' }] }]))));
  }
  if (url.pathname === '/api/streams' && (req.method === 'PUT' || req.method === 'DELETE')) {
    // Like go2rtc, which crashes when two changes overlap: note it if they do.
    if (relay.busy++) relay.overlapped = true;
    setTimeout(() => {
      relay.busy--;
      if (req.method === 'PUT') {
        relay.streams[url.searchParams.get('name')!] = url.searchParams.get('src')!;
        relay.puts.push(url.searchParams.get('name')!);
      } else {
        delete relay.streams[url.searchParams.get('src')!];
      }
      res.end();
    }, 20);
    return;
  }
  if (url.pathname === '/api/frame.jpeg') {
    if (!relay.streams[url.searchParams.get('src')!]) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    return res.end(FRAME);
  }
  if (url.pathname === '/api/stream.m3u8') {
    const src = url.searchParams.get('src')!;
    if (!relay.streams[src]) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    return res.end(`#EXTM3U\nhls/playlist.m3u8?id=${src}`);
  }
  if (url.pathname.startsWith('/api/hls/')) {
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    return res.end(`segment ${url.pathname}${url.search}`);
  }
  res.writeHead(404);
  res.end();
});

// ── A fake ONVIF camera ──────────────────────────────────────────────
let snapshotBase = '';
const onvif = {
  port: 8000,
  user: 'admin',
  pass: 'right',
  probes: [] as CameraLogin[],
  watches: 0,
  stops: 0,
  emit: null as ((e: MotionEvent) => void) | null,
  fail: null as ((err: Error) => void) | null,
  pans: [] as PanAction[],
  found: [{ host: '192.0.2.20', port: 8000, name: 'Reolink', model: 'RLC-510A' }],
  canPan: true,
};
let OnvifErrorClass: typeof import('./onvif-client').OnvifError;

const connector: OnvifConnector = {
  async probe(login) {
    onvif.probes.push(login);
    if (login.port !== onvif.port) throw new OnvifErrorClass('No answer from the camera at that address', 'unreachable');
    if (login.username !== onvif.user || login.password !== onvif.pass) throw new OnvifErrorClass('The camera didn\'t accept the username and password', 'login');
    const result: ProbeResult = {
      port: login.port, maker: 'Reolink', model: 'RLC-510A',
      mainUrl: `rtsp://${login.host}:554/h264Preview_01_main`, subUrl: `rtsp://${login.host}:554/h264Preview_01_sub`,
      snapshotUrl: `${snapshotBase}/cgi-bin/snap`, canPan: onvif.canPan,
    };
    return result;
  },
  watchMotion(_login, onEvent, onError) {
    onvif.watches++;
    onvif.emit = onEvent;
    onvif.fail = onError;
    return { stop: () => { onvif.stops++; } };
  },
  async pan(_login, action) { onvif.pans.push(action); },
  async discover() { return onvif.found; },
};

describe('IP cameras', () => {
  let db: Database.Database;
  let ipcam: typeof import('./ipcam');
  let client: typeof import('./onvif-client');
  let auth: typeof import('./http-auth');
  let snaps: typeof import('../cameras/snapshots');
  let backup: typeof import('../db/json-backup');
  let app: http.Server;
  let base: string;
  const pushes: { title: string; body: string; data?: Record<string, unknown> }[] = [];

  const api = async (method: string, url: string, body?: unknown, role = 'admin') => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-role': role },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = res.headers.get('content-type') ?? '';
    const raw = Buffer.from(await res.arrayBuffer());
    return { status: res.status, type, raw, body: type.includes('json') && raw.length ? JSON.parse(raw.toString()) : null };
  };

  const listen = (s: http.Server) => new Promise<string>((ok) => s.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
  const add = (over: Record<string, unknown> = {}) => api('POST', '/api/ip-cameras', { host: '192.0.2.20', username: 'admin', password: 'right', ...over });

  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    snapshotBase = await listen(camServer);
    process.env.CAMERA_RELAY_URL = await listen(relayServer);
    db = (await import('../db')).getDb();
    client = await import('./onvif-client');
    OnvifErrorClass = client.OnvifError;
    ipcam = await import('./ipcam');
    auth = await import('./http-auth');
    snaps = await import('../cameras/snapshots');
    backup = await import('../db/json-backup');
    ipcam.setOnvifConnectorForTests(connector);
    ipcam.setPushForTests((title, body, data) => { pushes.push({ title, body, data }); });
    const { ipCamerasRouter } = await import('../routes/ip-cameras');
    const { camerasRouter } = await import('../routes/cameras');
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.user = { userId: 1, username: 't', role: (req.headers['x-test-role'] as string) ?? 'admin' } as never;
      next();
    });
    server.use('/api/ip-cameras', ipCamerasRouter);
    server.use('/api/cameras', camerasRouter);
    await new Promise<void>((ok) => { app = server.listen(0, '127.0.0.1', () => ok()); });
    base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  });

  after(async () => {
    ipcam.stopIpCameras();
    for (const s of [app, camServer, relayServer]) {
      s.closeAllConnections();
      await new Promise<void>((ok) => s.close(() => ok()));
    }
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    ipcam.resetIpCamState();
    db.prepare('DELETE FROM ip_cameras').run();
    db.prepare('DELETE FROM camera_snapshots').run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'camera%' OR key IN ('server_role', 'automations_paused')").run();
    fs.rmSync(snaps.snapshotDir(), { recursive: true, force: true });
    Object.assign(onvif, { port: 8000, user: 'admin', pass: 'right', probes: [], watches: 0, stops: 0, emit: null, fail: null, pans: [], canPan: true });
    Object.assign(relay, { streams: {}, puts: [], up: true, busy: 0, overlapped: false });
    Object.assign(cam, { snapshots: 0, user: 'admin', pass: 'right' });
    pushes.length = 0;
  });

  describe('adding', () => {
    it('finds the ONVIF port, reads what the camera offers, and keeps the login out of the addresses', async () => {
      const res = await add();
      assert.equal(res.status, 201);
      assert.deepEqual(onvif.probes.map((p) => p.port), client.ONVIF_PORTS, 'tried the usual ports at once');
      assert.equal(res.body.name, 'RLC-510A');
      assert.equal(res.body.maker, 'Reolink');
      assert.equal(res.body.onvif, true);
      assert.equal(res.body.canPan, true);
      assert.equal(res.body.hasSubStream, true);
      assert.equal(res.body.hasPassword, true);
      assert.equal(res.body.motion, true);
      assert.equal(res.body.key, `ipcam-${res.body.id}`);
      assert.equal('password' in res.body, false, 'never sent back');
      const row = db.prepare('SELECT * FROM ip_cameras').get() as Record<string, unknown>;
      assert.equal(row.onvif_port, 8000);
      assert.doesNotMatch(String(row.main_url), /right/);
    });

    it('says the login is wrong when one port turns it down, over ports that gave no answer', async () => {
      const res = await add({ password: 'wrong' });
      assert.equal(res.status, 422);
      assert.match(res.body.error, /didn't accept that username and password/);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ip_cameras').get() as { n: number }).n, 0);
    });

    it('says what to check when nothing answers', async () => {
      onvif.port = 9999;
      const res = await add();
      assert.equal(res.status, 502);
      assert.match(res.body.error, /No camera answered at 192\.0\.2\.20.*ONVIF is on/);
      assert.deepEqual(onvif.probes.map((p) => p.port), client.ONVIF_PORTS);
      assert.equal((await add({ port: 9999 })).status, 201, 'a port given is the only one tried');
    });

    it('adds a camera without ONVIF by its RTSP address, taking the login out of it', async () => {
      const res = await api('POST', '/api/ip-cameras', { rtspUrl: 'rtsp://admin:p%40ss@192.0.2.30:554/cam/realmonitor?channel=1&subtype=0', name: 'Porch' });
      assert.equal(res.status, 201);
      assert.equal(res.body.name, 'Porch');
      assert.equal(res.body.onvif, false);
      assert.equal(res.body.motionState, 'unsupported');
      const row = db.prepare('SELECT * FROM ip_cameras').get() as Record<string, string>;
      assert.equal(row.username, 'admin');
      assert.equal(row.password, 'p@ss');
      assert.equal(row.main_url, 'rtsp://192.0.2.30:554/cam/realmonitor?channel=1&subtype=0');
      assert.equal(onvif.probes.length, 0);
    });

    it('refuses bad input, the same camera twice, and anyone but an admin', async () => {
      for (const host of ['', 'a b', 'x;rm', '192.0.2.20/x']) assert.equal((await add({ host })).status, 400, host);
      assert.equal((await add({ port: 70000 })).status, 400);
      assert.equal((await api('POST', '/api/ip-cameras', { rtspUrl: 'http://192.0.2.30/x' })).status, 400);
      assert.equal((await api('POST', '/api/ip-cameras', { rtspUrl: 'not a url' })).status, 400);
      assert.equal((await add()).status, 201);
      assert.equal((await add()).status, 409);
      assert.equal((await api('POST', '/api/ip-cameras', { host: '192.0.2.21', username: 'admin', password: 'right' }, 'user')).status, 403);
    });

    it('lists cameras the ONVIF search finds, and which are added', async () => {
      assert.deepEqual((await api('POST', '/api/ip-cameras/discover')).body, [{ ...onvif.found[0], added: false }]);
      await add();
      assert.equal((await api('POST', '/api/ip-cameras/discover')).body[0].added, true);
    });
  });

  describe('changing and removing', () => {
    it('checks a new login with the camera, and keeps the saved password when it is left blank', async () => {
      const { body } = await add();
      cam.pass = onvif.pass = 'new';
      assert.equal((await api('PATCH', `/api/ip-cameras/${body.id}`, { password: 'wrong' })).status, 422);
      assert.equal((db.prepare('SELECT password FROM ip_cameras').get() as { password: string }).password, 'right', 'unchanged');
      assert.equal((await api('PATCH', `/api/ip-cameras/${body.id}`, { password: 'new' })).status, 200);
      const res = await api('PATCH', `/api/ip-cameras/${body.id}`, { name: 'Driveway', password: '', quality: 'sub', motion: false });
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'Driveway');
      assert.equal(res.body.quality, 'sub');
      assert.equal(res.body.motionState, 'off');
      assert.equal((db.prepare('SELECT password FROM ip_cameras').get() as { password: string }).password, 'new');
    });

    it('refuses settings a camera can\'t have', async () => {
      const { body } = await api('POST', '/api/ip-cameras', { rtspUrl: 'rtsp://192.0.2.30/live' });
      assert.match((await api('PATCH', `/api/ip-cameras/${body.id}`, { quality: 'sub' })).body.error, /only one stream/);
      assert.match((await api('PATCH', `/api/ip-cameras/${body.id}`, { motion: true })).body.error, /Motion needs ONVIF/);
      assert.equal((await api('PATCH', `/api/ip-cameras/${body.id}`, { quality: 'best' })).status, 400);
      assert.equal((await api('PATCH', '/api/ip-cameras/999', { name: 'x' })).status, 404);
    });

    it('removes a camera, its relay streams and its watch, but keeps its snapshots', async () => {
      const { body } = await add();
      ipcam.checkIpCameras();
      await api('POST', `/api/ip-cameras/${body.id}/snapshots`);
      await api('GET', `/api/ip-cameras/${body.id}/hls/index.m3u8`);
      assert.equal(Object.keys(relay.streams).length, 1);
      assert.equal((await api('DELETE', `/api/ip-cameras/${body.id}`, undefined, 'user')).status, 403);
      assert.equal((await api('DELETE', `/api/ip-cameras/${body.id}`)).status, 204);
      assert.deepEqual(relay.streams, {});
      assert.equal(onvif.stops, 1);
      assert.equal(snaps.listSnapshots({ camera: body.key }).length, 1);
      assert.equal((await api('DELETE', `/api/ip-cameras/${body.id}`)).status, 404);
    });
  });

  describe('pictures and live video', () => {
    it("takes the camera's own snapshot with a Digest login", async () => {
      const { body } = await add();
      const res = await api('GET', `/api/ip-cameras/${body.id}/live.jpg`, undefined, 'user');
      assert.equal(res.status, 200);
      assert.deepEqual(res.raw, JPEG);
      assert.equal(cam.snapshots, 1);
      const shot = await api('POST', `/api/ip-cameras/${body.id}/snapshots`, undefined, 'user');
      assert.equal(shot.status, 201);
      assert.equal(shot.body.camera, body.key);
      assert.equal(shot.body.trigger, 'manual');
      assert.equal(ipcam.cameraStatuses()[0].latestSnapshot?.id, shot.body.id);
    });

    it('says to re-enter the login when the camera stops accepting it', async () => {
      const { body } = await add();
      cam.pass = 'changed';
      const res = await api('GET', `/api/ip-cameras/${body.id}/live.jpg`);
      assert.equal(res.status, 502);
      assert.match(res.body.error, /didn't accept its saved login/);
    });

    it('makes a picture from the video when the camera has no snapshot address', async () => {
      const { body } = await api('POST', '/api/ip-cameras', { rtspUrl: 'rtsp://u:p@192.0.2.30/live' });
      const res = await api('GET', `/api/ip-cameras/${body.id}/live.jpg`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.raw, FRAME);
      assert.equal(relay.streams[ipcam.streamName(body.id, 'main')], 'rtsp://u:p@192.0.2.30/live', 'the relay gets the login');
    });

    it('relays live video, telling the relay the stream only when it needs it', async () => {
      const { body } = await add();
      const first = await api('GET', `/api/ip-cameras/${body.id}/hls/index.m3u8`, undefined, 'user');
      assert.equal(first.status, 200);
      assert.match(first.raw.toString(), /hls\/playlist\.m3u8\?id=ipcam_\d+_main/);
      assert.equal(relay.streams[`ipcam_${body.id}_main`], 'rtsp://admin:right@192.0.2.20:554/h264Preview_01_main');
      await api('GET', `/api/ip-cameras/${body.id}/hls/index.m3u8`);
      assert.equal(relay.puts.length, 1, 'already there');
      relay.streams = {};   // the relay restarted
      await api('GET', `/api/ip-cameras/${body.id}/hls/index.m3u8`);
      assert.equal(relay.puts.length, 2, 'told again');
      assert.match((await api('GET', `/api/ip-cameras/${body.id}/hls/hls/segment.ts?id=abc&n=3`)).raw.toString(), /segment \/api\/hls\/segment\.ts\?id=abc&n=3/);
      for (const bad of ['..%2F..%2Fapi', 'streams', 'hls/..%2Fstreams', 'hls/a/b.ts']) {
        assert.equal((await api('GET', `/api/ip-cameras/${body.id}/hls/${bad}`)).status, 400, bad);
      }
      await api('PATCH', `/api/ip-cameras/${body.id}`, { quality: 'sub' });
      assert.match((await api('GET', `/api/ip-cameras/${body.id}/hls/index.m3u8`)).raw.toString(), /ipcam_\d+_sub/);
      assert.equal((await api('GET', '/api/ip-cameras/999/hls/index.m3u8')).status, 404);
    });

    it('sends the relay one change at a time, which go2rtc needs', async () => {
      const a = await add();
      const b = await add({ host: '192.0.2.21' });
      await Promise.all([
        api('GET', `/api/ip-cameras/${a.body.id}/hls/index.m3u8`),
        api('GET', `/api/ip-cameras/${b.body.id}/hls/index.m3u8`),
        api('GET', `/api/ip-cameras/${a.body.id}/live.jpg`),
        api('DELETE', `/api/ip-cameras/${b.body.id}`),
      ]);
      assert.equal(relay.overlapped, false);
    });

    it('says the relay is missing, rather than failing quietly', async () => {
      const { body } = await api('POST', '/api/ip-cameras', { rtspUrl: 'rtsp://192.0.2.30/live' });
      const saved = process.env.CAMERA_RELAY_URL;
      process.env.CAMERA_RELAY_URL = 'http://127.0.0.1:1';
      try {
        const res = await api('GET', `/api/ip-cameras/${body.id}/hls/index.m3u8`);
        assert.equal(res.status, 503);
        assert.match(res.body.error, /camera relay isn't running/);
        assert.equal((await api('GET', '/api/ip-cameras')).body.relay.state, 'unreachable');
      } finally {
        process.env.CAMERA_RELAY_URL = saved;
      }
      assert.equal((await api('GET', '/api/ip-cameras')).body.relay.state, 'ready');
    });

    it('turns a camera that can, and not one that can\'t', async () => {
      const { body } = await add();
      assert.equal((await api('POST', `/api/ip-cameras/${body.id}/ptz`, { action: 'left' }, 'user')).status, 204);
      assert.equal((await api('POST', `/api/ip-cameras/${body.id}/ptz`, { action: 'stop' })).status, 204);
      assert.deepEqual(onvif.pans, ['left', 'stop']);
      assert.equal((await api('POST', `/api/ip-cameras/${body.id}/ptz`, { action: 'spin' })).status, 400);
      onvif.canPan = false;
      const fixed = await add({ host: '192.0.2.21' });
      assert.equal((await api('POST', `/api/ip-cameras/${fixed.body.id}/ptz`, { action: 'left' })).status, 409);
    });
  });

  describe('motion', () => {
    it('watches cameras with motion on, on the active HomeHub with cameras on', async () => {
      const { body } = await add();
      await add({ host: '192.0.2.21' });
      await api('PATCH', `/api/ip-cameras/${body.id}`, { motion: false });
      const running = () => onvif.watches - onvif.stops;
      ipcam.checkIpCameras();
      assert.equal(running(), 1, 'only the camera with motion on');
      assert.equal(ipcam.cameraStatuses().find((c) => c.id === body.id)!.motionState, 'off');
      db.prepare("INSERT INTO settings (key, value) VALUES ('server_role', 'backup')").run();
      ipcam.checkIpCameras();
      assert.equal(running(), 0, 'not on a backup server');
      assert.ok(ipcam.cameraStatuses().every((c) => c.motionState !== 'connecting' && c.motionState !== 'watching'));
      db.prepare("DELETE FROM settings WHERE key = 'server_role'").run();
      ipcam.checkIpCameras();
      assert.equal(running(), 1, 'back on the active server');
      db.prepare("INSERT INTO settings (key, value) VALUES ('cameras_enabled', '0')").run();
      ipcam.checkIpCameras();
      assert.equal(running(), 0, 'not with cameras off');
    });

    it('saves a picture and notifies on motion, once per cooldown', async () => {
      await add();
      db.prepare("INSERT INTO settings (key, value) VALUES ('camera_motion_notify', '1')").run();
      ipcam.checkIpCameras();
      onvif.emit!({ active: true, detection: 'person' });
      await new Promise((r) => setTimeout(r, 100));
      const list = snaps.listSnapshots();
      assert.equal(list.length, 1);
      assert.equal(list[0].trigger, 'motion');
      assert.equal(list[0].cameraName, 'RLC-510A');
      assert.deepEqual(pushes.map((p) => p.body), ['RLC-510A saw a person']);
      assert.equal(pushes[0].data?.snapshotId, list[0].id);
      onvif.emit!({ active: true, detection: null });
      onvif.emit!({ active: false, detection: null });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(snaps.listSnapshots().length, 1, 'within the cooldown');
      const status = ipcam.cameraStatuses()[0];
      assert.equal(status.motionState, 'watching');
      assert.ok(status.lastMotionAt);
    });

    it('ignores motion while automations are paused or motion snapshots are off', async () => {
      const { body } = await add();
      db.prepare("INSERT INTO settings (key, value) VALUES ('automations_paused', '1')").run();
      assert.equal(await ipcam.handleMotion(body.id, { active: true, detection: null }), null);
      db.prepare("DELETE FROM settings WHERE key = 'automations_paused'").run();
      db.prepare("INSERT INTO settings (key, value) VALUES ('camera_motion_snapshots', '0')").run();
      assert.equal(await ipcam.handleMotion(body.id, { active: true, detection: null }), null);
      assert.equal(snaps.listSnapshots().length, 0);
    });

    it('starts a watch that stopped again, waiting longer each time', async () => {
      const { body } = await add();
      ipcam.checkIpCameras();
      onvif.fail!(new Error('subscription failed'));
      const s = ipcam.cameraStatuses()[0];
      assert.equal(s.motionState, 'error');
      assert.equal(s.motionDetail, 'subscription failed');
      ipcam.checkIpCameras(Date.now() + 10_000);
      assert.equal(onvif.watches, 1, 'not yet');
      ipcam.checkIpCameras(Date.now() + 31_000);
      assert.equal(onvif.watches, 2);
      onvif.fail!(new Error('again'));
      ipcam.checkIpCameras(Date.now() + 31_000);
      assert.equal(onvif.watches, 2, 'waits a minute the second time');
      ipcam.checkIpCameras(Date.now() + 61_000);
      assert.equal(onvif.watches, 3);
      // A new login starts the watch afresh.
      cam.pass = onvif.pass = 'new';
      await api('PATCH', `/api/ip-cameras/${body.id}`, { password: 'new' });
      assert.equal(onvif.watches, 4);
    });
  });

  describe('the rest of HomeHub', () => {
    it('shows Cameras in the menu once there is an IP camera', async () => {
      assert.equal((await api('GET', '/api/cameras/settings')).body.ipCameras, 0);
      await add();
      assert.equal((await api('GET', '/api/cameras/settings')).body.ipCameras, 1);
    });

    it('backs cameras up with the password hidden when viewed', async () => {
      await add();
      const file = backup.createBackup('test');
      const viewed = JSON.parse(backup.readMasked(file.name)) as import('../db/json-backup').BackupFile;
      const row = viewed.tables.ip_cameras![0];
      assert.equal(row.password, backup.HIDDEN);
      assert.equal(row.host, '192.0.2.20');
      assert.equal(backup.snapshot().tables.ip_cameras![0].password, 'right', 'kept in the file itself, for restoring');
    });
  });

  describe('ONVIF details', () => {
    it('reads motion from the topics Reolink and Amcrest use, and skips the state sent on subscribing', () => {
      const msg = (topic: string, name: string, value: unknown, op = 'Changed') => ({
        topic: { _: topic }, message: { message: { $: { PropertyOperation: op }, data: { simpleItem: { $: { Name: name, Value: value } } } } },
      });
      assert.deepEqual(client.parseMotion(msg('tns1:RuleEngine/CellMotionDetector/Motion', 'IsMotion', true)), { active: true, detection: null });
      assert.deepEqual(client.parseMotion(msg('tns1:RuleEngine/MyRuleDetector/PeopleDetect', 'State', true)), { active: true, detection: 'person' });
      assert.deepEqual(client.parseMotion(msg('tns1:RuleEngine/MyRuleDetector/VehicleDetect', 'State', 'false')), { active: false, detection: 'vehicle' });
      assert.deepEqual(client.parseMotion(msg('tns1:RuleEngine/MyRuleDetector/DogCatDetect', 'State', true)), { active: true, detection: 'animal' });
      assert.deepEqual(client.parseMotion(msg('tns1:VideoSource/MotionAlarm', 'State', true)), { active: true, detection: null });
      assert.equal(client.parseMotion(msg('tns1:RuleEngine/CellMotionDetector/Motion', 'IsMotion', true, 'Initialized')), null);
      assert.equal(client.parseMotion(msg('tns1:Device/Trigger/DigitalInput', 'LogicalState', true)), null);
      assert.equal(client.parseMotion(msg('tns1:VideoSource/ImageTooDark', 'State', true)), null);
      assert.equal(client.parseMotion(null), null);
      // Several items: the source names come first.
      const multi = { topic: { _: 'tns1:RuleEngine/CellMotionDetector/Motion' }, message: { message: { data: { simpleItem: [{ $: { Name: 'Rule', Value: 'r1' } }, { $: { Name: 'IsMotion', Value: true } }] } } } };
      assert.deepEqual(client.parseMotion(multi), { active: true, detection: null });
    });

    it('reads a camera from its ONVIF search reply', () => {
      const reply = { probeMatches: { probeMatch: {
        XAddrs: 'http://[fe80::1]/onvif/device_service http://192.0.2.20:8000/onvif/device_service',
        scopes: 'onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/Reolink onvif://www.onvif.org/hardware/RLC-510A',
      } } };
      assert.deepEqual(client.parseProbeMatch(reply), { host: '192.0.2.20', port: 8000, name: 'Reolink', model: 'RLC-510A' });
      assert.equal(client.parseProbeMatch({}), null);
    });

    it('sorts library errors into what a person can act on', () => {
      assert.equal(client.classify(new Error('ONVIF SOAP Fault: Sender not Authorized')).problem, 'login');
      assert.equal(client.classify(Object.assign(new Error('connect ECONNREFUSED 192.0.2.20:80'), { code: 'ECONNREFUSED' })).problem, 'unreachable');
      assert.equal(client.classify(new Error('Network timeout')).problem, 'unreachable');
      assert.equal(client.classify(new Error('Wrong ONVIF SOAP response')).problem, 'not-onvif');
      assert.equal(client.classify(new Error('odd')).problem, 'other');
    });

    it('keeps logins out of addresses, and puts them back for the relay', () => {
      assert.equal(client.withoutLogin('rtsp://a:b@192.0.2.20:554/x?y=1'), 'rtsp://192.0.2.20:554/x?y=1');
      assert.equal(ipcam.withLogin('rtsp://192.0.2.20:554/x', 'ad min', 'p@ss:w/rd'), 'rtsp://ad%20min:p%40ss%3Aw%2Frd@192.0.2.20:554/x');
      assert.equal(ipcam.withLogin('rtsp://192.0.2.20/x', '', ''), 'rtsp://192.0.2.20/x');
    });

    it('answers a Digest challenge as RFC 7616 does', () => {
      // RFC 2617's own example.
      const header = auth.digestHeader(
        auth.parseChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"'),
        'GET', '/dir/index.html', 'Mufasa', 'Circle Of Life', '0a4f113b',
      );
      assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
      assert.match(header, /qop=auth, nc=00000001, cnonce="0a4f113b"/);
    });
  });
});
