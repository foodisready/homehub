/**
 * Black-box tests for login rate limiting on POST /api/auth/login.
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this file
 * stays on its temp DB even under a runner that hoists static imports.
 */

import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-auth-test-'));
const PASSWORD = 'correct-horse';
const WINDOW_MS = 15 * 60 * 1000;

let server: http.Server;
let baseUrl: string;
let closeDb: () => void;
let resetLoginLimiter: () => void;

function login(username: unknown, password: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body:    JSON.stringify({ username, password }),
  });
}

async function failLogins(username: string, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    assert.equal((await login(username, 'wrong')).status, 401);
  }
}

describe('POST /api/auth/login rate limiting', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP_BASE, 'db.sqlite');

    const { getDb } = await import('../db');
    const { createUser } = await import('../auth/auth.service');
    const { authRouter } = await import('./auth');
    ({ resetLoginLimiter } = await import('../auth/login-limiter'));

    closeDb = () => getDb().close();
    await createUser('alice', PASSWORD, 'admin');
    await createUser('bob', PASSWORD, 'member');

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', authRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  });

  beforeEach(() => resetLoginLimiter());
  afterEach(() => mock.timers.reset());

  it('blocks after five failures, even with the right password', async () => {
    await failLogins('alice', 5);

    const res = await login('alice', PASSWORD);

    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0);
    const body = await res.json() as { error: string; code: string };
    assert.equal(body.code, 'RATE_LIMITED');
    assert.match(body.error, /Try again in 15 minutes/);
  });

  it('allows logins again once the window has passed', async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    await failLogins('alice', 5);
    assert.equal((await login('alice', PASSWORD)).status, 429);

    mock.timers.tick(WINDOW_MS + 1);

    assert.equal((await login('alice', PASSWORD)).status, 200);
  });

  it('does not count successful logins', async () => {
    for (let i = 0; i < 6; i++) {
      assert.equal((await login('alice', PASSWORD)).status, 200);
    }
  });

  it('keeps other accounts usable while one is blocked', async () => {
    await failLogins('alice', 5);

    assert.equal((await login('bob', PASSWORD)).status, 200);
  });

  it('limits guessing across usernames from one address', async () => {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 5; j++) {
        assert.equal((await login(`nobody-${i}`, 'wrong')).status, 401);
      }
    }

    assert.equal((await login('bob', PASSWORD)).status, 429);
  });

  it('holds a parallel burst to the limit', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => login('alice', 'wrong')),
    );

    const statuses = responses.map((r) => r.status).sort();
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429, 429, 429, 429]);
  });

  it('ignores a forged X-Forwarded-For', async () => {
    await failLogins('alice', 5);

    const res = await login('alice', 'wrong', { 'X-Forwarded-For': '203.0.113.9' });

    assert.equal(res.status, 429);
  });

  it('rejects a non-string username without counting it', async () => {
    assert.equal((await login({ name: 'alice' }, 'wrong')).status, 400);
  });
});
