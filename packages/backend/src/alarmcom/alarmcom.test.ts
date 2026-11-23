/**
 * The alarm system through a fake Alarm.com (no network), against a temp DB.
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this file stays on its temp
 * DB even under a runner that hoists static imports.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type http from 'node:http';
import express from 'express';
import type Database from 'better-sqlite3';
import type { AdcConnector, AdcEvent, AdcSensor, AdcSession, AdcSnapshot, ArmCommand, CodeMethod } from './types';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-alarmcom-test-'));

const sensor = (id: string, name: string, state: AdcSensor['state'], kind: AdcSensor['kind'] = 'door'): AdcSensor =>
  ({ id, name, kind, state, bypassed: false, lowBattery: false, changedAt: null });

const fake = {
  password: 'right',
  needsCode: true,
  code: '123456',
  trust: 'trusted-1',
  signIns: [] as { username: string; trust: string | null }[],
  sent: [] as CodeMethod[],
  reads: 0,
  closes: 0,
  keepAlives: 0,
  readError: null as Error | null,
  /** The next read says the session ended, once. */
  expireOnce: false,
  signInError: null as Error | null,
  snapshot: { partitions: [], sensors: [] } as AdcSnapshot,
  changed: null as ((e: AdcEvent) => void) | null,
  commands: [] as { id: string; command: ArmCommand; bypass: boolean }[],
  commandError: null as Error | null,
  expireCommandOnce: false,
  /** Alarm.com takes this long to answer a command. */
  commandDelayMs: 0,
  /** Alarm.com's activity history, and what reading it does. */
  history: [] as import('./types').AdcHistoryEvent[],
  historyError: null as Error | null,
  historySince: [] as string[],
  /** The partition takes on this state after a command, at the next read. */
  applyCommands: true,
};

let AdcError: typeof import('./types').AdcError;

function session(): AdcSession {
  return {
    async read() {
      fake.reads++;
      if (fake.expireOnce) { fake.expireOnce = false; throw new AdcError('session ended', 'expired'); }
      if (fake.readError) throw fake.readError;
      return structuredClone(fake.snapshot);
    },
    async keepAlive() { fake.keepAlives++; },
    async history(since) {
      fake.historySince.push(since.toISOString());
      if (fake.historyError) throw fake.historyError;
      return fake.history.filter((e) => Date.parse(e.at) >= since.getTime());
    },
    async command(id, command, opts) {
      if (fake.expireCommandOnce) { fake.expireCommandOnce = false; throw new AdcError('session ended', 'expired'); }
      if (fake.commandDelayMs) await new Promise((r) => setTimeout(r, fake.commandDelayMs));
      if (fake.commandError) throw fake.commandError;
      fake.commands.push({ id, command, bypass: opts.bypass });
      if (fake.applyCommands) {
        const p = fake.snapshot.partitions.find((x) => x.id === id)!;
        p.state = command === 'disarm' ? 'disarmed' : command === 'armStay' ? 'armed-stay' : command === 'armAway' ? 'armed-away' : 'armed-night';
      }
    },
    watch(changed) { fake.changed = changed; return () => { fake.changed = null; }; },
    close() { fake.closes++; },
  };
}

const connector: AdcConnector = {
  async signIn(username, password, trust) {
    fake.signIns.push({ username, trust });
    if (fake.signInError) throw fake.signInError;
    if (password !== fake.password) throw new AdcError('Alarm.com didn’t accept that username and password.', 'rejected');
    if (!fake.needsCode || trust === fake.trust) return { kind: 'ok', session: session() };
    return {
      kind: 'code',
      methods: ['sms', 'email'],
      sentTo: null,
      challenge: {
        async send(method) { fake.sent.push(method); return method === 'sms' ? '•••-•••-1234' : 'm•••@example.com'; },
        async verify(code, _method) {
          if (code !== fake.code) throw new AdcError('wrong code', 'rejected');
          return { session: session(), trust: fake.trust };
        },
      },
    };
  },
};

