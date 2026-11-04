/**
 * First-run setup wizard: town search, progress, starter automations and
 * family invites, against a temp DB.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-wizard-test-'));

let server: http.Server;
let base = '';
let db: Database.Database;
let admin = '';
let member = '';
let places: typeof import('../home/places');
let invites: typeof import('../auth/invites');

const call = (method: string, p: string, body?: unknown, token = admin) =>
  fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as Promise<Omit<Response, 'json'> & { json(): Promise<any> }>;   // eslint-disable-line @typescript-eslint/no-explicit-any

describe('first-run setup wizard', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    process.env.SCHEDULER_URL = 'http://127.0.0.1:1';
    db = (await import('../db')).getDb();
    places = await import('../home/places');
    invites = await import('../auth/invites');
    const auth = await import('../auth/auth.service');
    const { authRouter } = await import('./auth');
    const { setupRouter } = await import('./setup');
    const { authenticate } = await import('../middleware/auth');

    admin = auth.issueTokens(await auth.createUser('admin', 'admin-pass', 'admin')).accessToken;
    member = auth.issueTokens(await auth.createUser('kid', 'kid-pass-1', 'member')).accessToken;

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', authRouter);
    app.use('/api', authenticate);
    app.use('/api/setup', setupRouter);
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(() => {
    server.close();
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.pragma('foreign_keys = OFF');
    for (const t of ['devices', 'schedules', 'scenes', 'scene_actions', 'settings', 'invites']) db.prepare(`DELETE FROM ${t}`).run();
    db.pragma('foreign_keys = ON');
  });

  describe('town search', () => {
    it('finds a town as people type it', () => {
      assert.equal(places.searchPlaces('Springfield, IL')[0]?.label, 'Springfield, Illinois, United States');
      assert.equal(places.searchPlaces('springfield, illinois')[0]?.timezone, 'America/Chicago');
      assert.equal(places.searchPlaces('sao paulo')[0]?.name, 'São Paulo');
      assert.equal(places.searchPlaces('Hanoi')[0]?.country, 'Vietnam');
      assert.deepEqual(places.searchPlaces('x'), [], 'one letter is too little to search');
    });

    it('prefers whole names, then towns in the browser\'s time zone', () => {
      const [first] = places.searchPlaces('Portland', { timezone: 'America/New_York' });
      assert.equal(first.region, 'Maine');
      assert.equal(places.searchPlaces('Portland', { timezone: 'America/Los_Angeles' })[0].region, 'Oregon');
      assert.equal(places.searchPlaces('Paris')[0].country, 'France', 'the whole name beats "Parisian"-style prefixes');
    });

    it('guesses the biggest town in a time zone', () => {
      assert.equal(places.biggestPlaceIn('America/New_York')?.name, 'New York City');
      assert.equal(places.biggestPlaceIn('Mars/Olympus'), null);
    });

    it('answers over the API, for admins only', async () => {
      const res = await call('GET', '/api/setup/places?q=Hanoi&tz=Asia/Bangkok');
      assert.equal(res.status, 200);
      assert.equal((await res.json())[0].name, 'Hanoi');
      assert.equal((await call('GET', '/api/setup/places?q=Hanoi', undefined, member)).status, 403);
    });
  });

  describe('progress', () => {
    it('starts a new home at the first step, and leaves existing homes alone', async () => {
      assert.deepEqual(await (await call('GET', '/api/setup')).json().then(({ finished, step }) => ({ finished, step })), { finished: false, step: 'home' });
      db.prepare("INSERT INTO devices (alias, ip) VALUES ('Lamp', '10.0.0.2')").run();
      assert.equal((await (await call('GET', '/api/setup')).json()).finished, true, 'set up before the wizard existed');
    });

    it('remembers the step, even after devices are added', async () => {
      assert.equal((await call('PUT', '/api/setup', { step: 'devices' })).status, 200);
      db.prepare("INSERT INTO devices (alias, ip) VALUES ('Lamp', '10.0.0.2')").run();
      const state = await (await call('GET', '/api/setup')).json();
      assert.equal(state.finished, false);
      assert.equal(state.step, 'devices');
      assert.equal((await call('PUT', '/api/setup', { step: 'nowhere' })).status, 400);
      assert.equal((await call('PUT', '/api/setup', { finished: true })).status, 200);
      assert.equal((await (await call('GET', '/api/setup')).json()).finished, true);
    });
  });

  describe('starter automations', () => {
    let lamp = 0, porch = 0, garage = 0;
    beforeEach(() => {
      const add = db.prepare('INSERT INTO devices (alias, ip, driver_type) VALUES (?, ?, ?)');
      lamp = Number(add.run('Living room lamp', '10.0.0.2', 'kasa').lastInsertRowid);
      porch = Number(add.run('Porch light', '10.0.0.3', 'shelly').lastInsertRowid);
      garage = Number(add.run('Garage door', '10.0.0.4', 'meross').lastInsertRowid);
    });

    it('creates evening, outdoor and goodnight starters together', async () => {
      const res = await call('POST', '/api/setup/starters', { starters: [
        { id: 'evening', deviceIds: [lamp], offTime: '22:30' },
        { id: 'outdoor', deviceIds: [porch] },
        { id: 'goodnight', deviceIds: [lamp, porch] },
      ] });
      assert.equal(res.status, 201);
      assert.deepEqual(await res.json(), { schedules: 4, scenes: ['Goodnight'] });
      const rows = db.prepare('SELECT device_id, trigger_type, cron_expression, solar_event, state FROM schedules ORDER BY id').all();
      assert.deepEqual(rows, [
        { device_id: lamp, trigger_type: 'solar', cron_expression: null, solar_event: 'sunset', state: 1 },
        { device_id: lamp, trigger_type: 'cron', cron_expression: '30 22 * * *', solar_event: null, state: 0 },
        { device_id: porch, trigger_type: 'solar', cron_expression: null, solar_event: 'sunset', state: 1 },
        { device_id: porch, trigger_type: 'solar', cron_expression: null, solar_event: 'sunrise', state: 0 },
      ]);
      const actions = db.prepare('SELECT device_id, state FROM scene_actions ORDER BY device_id').all();
      assert.deepEqual(actions, [{ device_id: lamp, state: 0 }, { device_id: porch, state: 0 }]);
    });

    it('turns midnight into a schedule that runs', async () => {
      await call('POST', '/api/setup/starters', { starters: [{ id: 'evening', deviceIds: [lamp], offTime: '00:00' }] });
      assert.equal((db.prepare("SELECT cron_expression FROM schedules WHERE state = 0").get() as { cron_expression: string }).cron_expression, '0 0 * * *');
    });

    it('refuses protected devices, and creates nothing when any part is wrong', async () => {
      const res = await call('POST', '/api/setup/starters', { starters: [
        { id: 'evening', deviceIds: [lamp] },
        { id: 'outdoor', deviceIds: [garage] },
      ] });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /Garage door is protected/);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM schedules').get() as { n: number }).n, 0);
      assert.equal((await call('POST', '/api/setup/starters', { starters: [{ id: 'evening', deviceIds: [lamp], offTime: '25:00' }] })).status, 400);
      assert.equal((await call('POST', '/api/setup/starters', { starters: [] })).status, 400);
    });

    it('names a second Goodnight scene so it doesn\'t clash', async () => {
      db.prepare("INSERT INTO scenes (name) VALUES ('Goodnight')").run();
      const res = await call('POST', '/api/setup/starters', { starters: [{ id: 'goodnight', deviceIds: [lamp] }] });
      assert.deepEqual((await res.json()).scenes, ['Goodnight 2']);
    });
  });

  describe('family invites', () => {
    it('lets several people join with one code, each with their own login', async () => {
      const { code } = await (await call('POST', '/api/setup/invites')).json();
      assert.equal((await call('POST', '/api/auth/invite', { code }, '')).status, 200);

      const res = await call('POST', '/api/auth/join', { code, username: 'Mom', password: 'mom-pass-1' }, '');
      assert.equal(res.status, 201);
      const joined = await res.json();
      assert.equal(joined.user.role, 'member', 'invites make family logins, never admins');
      assert.ok(joined.accessToken);
      assert.ok(res.headers.get('set-cookie')?.includes('refreshToken'));

      assert.equal((await call('POST', '/api/auth/join', { code, username: 'Dad', password: 'dad-pass-1' }, '')).status, 201);
      const [active] = await (await call('GET', '/api/setup/invites')).json();
      assert.equal(active.uses, 2);
      const stored = db.prepare('SELECT code_hash FROM invites').get() as { code_hash: string };
      assert.notEqual(stored.code_hash, code, 'only a hash is kept');
    });

    it('explains names already taken and short passwords', async () => {
      const { code } = await (await call('POST', '/api/setup/invites')).json();
      const taken = await call('POST', '/api/auth/join', { code, username: 'KID', password: 'whatever-1' }, '');
      assert.equal(taken.status, 409);
      const short = await call('POST', '/api/auth/join', { code, username: 'Gran', password: 'short' }, '');
      assert.equal(short.status, 400);
      assert.equal((await (await call('GET', '/api/setup/invites')).json())[0].uses, 0, 'failed joins don\'t use up places');
    });

    it('stops working when cancelled, expired or used up', async () => {
      const a = await (await call('POST', '/api/setup/invites')).json();
      assert.equal((await call('DELETE', `/api/setup/invites/${a.id}`)).status, 204);
      assert.equal((await call('POST', '/api/auth/invite', { code: a.code }, '')).status, 410);

      const b = invites.createInvite(1, new Date(Date.now() - 25 * 3600_000));
      await assert.rejects(invites.redeemInvite(b.code, 'Late', 'late-pass-1'), /expired/);

      const c = invites.createInvite(1);
      db.prepare('UPDATE invites SET uses = max_uses WHERE id = ?').run(c.id);
      await assert.rejects(invites.redeemInvite(c.code, 'Tenth', 'tenth-pass'), /used up/);
      assert.deepEqual(invites.activeInvites(), []);
      assert.equal((await call('POST', '/api/auth/invite', { code: 'not-a-real-code-at-all' }, '')).status, 404);
    });

    it('only admins make invites', async () => {
      assert.equal((await call('POST', '/api/setup/invites', undefined, member)).status, 403);
    });
  });
});
