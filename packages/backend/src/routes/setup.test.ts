/**
 * First-run setup, the MCP server's sign-in, and Settings → Home, against a
 * temp DB.
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this file
 * stays on its temp DB even under a runner that hoists static imports.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-setup-test-'));
const ENV_KEYS = ['ADMIN_PASSWORD', 'INTERNAL_API_KEY', 'LATITUDE', 'LONGITUDE', 'TIMEZONE', 'TZ', 'HOMEHUB_ENV_TZ', 'SCHEDULER_URL'];
const saved: Record<string, string | undefined> = {};

let server: http.Server;
let base = '';
let closeDb: () => void;
let seedAdminIfEmpty: () => Promise<void>;
let getDb: typeof import('../db').getDb;

const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const put = (p: string, body: unknown, token: string) =>
  fetch(`${base}${p}`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const get = (p: string, token?: string) => fetch(`${base}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('first-run setup and home settings', () => {
  before(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    process.env.INTERNAL_API_KEY = 'test-internal';
    process.env.SCHEDULER_URL = 'http://127.0.0.1:1';   // nothing listening; reloads fail quietly
    delete process.env.ADMIN_PASSWORD;
    process.env.LATITUDE = '37.7749'; process.env.LONGITUDE = '-122.4194';   // .env.example's
    process.env.TIMEZONE = 'America/Los_Angeles';
    process.env.TZ = 'America/Los_Angeles';
    delete process.env.HOMEHUB_ENV_TZ;

    const db = await import('../db');
    getDb = db.getDb;
    closeDb = () => db.getDb().close();
    ({ seedAdminIfEmpty } = await import('../auth/auth.service'));
    const { authRouter } = await import('./auth');
    const { internalRouter } = await import('./internal');
    const { homeSettingsRouter } = await import('./home-settings');
    const { authenticate } = await import('../middleware/auth');

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', authRouter);
    app.use('/internal', internalRouter);
    app.use('/api', authenticate);
    app.use('/api/home-settings', homeSettingsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  let adminToken = '';

  it('creates no admin without ADMIN_PASSWORD, and asks for setup', async () => {
    await seedAdminIfEmpty();
    assert.equal((getDb().prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n, 0);
    assert.deepEqual(await (await get('/api/auth/setup')).json(), { needed: true });
  });

  it('gives the MCP server no sign-in until there is an admin', async () => {
    const res = await post('/internal/service-token', {}, { 'x-internal-key': 'test-internal' });
    assert.equal(res.status, 503);
  });

  it('checks the new account', async () => {
    assert.equal((await post('/api/auth/setup', { username: 'jeff', password: 'short' })).status, 400);
    assert.equal((await post('/api/auth/setup', { username: '  ', password: 'long-enough' })).status, 400);
    assert.equal((await post('/api/auth/setup', { username: 'jeff' })).status, 400);
  });

  it('creates the first admin and signs them in, once', async () => {
    const res = await post('/api/auth/setup', { username: ' jeff ', password: 'long-enough' });
    assert.equal(res.status, 201);
    const body = await res.json() as { accessToken: string; user: { name: string; role: string } };
    assert.deepEqual(body.user.name, 'jeff');
    assert.equal(body.user.role, 'admin');
    assert.match(res.headers.get('set-cookie') ?? '', /refreshToken=/);
    adminToken = body.accessToken;

    const again = await post('/api/auth/setup', { username: 'intruder', password: 'long-enough' });
    assert.equal(again.status, 409);
    assert.deepEqual(await (await get('/api/auth/setup')).json(), { needed: false });
    assert.equal((getDb().prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n, 1);
  });

  it('lets two first visitors race without making two admins', async () => {
    getDb().prepare('DELETE FROM users').run();
    const results = await Promise.all([
      post('/api/auth/setup', { username: 'one', password: 'long-enough' }),
      post('/api/auth/setup', { username: 'two', password: 'long-enough' }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal((getDb().prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n, 1);
    adminToken = ((await results.find((r) => r.status === 201)!.json()) as { accessToken: string }).accessToken;
  });

  it('signs the MCP server in as the first admin with the internal key', async () => {
    assert.equal((await post('/internal/service-token', {}, { 'x-internal-key': 'wrong' })).status, 401);
    const res = await post('/internal/service-token', {}, { 'x-internal-key': 'test-internal' });
    assert.equal(res.status, 200);
    const { accessToken } = await res.json() as { accessToken: string };
    assert.equal((await get('/api/home-settings', accessToken)).status, 200);
  });

  it("treats .env.example's location as unset, and falls back to .env's time zone", async () => {
    const s = await (await get('/api/home-settings', adminToken)).json() as Record<string, unknown>;
    assert.equal(s.located, false);
    assert.equal(s.latitude, null);
    assert.equal(s.timezone, 'America/Los_Angeles');
    assert.deepEqual(s.source, { location: 'none', timezone: 'env' });
    assert.equal(s.today, null);
  });

  it('saves the location and time zone, and moves this process to the new zone', async () => {
    const res = await put('/api/home-settings', { latitude: 40.712776, longitude: -74.005974, timezone: 'America/New_York' }, adminToken);
    assert.equal(res.status, 200);
    const s = await res.json() as { latitude: number; longitude: number; timezone: string; located: boolean; today: { sunrise: string } };
    assert.equal(s.latitude, 40.71278);
    assert.equal(s.longitude, -74.00597);
    assert.equal(s.located, true);
    assert.ok(Date.parse(s.today.sunrise) > 0);
    assert.equal(process.env.TZ, 'America/New_York');
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'America/New_York');
    assert.equal(new Date('2026-11-02T20:00:00Z').getHours(), 15);
  });

  it('refuses bad values and leaves the saved ones alone', async () => {
    for (const body of [
      { latitude: 91, longitude: 0 },
      { latitude: 10 },
      { latitude: '', longitude: '' },
      { timezone: 'Mars/Olympus' },
    ]) {
      const res = await put('/api/home-settings', body, adminToken);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const s = await (await get('/api/home-settings', adminToken)).json() as { latitude: number; timezone: string };
    assert.equal(s.latitude, 40.71278);
    assert.equal(s.timezone, 'America/New_York');
  });

  it('lets only admins change them, and only admins see the MCP secret', async () => {
    const { createUser, issueTokens } = await import('../auth/auth.service');
    const member = issueTokens(await createUser('kid', 'long-enough', 'member')).accessToken;
    assert.equal((await get('/api/home-settings', member)).status, 200);
    assert.equal((await put('/api/home-settings', { timezone: 'UTC' }, member)).status, 403);
    assert.equal((await get('/api/home-settings/mcp', member)).status, 403);
    process.env.MCP_SECRET = 'the-mcp-secret';
    assert.deepEqual(await (await get('/api/home-settings/mcp', adminToken)).json(), { secret: 'the-mcp-secret', port: 3001 });
    delete process.env.MCP_SECRET;
  });
});