describe('Alarm.com', () => {
  let db: Database.Database;
  let alarm: typeof import('./alarmcom');
  let backup: typeof import('../db/json-backup');
  let pin: typeof import('./alarm-pin');
  let app: http.Server;
  let base: string;

  const api = async (method: string, url: string, body?: unknown, role = 'admin', extra: Record<string, string> = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-role': role, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const pick = (e: { state: string; source: string; userName: string | null; detail: string | null }) => ({ state: e.state, source: e.source, user: e.userName, detail: e.detail });
  const closeAllSensors = () => { for (const x of fake.snapshot.sensors) if (x.state === 'open') x.state = 'closed'; };
  const saved = (key: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;

  /** Signs in without a code, as a HomeHub Alarm.com already trusts. */
  async function signIn(): Promise<void> {
    fake.needsCode = false;
    const r = await api('PUT', '/api/alarm/login', { username: 'home', password: 'right' });
    assert.equal(r.body.step, 'done');
  }

  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    process.env.ALARMCOM_SETTLE_MS = '50';
    process.env.ALARMCOM_CONFIRM_AT = '20,40,80';
    process.env.ALARMCOM_ANSWER_WAIT_MS = '60';
    db = (await import('../db')).getDb();
    AdcError = (await import('./types')).AdcError;
    alarm = await import('./alarmcom');
    backup = await import('../db/json-backup');
    pin = await import('./alarm-pin');
    alarm.setAdcConnectorForTests(connector);
    const { alarmRouter } = await import('../routes/alarm');
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.user = { sub: 1, name: 'Anna', role: (req.headers['x-test-role'] as string) ?? 'admin' } as never;
      next();
    });
    server.use('/api/alarm', alarmRouter);
    await new Promise<void>((ok) => { app = server.listen(0, '127.0.0.1', () => ok()); });
    base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  });

  after(async () => {
    alarm.stopAlarmcom();
    app.closeAllConnections();
    await new Promise<void>((ok) => app.close(() => ok()));
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    alarm.resetAlarmcomState();
    pin.clearAlarmPinMissesForTests();
    db.prepare("DELETE FROM settings WHERE key LIKE 'alarmcom%' OR key = 'server_role'").run();
    db.prepare('DELETE FROM alarm_events').run();
    Object.assign(fake, {
      password: 'right', needsCode: true, code: '123456', trust: 'trusted-1', signIns: [], sent: [], reads: 0, closes: 0, keepAlives: 0,
      readError: null, expireOnce: false, signInError: null, changed: null, commands: [], commandError: null, expireCommandOnce: false, commandDelayMs: 0, applyCommands: true, history: [], historyError: null, historySince: [],
      snapshot: {
        partitions: [{ id: 'p1', name: 'House', state: 'disarmed', pending: null, canNight: false, sensorIds: ['s1', 's2', 's3'] }],
        sensors: [sensor('s1', 'Front Dr', 'closed'), sensor('s2', 'Back Dr', 'open'), sensor('s3', 'Motion', 'idle', 'motion')],
      },
    });
  });

  describe('signing in', () => {
    it('shows nothing until someone signs in', async () => {
      const r = await api('GET', '/api/alarm');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { connection: 'signed-out', detail: null, partitions: [], sensors: [], updatedAt: null, live: false, pinLength: null, recent: [], garage: [] });
      assert.equal(fake.signIns.length, 0);
    });

    it('signs in with the code Alarm.com sends, then trusts this HomeHub', async () => {
      const first = await api('PUT', '/api/alarm/login', { username: 'home', password: 'right' });
      assert.equal(first.status, 200);
      assert.deepEqual(first.body, { step: 'code', methods: ['sms', 'email'], sentTo: null });
      // Nothing is saved until the code is right.
      assert.equal(saved('alarmcom_password'), null);

      const sent = await api('POST', '/api/alarm/login/send', { method: 'sms' });
      assert.deepEqual(sent.body, { sentTo: '•••-•••-1234' });
      assert.deepEqual(fake.sent, ['sms']);

      const wrong = await api('POST', '/api/alarm/login/code', { code: '999999' });
      assert.equal(wrong.status, 422);
      assert.match(wrong.body.error, /code didn’t work/);

      const right = await api('POST', '/api/alarm/login/code', { code: '123 456' });
      assert.equal(right.status, 200);
      assert.equal(right.body.step, 'done');
      assert.equal(right.body.sensors, 3);
      assert.equal(right.body.partitions, 1);
      assert.deepEqual(right.body.account, { username: 'home', signedIn: true, rejected: false, message: null, pinSet: false });
      assert.equal(saved('alarmcom_trust'), 'trusted-1');

      const view = (await api('GET', '/api/alarm')).body;
      assert.equal(view.connection, 'ready');
      assert.equal(view.partitions[0].state, 'disarmed');
      assert.deepEqual(view.sensors.map((s: AdcSensor) => s.state), ['closed', 'open', 'idle']);
      assert.ok(view.updatedAt);
    });

    it('never sends the password back', async () => {
      await signIn();
      const r = await api('GET', '/api/alarm/login');
      assert.deepEqual(r.body, { username: 'home', signedIn: true, rejected: false, message: null, pinSet: false });
      assert.doesNotMatch(JSON.stringify(r.body), /right/);
    });

    it('uses the saved trust for the same account, so Alarm.com skips the code', async () => {
      db.prepare("INSERT INTO settings (key, value) VALUES ('alarmcom_username', 'home'), ('alarmcom_trust', 'trusted-1')").run();
      const r = await api('PUT', '/api/alarm/login', { username: 'home', password: 'right' });
      assert.equal(r.body.step, 'done');
      assert.deepEqual(fake.signIns.at(-1), { username: 'home', trust: 'trusted-1' });
    });

    it('doesn’t offer another account’s trust', async () => {
      db.prepare("INSERT INTO settings (key, value) VALUES ('alarmcom_username', 'home'), ('alarmcom_trust', 'trusted-1')").run();
      const r = await api('PUT', '/api/alarm/login', { username: 'someone-else', password: 'right' });
      assert.equal(r.body.step, 'code');
      assert.deepEqual(fake.signIns.at(-1), { username: 'someone-else', trust: null });
    });

    it('says plainly when the password is wrong, and saves nothing', async () => {
      const r = await api('PUT', '/api/alarm/login', { username: 'home', password: 'wrong' });
      assert.equal(r.status, 422);
      assert.match(r.body.error, /didn’t accept/);
      assert.equal(saved('alarmcom_username'), null);
    });

    it('starts over when the code comes too late or there was no sign-in', async () => {
      const r = await api('POST', '/api/alarm/login/code', { code: '123456' });
      assert.equal(r.status, 410);
    });

    it('checks what it’s sent', async () => {
      assert.equal((await api('PUT', '/api/alarm/login', { username: 'home' })).status, 400);
      assert.equal((await api('PUT', '/api/alarm/login', { username: 'a\nb', password: 'x' })).status, 400);
      assert.equal((await api('POST', '/api/alarm/login/send', { method: 'pigeon' })).status, 400);
      assert.equal((await api('POST', '/api/alarm/login/code', { code: 'abc' })).status, 400);
    });

    it('is for admins; everyone can see the alarm', async () => {
      assert.equal((await api('PUT', '/api/alarm/login', { username: 'home', password: 'right' }, 'member')).status, 403);
      assert.equal((await api('GET', '/api/alarm/login', undefined, 'member')).status, 403);
      assert.equal((await api('DELETE', '/api/alarm/login', undefined, 'member')).status, 403);
      assert.equal((await api('GET', '/api/alarm', undefined, 'member')).status, 200);
    });

    it('forgets the account, the trust and the sensors', async () => {
      await signIn();
      db.prepare("INSERT INTO settings (key, value) VALUES ('alarmcom_trust', 't')").run();
      assert.equal((await api('DELETE', '/api/alarm/login')).status, 204);
      for (const k of ['alarmcom_username', 'alarmcom_password', 'alarmcom_trust']) assert.equal(saved(k), null, k);
      assert.equal((await api('GET', '/api/alarm')).body.connection, 'signed-out');
      assert.ok(fake.closes >= 1);
    });
  });

  describe('reading', () => {
    it('reads on each poll and notes when a sensor changed', async () => {
      await signIn();
      const t0 = Date.now();
      const before = alarm.alarmView().sensors.find((s) => s.id === 's1')!;
      assert.equal(before.changedAt, null);   // no change seen yet

      fake.snapshot.sensors[0].state = 'open';
      await alarm.tick(t0 + alarm.POLL_MS + 1);
      const after = alarm.alarmView().sensors.find((s) => s.id === 's1')!;
      assert.equal(after.state, 'open');
      assert.ok(after.changedAt);
      // An unchanged sensor keeps what it had.
      assert.equal(alarm.alarmView().sensors.find((s) => s.id === 's2')!.changedAt, null);
    });

    it('keeps Alarm.com’s own change time when it gives one', async () => {
      fake.snapshot.sensors[0].changedAt = '2026-11-22T10:00:00.000Z';
      await signIn();
      assert.equal(alarm.alarmView().sensors[0].changedAt, '2026-11-22T10:00:00.000Z');
    });

    it('reads again soon after Alarm.com says something changed', async () => {
      await signIn();
      const reads = fake.reads;
      fake.snapshot.partitions[0].state = 'armed-stay';
      fake.changed!({ kind: 'partition', id: 'p1', state: 'armed-stay' });
      // Shown at once, before any read.
      assert.equal(alarm.alarmView().partitions[0].state, 'armed-stay');
      assert.equal(fake.reads, reads);
      fake.changed!({ kind: 'other' });   // a burst: one read
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(fake.reads, reads + 1);
      // From the keypad or the Alarm.com app: in the history as from outside.
      const r = alarm.alarmView().recent[0];
      assert.deepEqual({ kind: r.kind, state: r.state, source: r.source }, { kind: 'arm', state: 'armed-stay', source: 'outside' });
    });

    it('signs in again once when the session has ended', async () => {
      await signIn();
      const signIns = fake.signIns.length;
      fake.expireOnce = true;
      await alarm.readNow();
      assert.equal(fake.signIns.length, signIns + 1);
      assert.equal(alarm.alarmView().connection, 'ready');
    });

    it('stops at once when Alarm.com refuses the saved password, so it never locks the account', async () => {
      await signIn();
      alarm.resetAlarmcomState();   // as after a restart: no session
      fake.password = 'changed';
      await alarm.readNow();
      const view = alarm.alarmView();
      assert.equal(view.connection, 'expired');
      assert.equal((await api('GET', '/api/alarm/login')).body.rejected, true);
      const tries = fake.signIns.length;
      for (let i = 1; i <= 5; i++) await alarm.tick(Date.now() + i * alarm.POLL_MS * 10);
      assert.equal(fake.signIns.length, tries);
      // Signing in again clears it.
      fake.password = 'right';
      await signIn();
      assert.equal(alarm.alarmView().connection, 'ready');
      assert.equal((await api('GET', '/api/alarm/login')).body.rejected, false);
    });

    it('stops and asks in Settings when Alarm.com wants a new code', async () => {
      await signIn();
      alarm.resetAlarmcomState();
      fake.needsCode = true;   // trust no longer accepted
      await alarm.readNow();
      const view = alarm.alarmView();
      assert.equal(view.connection, 'expired');
      assert.match(view.detail!, /verification code/);
    });

    it('waits longer after each failure, and keeps the last reading meanwhile', async () => {
      await signIn();
      fake.readError = new AdcError('timeout', 'unreachable');
      const t = Date.now();
      await alarm.readNow(t);
      const view = alarm.alarmView();
      assert.equal(view.connection, 'error');
      assert.equal(view.sensors.length, 3);   // still shown, with its time
      const reads = fake.reads;
      await alarm.tick(t + 30_000);   // inside the minute's wait
      assert.equal(fake.reads, reads);
      fake.readError = null;
      await alarm.tick(t + 61_000 + alarm.POLL_MS);
      assert.equal(alarm.alarmView().connection, 'ready');
    });

    it('doesn’t connect on a backup HomeHub', async () => {
      db.prepare("INSERT INTO settings (key, value) VALUES ('alarmcom_username', 'home'), ('alarmcom_password', 'right'), ('server_role', 'backup')").run();
      await alarm.tick(Date.now() + alarm.POLL_MS);
      assert.equal(fake.signIns.length, 0);
      assert.equal(alarm.alarmView().connection, 'standby');
    });

    it('reads when the app opens, but not again within a few seconds', async () => {
      await signIn();
      const reads = fake.reads;
      await api('GET', '/api/alarm');
      assert.equal(fake.reads, reads);   // just read at sign-in
      await alarm.readIfStale(Date.now() + 11_000);
      assert.equal(fake.reads, reads + 1);
    });
  });


  describe('arming and disarming', () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const closeAll = () => { for (const x of fake.snapshot.sensors) if (x.state === 'open') x.state = 'closed'; };

    it('arms with one tap when everything is closed, and logs who did it', async () => {
      closeAll();
      await signIn();
      const r = await api('POST', '/api/alarm/arm', { mode: 'away' }, 'member');
      assert.equal(r.status, 200);
      assert.deepEqual(fake.commands, [{ id: 'p1', command: 'armAway', bypass: false }]);
      assert.equal(r.body.partitions[0].pending, 'armed-away');   // shown as arming until Alarm.com confirms
      await wait(60);
      const v = alarm.alarmView();
      assert.equal(v.partitions[0].state, 'armed-away');
      assert.equal(v.partitions[0].pending, null);
      assert.deepEqual({ state: v.recent[0].state, source: v.recent[0].source, user: v.recent[0].userName }, { state: 'armed-away', source: 'app', user: 'Anna' });
    });

    it('names the open doors and arms only when told to arm anyway, bypassing them', async () => {
      await signIn();
      const first = await api('POST', '/api/alarm/arm', { mode: 'stay' });
      assert.equal(first.status, 409);
      assert.deepEqual(first.body.open, ['Back Dr']);
      assert.equal(first.body.code, 'ALARM_OPEN_SENSORS');
      assert.equal(fake.commands.length, 0);
      const again = await api('POST', '/api/alarm/arm', { mode: 'stay', bypass: true });
      assert.equal(again.status, 200);
      assert.deepEqual(fake.commands, [{ id: 'p1', command: 'armStay', bypass: true }]);
    });

    it('offers night arming only when the panel has it', async () => {
      closeAll();
      await signIn();
      assert.equal((await api('POST', '/api/alarm/arm', { mode: 'night' })).status, 400);
      assert.equal((await api('POST', '/api/alarm/arm', { mode: 'party' })).status, 400);
    });

    it('needs the alarm PIN to disarm', async () => {
      fake.snapshot.partitions[0].state = 'armed-away';
      await signIn();
      const none = await api('POST', '/api/alarm/disarm', { pin: '2580' });
      assert.equal(none.status, 409);
      assert.match(none.body.error, /Set an alarm PIN/);

      assert.equal((await api('PUT', '/api/alarm/pin', { pin: '2580' })).status, 204);
      assert.equal(alarm.alarmView().pinLength, 4);
      const wrong = await api('POST', '/api/alarm/disarm', { pin: '1111' }, 'member');
      assert.equal(wrong.status, 403);
      assert.equal(fake.commands.length, 0);
      const right = await api('POST', '/api/alarm/disarm', { pin: '2580' }, 'member');
      assert.equal(right.status, 200);
      assert.deepEqual(fake.commands, [{ id: 'p1', command: 'disarm', bypass: false }]);
    });

    it('slows guessing after five wrong PINs', async () => {
      fake.snapshot.partitions[0].state = 'armed-away';
      await signIn();
      await pin.setAlarmPin('2580');
      for (let i = 0; i < 5; i++) assert.equal((await api('POST', '/api/alarm/disarm', { pin: '0000' })).status, 403);
      const locked = await api('POST', '/api/alarm/disarm', { pin: '2580' });
      assert.equal(locked.status, 429);
      assert.ok(locked.body.retryAfterSeconds > 0);
      assert.equal(fake.commands.length, 0);
    });

    it('turns down weak PINs, and only admins set it', async () => {
      assert.equal((await api('PUT', '/api/alarm/pin', { pin: '1111' })).status, 400);
      assert.equal((await api('PUT', '/api/alarm/pin', { pin: '1234' })).status, 400);
      assert.equal((await api('PUT', '/api/alarm/pin', { pin: '12' })).status, 400);
      assert.equal((await api('PUT', '/api/alarm/pin', { pin: '2580' }, 'member')).status, 403);
      assert.equal((await api('DELETE', '/api/alarm/pin', undefined, 'member')).status, 403);
    });

    it('never takes a command from the AI assistant server', async () => {
      closeAll();
      await signIn();
      await pin.setAlarmPin('2580');
      const mcp = { 'x-homehub-client': 'mcp' };
      assert.equal((await api('POST', '/api/alarm/arm', { mode: 'away' }, 'admin', mcp)).status, 403);
      assert.equal((await api('POST', '/api/alarm/disarm', { pin: '2580' }, 'admin', mcp)).status, 403);
      assert.equal(fake.commands.length, 0);
    });

    it('shows a command Alarm.com is slow to answer as under way, and credits it when the panel arms', async () => {
      closeAll();
      await signIn();
      fake.commandDelayMs = 150;   // longer than the app waits
      const r = await api('POST', '/api/alarm/arm', { mode: 'stay' }, 'member');
      assert.equal(r.status, 200);
      assert.equal(r.body.partitions[0].pending, 'armed-stay');
      assert.equal(fake.commands.length, 0);   // still waiting on Alarm.com
      await wait(400);
      const v = alarm.alarmView();
      assert.equal(v.partitions[0].state, 'armed-stay');
      assert.equal(v.partitions[0].pending, null);
      assert.deepEqual({ source: v.recent[0].source, user: v.recent[0].userName }, { source: 'app', user: 'Anna' });
    });

    it('notes a slow command that fails later in the history', async () => {
      closeAll();
      await signIn();
      fake.commandDelayMs = 150;
      fake.commandError = new AdcError('Not allowed', 'refused', 422);
      const r = await api('POST', '/api/alarm/arm', { mode: 'stay' });
      assert.equal(r.status, 200);
      await wait(250);
      const v = alarm.alarmView();
      assert.equal(v.partitions[0].pending, null);
      assert.match(v.recent[0].detail!, /^Failed: Alarm.com didn’t arm it/);
    });

    it('keeps waiting, without sending again, when Alarm.com never answers', async () => {
      closeAll();
      await signIn();
      fake.applyCommands = false;
      fake.commandError = new AdcError('no answer', 'unreachable', -1);
      const r = await api('POST', '/api/alarm/arm', { mode: 'away' });
      assert.equal(r.status, 200);
      assert.equal(r.body.partitions[0].pending, 'armed-away');
      assert.equal(fake.signIns.length, 1);   // no sign-in and resend
      await wait(150);
      assert.equal(alarm.alarmView().recent[0].detail, 'Not confirmed by Alarm.com');
    });

    it('says nothing was sent when Alarm.com can’t be reached at all', async () => {
      closeAll();
      await signIn();
      fake.commandError = new AdcError('no connection', 'unreachable');
      const r = await api('POST', '/api/alarm/arm', { mode: 'away' });
      assert.equal(r.status, 503);
      assert.match(r.body.error, /nothing was sent/);
    });

    it('signs in again and sends once more when the session had ended, since Alarm.com turned it away', async () => {
      closeAll();
      await signIn();
      fake.expireCommandOnce = true;
      const r = await api('POST', '/api/alarm/arm', { mode: 'away' });
      assert.equal(r.status, 200);
      assert.equal(fake.commands.length, 1);
      assert.equal(fake.signIns.length, 2);
    });

    it('says so when Alarm.com refuses', async () => {
      closeAll();
      await signIn();
      fake.commandError = new AdcError('Not allowed', 'refused', 422);
      const r = await api('POST', '/api/alarm/arm', { mode: 'away' });
      assert.equal(r.status, 422);
      assert.match(r.body.error, /didn’t arm it/);
    });

    it('logs a command Alarm.com never carried out as not confirmed', async () => {
      closeAll();
      await signIn();
      fake.applyCommands = false;
      await api('POST', '/api/alarm/arm', { mode: 'away' });
      await wait(150);
      const v = alarm.alarmView();
      assert.equal(v.partitions[0].pending, null);
      assert.equal(v.recent[0].detail, 'Not confirmed by Alarm.com');
    });

    it('can’t send anything while not connected', async () => {
      const r = await api('POST', '/api/alarm/arm', { mode: 'away' });
      assert.equal(r.status, 503);
    });
  });

  describe('live changes', () => {
    it('shows a door opening at once and keeps it in the history', async () => {
      await signIn();
      fake.changed!({ kind: 'sensor', id: 's1', state: 'open' });
      const v = alarm.alarmView();
      assert.equal(v.sensors.find((x) => x.id === 's1')!.state, 'open');
      assert.deepEqual({ kind: v.recent[0].kind, name: v.recent[0].name, state: v.recent[0].state }, { kind: 'sensor', name: 'Front Dr', state: 'open' });
    });

    it('keeps a motion sensor quiet after Alarm.com said so, though its readings lag', async () => {
      fake.snapshot.sensors[2].state = 'active';
      await signIn();
      fake.changed!({ kind: 'sensor', id: 's3', state: 'closed' });
      assert.equal(alarm.alarmView().sensors[2].state, 'idle');
      await alarm.readNow(Date.now() + 20_000);
      assert.equal(alarm.alarmView().sensors[2].state, 'idle');   // the read still says active
      fake.changed!({ kind: 'sensor', id: 's3', state: 'open' });
      assert.equal(alarm.alarmView().sensors[2].state, 'active');
    });

    it('shows when each door was last opened and closed', async () => {
      await signIn();
      assert.equal(alarm.alarmView().sensors[0].lastOpened, null);   // nothing seen yet
      fake.changed!({ kind: 'sensor', id: 's1', state: 'open' });
      fake.changed!({ kind: 'sensor', id: 's1', state: 'closed' });
      const s1 = alarm.alarmView().sensors.find((x) => x.id === 's1')!;
      assert.ok(s1.lastOpened && s1.lastClosed);
      assert.ok(s1.lastClosed >= s1.lastOpened);
      assert.equal(alarm.alarmView().sensors.find((x) => x.id === 's2')!.lastOpened, null);
    });

    it('doesn’t fill the history with motion', async () => {
      await signIn();
      fake.changed!({ kind: 'sensor', id: 's3', state: 'open' });
      assert.equal(alarm.alarmView().recent.length, 0);
    });
  });


  describe('Alarm.com’s activity history', () => {
    const ev = (id: string, minsAgo: number, type: string, deviceId: string, extra: Partial<import('./types').AdcHistoryEvent> = {}) =>
      ({ id, at: new Date(Date.now() - minsAgo * 60_000).toISOString(), deviceId, deviceName: '', type, description: '', who: null, ...extra });

    it('fills in door times from the history, even a door opened and closed between readings', async () => {
      fake.history = [ev('M-1', 30, 'OpenedClosed', 's1'), ev('M-2', 20, 'Opened', 's2'), ev('M-3', 10, 'Closed', 's2')];
      await signIn();
      await alarm.readHistory();
      const v = alarm.alarmView();
      const s1 = v.sensors.find((x) => x.id === 's1')!;
      assert.ok(s1.lastOpened && s1.lastClosed);
      assert.equal(s1.lastOpened, fake.history[0].at);   // when it happened, not when HomeHub read it
      const s2 = v.sensors.find((x) => x.id === 's2')!;
      assert.equal(s2.lastOpened, fake.history[1].at);
      assert.equal(s2.lastClosed, fake.history[2].at);
      // The first read looks back a day.
      assert.ok(Date.now() - Date.parse(fake.historySince[0]) > 23 * 3_600_000);
    });

    it('saves each event once, however often it’s read', async () => {
      fake.history = [ev('M-1', 5, 'Opened', 's1')];
      await signIn();
      await alarm.readHistory();
      await alarm.readHistory(Date.now() + 40_000);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM alarm_events WHERE kind = 'sensor'").get() as { n: number }).n, 1);
    });

    it('leaves motion out, and stops noting what it sees itself once the history works', async () => {
      fake.history = [ev('M-1', 5, 'Opened', 's3')];
      await signIn();
      await alarm.readHistory();
      assert.equal(alarm.alarmView().recent.length, 0);
      fake.changed!({ kind: 'sensor', id: 's1', state: 'open' });   // the history will have it
      assert.equal(alarm.alarmView().recent.length, 0);
    });

    it('says who armed it, and credits a command from HomeHub to the person', async () => {
      closeAllSensors();
      await signIn();
      await alarm.readHistory();   // the history works
      fake.history = [ev('M-9', 60, 'ArmedStay', 'p1', { description: 'Armed Stay by Keypad' })];
      await alarm.readHistory(Date.now() + 40_000);
      assert.deepEqual(pick(alarm.alarmView().recent[0]), { state: 'armed-stay', source: 'outside', user: null, detail: 'by Keypad' });

      await api('POST', '/api/alarm/arm', { mode: 'away' }, 'member');
      await new Promise((r) => setTimeout(r, 60));
      fake.history.push(ev('M-10', 0, 'ArmedAway', 'p1', { description: 'Armed Away by Web', who: 'home' }));
      await alarm.readHistory(Date.now() + 80_000);
      assert.deepEqual(pick(alarm.alarmView().recent[0]), { state: 'armed-away', source: 'app', user: 'Anna', detail: null });
      assert.equal(alarm.alarmView().recent.filter((e) => e.state === 'armed-away').length, 1);   // not also noted by HomeHub
    });

    it('goes on noting changes itself when the login can’t read the history', async () => {
      fake.historyError = new AdcError('Not allowed', 'refused', 423);
      await signIn();
      await alarm.readHistory();
      fake.changed!({ kind: 'sensor', id: 's1', state: 'open' });
      assert.equal(alarm.alarmView().recent[0].state, 'open');
      const tries = fake.historySince.length;
      await alarm.readHistory(Date.now() + 60_000);   // waits an hour before trying again
      assert.equal(fake.historySince.length, tries);
    });
  });

  describe('garage doors', () => {
    it('shows a garage door opener with the alarm’s doors, with its times and in Recent', async () => {
      const id = Number(db.prepare("INSERT INTO devices (alias, ip, driver_type) VALUES ('Garage Left', '10.0.0.9', 'meross')").run().lastInsertRowid);
      try {
        closeAllSensors();
        await signIn();
        // Not heard from yet: its state isn't known.
        assert.deepEqual(alarm.alarmView().garage, [{ id, name: 'Garage Left', state: 'unknown', lastOpened: null, lastClosed: null }]);
        const opened = '2026-11-23T15:55:16.739Z', closed = '2026-11-23T15:55:46.738Z';
        const ins = db.prepare("INSERT INTO device_events (device_id, device_alias, kind, state, source, at) VALUES (?, 'Garage Left', ?, ?, 'outside', ?)");
        ins.run(id, 'power', 1, opened);
        ins.run(id, 'power', 0, closed);
        ins.run(id, 'online', 1, '2026-11-23T16:00:00.000Z');   // not an opening
        const cache = await import('../kasa/device.cache');
        cache.noteState(id, true);
        const v = alarm.alarmView();
        assert.equal(v.garage[0].state, 'open');
        assert.equal(v.garage[0].lastClosed, closed);
        assert.ok(v.garage[0].lastOpened! > closed);   // the switch just noted
        assert.deepEqual(v.recent.filter((e) => e.name === 'Garage Left').map((e) => e.state), ['open', 'closed', 'open']);
        // Not an alarm sensor: arming doesn't ask about it.
        const r = await api('POST', '/api/alarm/arm', { mode: 'stay' }, 'member');
        assert.notEqual(r.status, 409);
      } finally {
        db.prepare('DELETE FROM device_events WHERE device_id = ?').run(id);
        db.prepare('DELETE FROM devices WHERE id = ?').run(id);
      }
    });
  });

  describe('backups', () => {
    it('leaves the trust token out and hides the password', async () => {
      db.prepare("INSERT INTO settings (key, value) VALUES ('alarmcom_username', 'home'), ('alarmcom_password', 'right'), ('alarmcom_trust', 'trusted-1')").run();
      const settings = backup.snapshot().tables.settings as { key: string }[];
      assert.ok(settings.some((r) => r.key === 'alarmcom_password'));   // travels, like the Honeywell password: a restored HomeHub can sign in
      assert.ok(!settings.some((r) => r.key === 'alarmcom_trust'));
      const entry = backup.createBackup('test');
      assert.doesNotMatch(backup.readMasked(entry.name), /"right"/);
      backup.deleteBackup(entry.name);
    });
  });
});
