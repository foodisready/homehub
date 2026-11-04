/**
 * Going back a version, and updating, through the updater service. The
 * updater and GitHub are stubbed with a fake fetch; nothing real is called.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import express from 'express';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-switch-test-'));
process.env.DB_PATH = path.join(TMP, 'db.sqlite');
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret';
process.env.HOMEHUB_VERSION = 'v1.1.0';
process.env.WATCHTOWER_HTTP_API_TOKEN = 'update-token';
process.env.WATCHTOWER_URL = 'http://watchtower.test';
process.env.UPDATER_URL = 'http://updater.test';

let updaterUp = true;
let updaterBusy = false;
const updaterCalls: { path: string; auth: string | null; body: unknown }[] = [];
let watchtowerCalls = 0;

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input.toString();
  if (url.includes('api.github.com')) return Response.json({ tag_name: 'v1.2.0' });
  if (url.includes('watchtower.test')) { watchtowerCalls++; return new Response('ok'); }
  if (url.includes('updater.test')) {
    if (!updaterUp) throw new Error('ECONNREFUSED');
    const p = new URL(url).pathname;
    if (p === '/health') return Response.json({ ok: true });
    updaterCalls.push({ path: p, auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (p === '/switch') return updaterBusy ? Response.json({ code: 'BUSY' }, { status: 409 }) : Response.json({ started: true }, { status: 202 });
    if (p === '/status') return Response.json({ busy: false, current: 'v1.1.0', last: { version: 'v1.0.0', ok: false, step: 'download', log: 'secret details' } });
  }
  return originalFetch(input, init);
}) as typeof fetch;

import { getDb } from '../db';
import { authenticate } from '../middleware/auth';
import { issueTokens, type UserRow } from '../auth/auth.service';
import { systemRouter } from './system';
import { compareVersions, noteRunningVersion, previousVersion } from '../system/updater';

let server: http.Server;
let baseUrl: string;
let admin: string;
let member: string;

const call = async (method: string, p: string, token: string, body?: unknown) => {
  const r = await fetch(`${baseUrl}/api/system${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

before(async () => {
  const db = getDb();
  db.prepare("INSERT INTO users (name, password_hash, role) VALUES ('admin1', 'x', 'admin'), ('user1', 'x', 'member')").run();
  admin = issueTokens(db.prepare("SELECT * FROM users WHERE name = 'admin1'").get() as UserRow).accessToken;
  member = issueTokens(db.prepare("SELECT * FROM users WHERE name = 'user1'").get() as UserRow).accessToken;
  // This HomeHub ran v1.0.0, then was updated to v1.1.0.
  noteRunningVersion('v1.0.0');
  noteRunningVersion('v1.1.0');

  const app = express();
  app.use(express.json());
  app.use('/api', authenticate);
  app.use('/api/system', systemRouter);
  await new Promise<void>((r) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`; r(); }); });
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  globalThis.fetch = originalFetch;
  try { getDb().close(); } catch { /* closed */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  updaterUp = true;
  updaterBusy = false;
  updaterCalls.length = 0;
  watchtowerCalls = 0;
});

describe('version history', () => {
  it('remembers the release before this one', () => {
    assert.equal(previousVersion(), 'v1.0.0');
    noteRunningVersion('v1.1.0');   // a restart on the same version changes nothing
    assert.equal(previousVersion(), 'v1.0.0');
    noteRunningVersion('dev');      // nor does a development build
    assert.equal(previousVersion(), 'v1.0.0');
  });

  it('only offers going back to an older version', () => {
    assert.ok(compareVersions('v0.1.9', 'v0.1.13') < 0);
    assert.ok(compareVersions('v1.0.0', 'v0.9.99') > 0);
    assert.equal(compareVersions('v1.2.3', 'v1.2.3'), 0);
  });

  it('offers going back in /version', async () => {
    const r = await call('GET', '/version', member);
    assert.equal(r.body.previous, 'v1.0.0');
    assert.equal(r.body.canSwitch, true);
  });
});

describe('POST /api/system/switch', () => {
  it('goes back to the previous version, after a database copy', async () => {
    const r = await call('POST', '/switch', admin, { version: 'v1.0.0' });
    assert.equal(r.status, 202);
    assert.deepEqual(updaterCalls, [{ path: '/switch', auth: 'Bearer update-token', body: { version: 'v1.0.0' } }]);
    assert.ok(fs.existsSync(path.join(TMP, 'backups', 'before-version-v1.1.0-to-v1.0.0.sqlite')));
  });

  it('only offers the previous and the latest version', async () => {
    assert.equal((await call('POST', '/switch', admin, { version: 'v0.9.0' })).body.code, 'VERSION_NOT_OFFERED');
    assert.equal((await call('POST', '/switch', admin, { version: 'v1.1.0' })).body.code, 'ALREADY_RUNNING');
    assert.equal((await call('POST', '/switch', admin, { version: 'latest' })).status, 400);
    assert.equal((await call('POST', '/switch', admin, { version: 'v1.2.0' })).status, 202);
    assert.equal(updaterCalls.length, 1);
  });

  it('is for admins', async () => {
    assert.equal((await call('POST', '/switch', member, { version: 'v1.0.0' })).status, 403);
    assert.equal(updaterCalls.length, 0);
  });

  it('explains a busy or missing updater', async () => {
    updaterBusy = true;
    assert.equal((await call('POST', '/switch', admin, { version: 'v1.0.0' })).body.code, 'BUSY');
    updaterUp = false;
    const r = await call('POST', '/switch', admin, { version: 'v1.0.0' });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /installer/);
  });

  it('reports the last switch without its log', async () => {
    const r = await call('GET', '/switch-status', admin);
    assert.equal(r.body.last.step, 'download');
    assert.equal(r.body.last.log, undefined);
  });
});

describe('POST /api/system/update with the updater', () => {
  it('switches to the latest release instead of asking Watchtower', async () => {
    const r = await call('POST', '/update', admin);
    assert.equal(r.status, 202);
    assert.deepEqual(updaterCalls.map((c) => c.body), [{ version: 'v1.2.0' }]);
    assert.equal(watchtowerCalls, 0);
  });
});
