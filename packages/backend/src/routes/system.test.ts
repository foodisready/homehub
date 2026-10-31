/**
 * Tests for the /api/system routes. globalThis.fetch is stubbed to
 * intercept BOTH GitHub Releases lookups (for /version's `latest`)
 * and the watchtower forward (for /update). No real network is hit.
 *
 * Env vars must be set BEFORE importing the route module — its
 * module-level constants snapshot env at load time.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import express from 'express';
import http from 'node:http';

const TMP_DB = path.join(os.tmpdir(), `homehub-system-test-${process.pid}-${Date.now()}.sqlite`);

process.env.DB_PATH                   = TMP_DB;
process.env.JWT_ACCESS_SECRET         = 'test-access-secret-test-access-secret';
process.env.JWT_REFRESH_SECRET        = 'test-refresh-secret-test-refresh-secret';
process.env.HOMEHUB_VERSION           = 'v1.0.0';
process.env.WATCHTOWER_HTTP_API_TOKEN = 'test-token';
process.env.WATCHTOWER_URL            = 'http://watchtower.test';

/* Mock state — toggled per test. */
let releasesTagToReturn:    string | null = 'v1.1.0';
let watchtowerBehavior:     'ok' | 'reject' | 'offline' = 'ok';
let watchtowerLastAuth:     string | null = null;

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input.toString();

  if (url.includes('api.github.com')) {
    return new Response(
      JSON.stringify({ tag_name: releasesTagToReturn }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (url.includes('watchtower.test')) {
    watchtowerLastAuth = init?.headers
      ? (init.headers as Record<string, string>).Authorization ?? null
      : null;
    if (watchtowerBehavior === 'offline') throw new Error('ECONNREFUSED');
    if (watchtowerBehavior === 'reject') return new Response('boom', { status: 500 });
    return new Response('ok', { status: 200 });
  }

  return originalFetch(input, init);
}) as typeof fetch;

import { getDb } from '../db';
import { authenticate } from '../middleware/auth';
import { issueTokens, type UserRow } from '../auth/auth.service';
import { systemRouter } from './system';

let server: http.Server;
let baseUrl: string;
let adminToken: string;
let userToken:  string;

before(async () => {
  getDb();
  const db = getDb();
  db.prepare('INSERT INTO users (name, password_hash, role) VALUES (?, ?, ?)').run('admin1', 'x', 'admin');
  db.prepare('INSERT INTO users (name, password_hash, role) VALUES (?, ?, ?)').run('user1',  'x', 'member');
  const admin = db.prepare('SELECT * FROM users WHERE name = ?').get('admin1') as UserRow;
  const user  = db.prepare('SELECT * FROM users WHERE name = ?').get('user1')  as UserRow;
  adminToken = issueTokens(admin).accessToken;
  userToken  = issueTokens(user).accessToken;

  const app = express();
  app.use(express.json());
  app.use('/api', authenticate);
  app.use('/api/system', systemRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((r) => server?.close(() => r()) ?? r());
  globalThis.fetch = originalFetch;
  try { getDb().close(); } catch { /* already closed */ }
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + ext); } catch { /* not present */ }
  }
});

beforeEach(() => {
  releasesTagToReturn = 'v1.1.0';
  watchtowerBehavior  = 'ok';
  watchtowerLastAuth  = null;
});

describe('GET /api/system/version', () => {
  it('returns running, latest, and updateAvailable=true when versions differ', async () => {
    const r = await fetch(`${baseUrl}/api/system/version`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(r.status, 200);
    const body = await r.json() as Record<string, unknown>;
    assert.equal(body.running, 'v1.0.0');
    assert.equal(body.latest,  'v1.1.0');
    assert.equal(body.updateAvailable, true);
    assert.equal(body.updaterAvailable, true);
  });

  it('serves a stable shape on repeated calls (cache hit branch)', async () => {
    const r1 = await fetch(`${baseUrl}/api/system/version`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const r2 = await fetch(`${baseUrl}/api/system/version`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const b1 = await r1.json() as Record<string, unknown>;
    const b2 = await r2.json() as Record<string, unknown>;
    assert.equal(b1.latest, b2.latest);
  });
});

describe('GET /api/system/remote-url', () => {
  const get = async () => {
    const r = await fetch(`${baseUrl}/api/system/remote-url`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(r.status, 200);
    return r.json();
  };

  it('returns the configured address', async () => {
    process.env.HOMEHUB_REMOTE_URL = 'https://homehub.example.ts.net';
    try {
      assert.deepEqual(await get(), { url: 'https://homehub.example.ts.net' });
    } finally {
      delete process.env.HOMEHUB_REMOTE_URL;
    }
  });

  it('returns null when no address is configured', async () => {
    assert.deepEqual(await get(), { url: null });
  });

  it('requires a login', async () => {
    const r = await fetch(`${baseUrl}/api/system/remote-url`);
    assert.equal(r.status, 401);
  });
});

describe('POST /api/system/update', () => {
  it('forwards to watchtower with bearer token and returns started=true', async () => {
    const r = await fetch(`${baseUrl}/api/system/update`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(r.status, 200);
    const body = await r.json() as Record<string, unknown>;
    assert.equal(body.started, true);
    assert.equal(watchtowerLastAuth, 'Bearer test-token');
  });

  it('returns 502 when watchtower rejects the request', async () => {
    watchtowerBehavior = 'reject';
    const r = await fetch(`${baseUrl}/api/system/update`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(r.status, 502);
    const body = await r.json() as Record<string, unknown>;
    assert.equal(body.code, 'UPDATER_FAILED');
  });

  it('returns 503 when watchtower is unreachable', async () => {
    watchtowerBehavior = 'offline';
    const r = await fetch(`${baseUrl}/api/system/update`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(r.status, 503);
    const body = await r.json() as Record<string, unknown>;
    assert.equal(body.code, 'UPDATER_OFFLINE');
  });

  it('rejects non-admin users with 403', async () => {
    const r = await fetch(`${baseUrl}/api/system/update`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    assert.equal(r.status, 403);
  });
});
