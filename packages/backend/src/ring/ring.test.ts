/**
 * Ring cameras through a fake Ring (no network), against a temp DB and a temp
 * snapshots folder.
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this file
 * stays on its temp DB even under a runner that hoists static imports.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type http from 'node:http';
import express from 'express';
import type Database from 'better-sqlite3';
import type { LiveSession, RingCam, RingConnector, RingEvent, SignInResult } from './ring-client';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-ring-test-'));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

class FakeCam implements RingCam {
  listeners: ((e: RingEvent) => void)[] = [];
  snapshots: (string | undefined)[] = [];
  failSnapshot = false;
  constructor(
    public id: number, public name: string, public model = 'Wired Doorbell Plus',
    public isDoorbell = true, public hasBattery = false, public offline = false,
    public home: string | null = 'Home',
  ) {}
  async snapshot(uuid?: string): Promise<Buffer> {
    this.snapshots.push(uuid);
    if (this.failSnapshot) throw new Error('no picture');
    return JPEG;
  }
  onEvent(listener: (e: RingEvent) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }
  emit(e: RingEvent): void { for (const l of this.listeners) l(e); }
  offers: string[] = [];
  ended = 0;
  liveError: Error | null = null;
  async startLive(offer: string): Promise<LiveSession> {
    if (this.liveError) throw this.liveError;
    this.offers.push(offer);
    return { answer: 'v=0\r\nanswer', end: async () => { this.ended++; } };
  }
}

const fake = {
  needsCode: true,
  code: '123456',
  token: 'token-1',
  connects: [] as string[],
  disconnects: 0,
  connectError: null as Error | null,
  cams: [] as FakeCam[],
  onToken: null as ((t: string) => void) | null,
  badPassword: false,
};

let AuthError: typeof import('./ring-client').RingAuthError;

const connector: RingConnector = {
  async signIn(email, password) {
    if (fake.badPassword || password !== 'right') throw new AuthError("Ring didn't accept that email and password.");
    const result: SignInResult = fake.needsCode ? { done: false, prompt: 'sent to ***-1234 via sms' } : { done: true, token: fake.token };
    return {
      result,
      pending: {
        async submitCode(code) {
          if (code !== fake.code) throw new AuthError("That code didn't work. Check it and try again, or start over for a new code.");
          return { done: true, token: fake.token };
        },
      },
    };
  },
  connect(token, onToken) {
    fake.connects.push(token);
    fake.onToken = onToken;
    return {
      cameras: async () => { if (fake.connectError) throw fake.connectError; return fake.cams; },
      disconnect: () => { fake.disconnects++; },
    };
  },
};

describe('Ring cameras', () => {
  let db: Database.Database;
  let ring: typeof import('./ring');
  let snaps: typeof import('../cameras/snapshots');
  let health: typeof import('../system/health');
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
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const door = () => fake.cams[0];
  const event = (over: Partial<RingEvent> = {}): RingEvent => ({ kind: 'ding', id: `e${Math.random()}`, at: Date.now(), ...over });

  async function signInAndAdd(): Promise<void> {
    db.prepare("INSERT INTO settings (key, value) VALUES ('ring_token', 'token-1')").run();
    await ring.checkRing();
    await ring.addCamera(1);
  }

  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    process.env.RING_MOTION_CLEAR_MS = '40';
    process.env.RING_LIVE_MAX_MS = '60';
    db = (await import('../db')).getDb();
    AuthError = (await import('./ring-client')).RingAuthError;
    ring = await import('./ring');
    snaps = await import('../cameras/snapshots');
    health = await import('../system/health');
    backup = await import('../db/json-backup');
    ring.setRingConnectorForTests(connector);
    ring.setPushForTests((title, body, data) => { pushes.push({ title, body, data }); });
    const { ringRouter } = await import('../routes/ring');
    const { camerasRouter } = await import('../routes/cameras');
    const { motionRouter } = await import('../routes/motion');
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.user = { userId: 1, username: 't', role: (req.headers['x-test-role'] as string) ?? 'admin' } as never;
      next();
    });
    server.use('/api/ring', ringRouter);
    server.use('/api/cameras', camerasRouter);
    server.use('/api/motion', motionRouter);
    await new Promise<void>((ok) => { app = server.listen(0, '127.0.0.1', () => ok()); });
    base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  });

  after(async () => {
    ring.stopRing();
    app.closeAllConnections();
    await new Promise<void>((ok) => app.close(() => ok()));
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    ring.resetRingState();
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM camera_snapshots').run();
    db.prepare('DELETE FROM motion_rules').run();
    db.prepare('DELETE FROM devices').run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'ring%' OR key LIKE 'camera%' OR key IN ('server_role', 'automations_paused')").run();
    db.pragma('foreign_keys = ON');
    fs.rmSync(snaps.snapshotDir(), { recursive: true, force: true });
    Object.assign(fake, { needsCode: true, code: '123456', token: 'token-1', connects: [], disconnects: 0, connectError: null, onToken: null, badPassword: false });
    fake.cams = [new FakeCam(1, 'Front Door'), new FakeCam(2, 'Garage', 'Stick Up Cam', false, true)];
    pushes.length = 0;
  });

  describe('signing in', () => {
    it('signs in with the code Ring sends, and keeps only the token', async () => {
      const first = await api('POST', '/api/ring/login', { email: 'me@example.com', password: 'right' });
      assert.equal(first.status, 200);
      assert.deepEqual(first.body, { signedIn: false, codeSentTo: 'sent to ***-1234 via sms' });
      assert.equal((await api('GET', '/api/ring')).body.state, 'signed-out');

      const wrong = await api('POST', '/api/ring/login/code', { code: '999999' });
      assert.equal(wrong.status, 422);
      assert.match(wrong.body.error, /code didn't work/);

      const ok = await api('POST', '/api/ring/login/code', { code: '123 456' });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.body, { signedIn: true });
      const saved = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ring%'").all();
      assert.deepEqual(saved, [{ key: 'ring_token', value: 'token-1' }]);   // no email, no password
      await ring.checkRing();
      assert.equal((await api('GET', '/api/ring')).body.state, 'ready');
      assert.deepEqual(fake.connects, ['token-1']);
    });

    it('signs straight in when Ring asks for no code', async () => {
      fake.needsCode = false;
      const res = await api('POST', '/api/ring/login', { email: 'me@example.com', password: 'right' });
      assert.deepEqual(res.body, { signedIn: true });
      assert.equal(ring.signedIn(), true);
    });

    it('says when Ring refuses the password', async () => {
      const res = await api('POST', '/api/ring/login', { email: 'me@example.com', password: 'wrong' });
      assert.equal(res.status, 422);
      assert.match(res.body.error, /didn't accept/);
      assert.equal(ring.signedIn(), false);
    });

    it('needs a code sign-in to have started', async () => {
      const res = await api('POST', '/api/ring/login/code', { code: '123456' });
      assert.equal(res.status, 422);
      assert.match(res.body.error, /expired/);
    });

    it('checks what it is given', async () => {
      assert.equal((await api('POST', '/api/ring/login', { email: 'me@example.com' })).status, 400);
      assert.equal((await api('POST', '/api/ring/login/code', { code: 'abc' })).status, 400);
    });

    it('is for admins, though anyone can see the cameras', async () => {
      assert.equal((await api('POST', '/api/ring/login', { email: 'a@b.c', password: 'right' }, 'user')).status, 403);
      assert.equal((await api('GET', '/api/ring/account', undefined, 'user')).status, 403);
      assert.equal((await api('GET', '/api/ring', undefined, 'user')).status, 200);
    });

    it('saves the new token each time Ring replaces it, but not after signing out', async () => {
      await signInAndAdd();
      fake.onToken!('token-2');
      assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'ring_token'").pluck().get(), 'token-2');
      const out = await api('DELETE', '/api/ring/login');
      assert.equal(out.body.state, 'signed-out');
      assert.equal(fake.disconnects, 1);
      fake.onToken!('token-3');
      assert.equal(ring.signedIn(), false);
      // Added cameras stay listed, for signing in again.
      assert.deepEqual(ring.addedCameras().map((c) => c.name), ['Front Door']);
    });

    it('stops at a sign-in Ring no longer accepts, and says so on Health', async () => {
      db.prepare("INSERT INTO settings (key, value) VALUES ('ring_token', 'old')").run();
      fake.connectError = new AuthError("Ring no longer accepts HomeHub's sign-in. Sign in to Ring again.");
      const now = Date.now();
      await ring.checkRing(now);
      assert.equal(ring.ringState().state, 'expired');
      // Waits before trying again.
      await ring.checkRing(now + 1000);
      assert.equal(fake.connects.length, 1);
      await ring.checkRing(now + 61_000);
      assert.equal(fake.connects.length, 2);
      const item = (await health.checkHealth({ probe: async () => true })).items.find((i) => i.id === 'ring');
      assert.equal(item?.level, 'warn');
      assert.match(item!.detail, /Sign in to Ring again/);
    });

    it('waits on a backup server, and connects once it is made active', async () => {
      db.prepare("INSERT INTO settings (key, value) VALUES ('ring_token', 'token-1'), ('server_role', 'backup')").run();
      await ring.checkRing();
      assert.equal(ring.ringState().state, 'standby');
      assert.deepEqual(fake.connects, []);
      assert.equal((await health.checkHealth({ probe: async () => true })).items.some((i) => i.id === 'ring'), false);
      db.prepare("UPDATE settings SET value = 'active' WHERE key = 'server_role'").run();
      await ring.checkRing();
      assert.equal(ring.ringState().state, 'ready');
      db.prepare("UPDATE settings SET value = 'dev' WHERE key = 'server_role'").run();
      await ring.checkRing();
      assert.equal(ring.ringState().state, 'standby');
      assert.equal(fake.disconnects, 1);
    });

    it('leaves the token out of backups, and keeps the added cameras in them', async () => {
      await signInAndAdd();
      const keys = (backup.snapshot().tables.settings ?? []).map((r) => r.key);
      assert.equal(keys.includes('ring_token'), false);
      assert.equal(keys.includes('ring_cameras'), true);
    });
  });

  describe('cameras', () => {
    it('lists the account and adds and removes cameras', async () => {
      assert.equal((await api('GET', '/api/ring/account')).status, 409);   // not signed in
      db.prepare("INSERT INTO settings (key, value) VALUES ('ring_token', 'token-1')").run();
      const account = await api('GET', '/api/ring/account');
      assert.equal(account.status, 200);
      assert.deepEqual(account.body.map((c: { name: string; added: boolean }) => [c.name, c.added]), [['Front Door', false], ['Garage', false]]);

      assert.equal((await api('POST', '/api/ring/cameras', { id: 1 })).status, 201);
      assert.equal((await api('POST', '/api/ring/cameras', { id: 99 })).status, 404);
      const listed = await api('GET', '/api/ring');
      assert.equal(listed.body.cameras.length, 1);
      assert.equal(listed.body.cameras[0].name, 'Front Door');
      assert.equal(listed.body.cameras[0].isDoorbell, true);
      assert.equal(listed.body.cameras[0].key, 'ring-1');

      assert.equal((await api('DELETE', '/api/ring/cameras/1')).status, 204);
      assert.equal((await api('DELETE', '/api/ring/cameras/1')).status, 404);
      assert.deepEqual(ring.addedCameras(), []);
    });

    it('follows a rename in the Ring app', async () => {
      await signInAndAdd();
      ring.resetRingState();
      door().name = 'Front Porch';
      await ring.checkRing();
      assert.equal(ring.addedCameras()[0].name, 'Front Porch');
    });

    it('takes a snapshot by hand', async () => {
      await signInAndAdd();
      const res = await api('POST', '/api/ring/cameras/1/snapshots');
      assert.equal(res.status, 201);
      assert.equal(res.body.trigger, 'manual');
      assert.equal(res.body.camera, 'ring-1');
      assert.equal(res.body.deviceId, null);
      door().failSnapshot = true;
      const failed = await api('POST', '/api/ring/cameras/1/snapshots');
      assert.equal(failed.status, 502);
      assert.match(failed.body.error, /No picture from Front Door/);
      assert.equal((await api('POST', '/api/ring/cameras/2/snapshots')).status, 404);   // not added
    });
  });

  describe('doorbell and motion', () => {
    it('saves a picture and notifies when the doorbell rings', async () => {
      await signInAndAdd();
      const snap = await ring.handleEvent(door(), event({ id: 'd1', snapshotUuid: 'uuid-1' }));
      assert.ok(snap);
      assert.equal(snap.trigger, 'doorbell');
      assert.deepEqual(door().snapshots, ['uuid-1']);
      assert.deepEqual(pushes, [{ title: 'Doorbell', body: 'Someone rang Front Door', data: { url: '/cameras', snapshotId: snap.id } }]);
      const listed = await api('GET', '/api/cameras/snapshots?camera=ring-1');
      assert.deepEqual(listed.body.map((s: { id: number; trigger: string }) => [s.id, s.trigger]), [[snap.id, 'doorbell']]);
      const status = (await api('GET', '/api/ring')).body.cameras[0];
      assert.ok(status.lastDingAt);
      assert.equal(status.latestSnapshot.id, snap.id);
    });

    it('arrives through the camera, once per event, and once for presses close together', async () => {
      await signInAndAdd();
      door().emit(event({ id: 'd1' }));
      door().emit(event({ id: 'd1' }));   // the same notification twice
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(pushes.length, 1);
      assert.equal(await ring.handleEvent(door(), event({ id: 'd2' })), null);   // pressed again straight away
      assert.equal(snaps.listSnapshots().length, 1);
    });

    it('tries a fresh picture when Ring has none of the moment', async () => {
      await signInAndAdd();
      let calls = 0;
      door().snapshot = async (uuid?: string) => { calls++; if (uuid) throw new Error('not ready'); return JPEG; };
      assert.ok(await ring.handleEvent(door(), event({ snapshotUuid: 'gone' })));
      assert.equal(calls, 2);
    });

    it('still notifies a doorbell press when there is no picture', async () => {
      await signInAndAdd();
      door().failSnapshot = true;
      assert.equal(await ring.handleEvent(door(), event()), null);
      assert.deepEqual(pushes.map((p) => p.body), ['Someone rang Front Door']);
    });

    it('notes end-to-end encryption, and asks Ring for no picture then', async () => {
      await signInAndAdd();
      assert.equal(await ring.handleEvent(door(), event({ encrypted: true })), null);
      assert.deepEqual(door().snapshots, []);
      assert.equal(pushes.length, 1);
      assert.equal((await api('GET', '/api/ring')).body.cameras[0].encrypted, true);
    });

    it('can leave doorbell notifications off', async () => {
      await signInAndAdd();
      assert.deepEqual((await api('PUT', '/api/ring/settings', { notifyDoorbell: false })).body, { notifyDoorbell: false });
      assert.ok(await ring.handleEvent(door(), event()));
      assert.equal(pushes.length, 0);
      assert.equal((await api('PUT', '/api/ring/settings', { notifyDoorbell: 'no' })).status, 400);
    });

    it('treats motion like Wyze motion: snapshot settings, wait between, notify setting', async () => {
      await signInAndAdd();
      const now = Date.now();
      const first = await ring.handleEvent(door(), event({ kind: 'motion', detection: 'human' }), now);
      assert.equal(first?.trigger, 'motion');
      assert.equal(pushes.length, 0);   // camera notifications are off by default
      assert.equal(await ring.handleEvent(door(), event({ kind: 'motion' }), now + 5_000), null);   // within 30 s
      snaps.saveSettings({ notify: true });
      assert.ok(await ring.handleEvent(door(), event({ kind: 'motion', detection: 'human' }), now + 31_000));
      assert.deepEqual(pushes.map((p) => p.body), ['Front Door saw a person']);
      snaps.saveSettings({ motionSnapshots: false });
      assert.equal(await ring.handleEvent(door(), event({ kind: 'motion' }), now + 99_000), null);
      assert.ok((await api('GET', '/api/ring')).body.cameras[0].lastMotionAt);
    });

    it('ignores motion while automations are paused, but not the doorbell', async () => {
      await signInAndAdd();
      db.prepare("INSERT INTO settings (key, value) VALUES ('automations_paused', '1')").run();
      assert.equal(await ring.handleEvent(door(), event({ kind: 'motion' })), null);
      assert.ok(await ring.handleEvent(door(), event({ kind: 'ding' })));
    });

    it('ignores cameras not added to HomeHub', async () => {
      await signInAndAdd();
      assert.equal(await ring.handleEvent(fake.cams[1], event()), null);
      assert.equal(pushes.length, 0);
    });
  });

  describe('live video', () => {
    it('passes the browser\'s offer to Ring and Ring\'s answer back, and ends it', async () => {
      await signInAndAdd();
      const res = await api('POST', '/api/ring/cameras/1/live', { offer: 'v=0\r\noffer' }, 'user');
      assert.equal(res.status, 200);
      assert.equal(res.body.answer, 'v=0\r\nanswer');
      assert.equal(typeof res.body.sessionId, 'string');
      assert.deepEqual(door().offers, ['v=0\r\noffer']);
      assert.equal(ring.liveCount(), 1);
      assert.equal((await api('DELETE', `/api/ring/live/${res.body.sessionId}`)).status, 204);
      assert.equal(door().ended, 1);
      assert.equal((await api('DELETE', `/api/ring/live/${res.body.sessionId}`)).status, 404);
    });

    it('ends by itself after the time limit, and when HomeHub disconnects', async () => {
      await signInAndAdd();
      await api('POST', '/api/ring/cameras/1/live', { offer: 'v=0' });
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(ring.liveCount(), 0);
      assert.equal(door().ended, 1);
      await api('POST', '/api/ring/cameras/1/live', { offer: 'v=0' });
      await api('DELETE', '/api/ring/login');
      assert.equal(ring.liveCount(), 0);
      assert.equal(door().ended, 2);
    });

    it('says why it can\'t start', async () => {
      await signInAndAdd();
      assert.equal((await api('POST', '/api/ring/cameras/1/live', { offer: 'hello' })).status, 400);
      assert.equal((await api('POST', '/api/ring/cameras/2/live', { offer: 'v=0' })).status, 404);   // not added
      door().liveError = new Error('Live view is currently disabled for Front Door. This camera has been disabled via mode settings in the Ring app.');
      const off = await api('POST', '/api/ring/cameras/1/live', { offer: 'v=0' });
      assert.equal(off.status, 409);
      assert.match(off.body.error, /turned off for Front Door by a mode/);
      door().liveError = new Error('500');
      assert.equal((await api('POST', '/api/ring/cameras/1/live', { offer: 'v=0' })).status, 502);
      door().liveError = null;
      door().offline = true;
      assert.match((await api('POST', '/api/ring/cameras/1/live', { offer: 'v=0' })).body.error, /offline/);
    });
  });

  describe('more than one home', () => {
    it('names the home when two added cameras share a name', async () => {
      fake.cams.push(new FakeCam(3, 'Front Door', 'Battery Doorbell', true, true, false, 'Lake house'));
      await signInAndAdd();
      const account = (await api('GET', '/api/ring/account')).body as { id: number; home: string }[];
      assert.equal(account.find((c) => c.id === 3)?.home, 'Lake house');
      assert.equal((await api('GET', '/api/ring')).body.cameras[0].label, 'Front Door');   // no clash yet
      await api('POST', '/api/ring/cameras', { id: 3 });
      const labels = (await api('GET', '/api/ring')).body.cameras.map((c: { label: string }) => c.label);
      assert.deepEqual(labels, ['Front Door (Home)', 'Front Door (Lake house)']);
      const snap = await ring.handleEvent(fake.cams[2], event());
      assert.equal(snap?.cameraName, 'Front Door (Lake house)');
      assert.deepEqual(pushes.map((p) => p.body), ['Someone rang Front Door (Lake house)']);
    });
  });

  describe('motion rules', () => {
    function ruleWithLight(): number {
      const { lastInsertRowid } = db.prepare("INSERT INTO devices (alias, ip, driver_type) VALUES ('Porch light', '192.0.2.10', 'kasa')").run();
      const res = db.prepare("INSERT INTO motion_rules (name, token, device_id, off_after_minutes) VALUES ('Porch', 'tok', ?, 5)").run(lastInsertRowid);
      return Number(res.lastInsertRowid);
    }

    it('lets a rule use a Ring camera, which reports motion and then clear', async () => {
      await signInAndAdd();
      const id = ruleWithLight();
      assert.equal((await api('PATCH', `/api/motion/${id}`, { ringCameraId: 2 })).status, 400);   // not added
      const set = await api('PATCH', `/api/motion/${id}`, { ringCameraId: 1 });
      assert.equal(set.status, 200);
      assert.equal(set.body.ringCameraId, 1);
      assert.equal(set.body.ringCameraName, 'Front Door');

      await ring.handleEvent(door(), event({ kind: 'motion' }));
      let rule = db.prepare('SELECT occupied, last_motion_at FROM motion_rules WHERE id = ?').get(id) as { occupied: number; last_motion_at: string | null };
      assert.equal(rule.occupied, 1);
      assert.ok(rule.last_motion_at);
      await new Promise((r) => setTimeout(r, 80));
      rule = db.prepare('SELECT occupied FROM motion_rules WHERE id = ?').get(id) as typeof rule;
      assert.equal(rule.occupied, 0);

      // A Ring camera replaces a Shelly Motion: its login goes, its token changes, and "dark" becomes "sun".
      db.prepare("UPDATE motion_rules SET ring_camera_id = NULL, sensor_ip = '192.0.2.20', sensor_password = 'pw', turn_on_when = 'dark' WHERE id = ?").run(id);
      const swapped = await api('PATCH', `/api/motion/${id}`, { ringCameraId: 1 });
      assert.equal(swapped.body.sensorIp, null);
      assert.equal(swapped.body.hasSensorPassword, false);
      assert.equal(swapped.body.turnOnWhen, 'sun');
      assert.notEqual(db.prepare('SELECT token FROM motion_rules WHERE id = ?').pluck().get(id), 'tok');

      // A rename keeps the rule's other fields.
      const renamed = await api('PATCH', `/api/motion/${id}`, { name: 'Front porch' });
      assert.equal(renamed.body.ringCameraId, 1);
      assert.equal((await api('PATCH', `/api/motion/${id}`, { ringCameraId: null })).body.ringCameraId, null);
    });

    it('forgets the camera when it is taken out of HomeHub', async () => {
      await signInAndAdd();
      const id = ruleWithLight();
      await api('PATCH', `/api/motion/${id}`, { ringCameraId: 1 });
      await api('DELETE', '/api/ring/cameras/1');
      assert.equal(db.prepare('SELECT ring_camera_id FROM motion_rules WHERE id = ?').pluck().get(id), null);
    });
  });
});
