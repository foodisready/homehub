import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-lock-pin-test-'));
let db: Database.Database;
let lock: typeof import('./lock-pin');
let uid = 0;

describe('wall display PIN', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    lock = await import('./lock-pin');
    const auth = await import('./auth.service');
    uid = (await auth.createUser('Kitchen tablet', 'tablet-password-1', 'member')).id;
  });
  after(() => { db.close(); fs.rmSync(TMP, { recursive: true, force: true }); });
  beforeEach(() => { db.prepare('UPDATE users SET lock_pin = NULL').run(); lock.clearMissesForTests(); });

  it('is kept hashed, and checks right and wrong', async () => {
    assert.equal(lock.hasPin(uid), false);
    await lock.setPin(uid, '2580');
    assert.equal(lock.hasPin(uid), true);
    const stored = (db.prepare('SELECT lock_pin FROM users WHERE id = ?').get(uid) as { lock_pin: string }).lock_pin;
    assert.ok(stored.startsWith('4:$2') && !stored.includes('2580'));
    assert.equal(lock.pinLength(uid), 4);
    await lock.setPin(uid, '258046', '2580');
    assert.equal(lock.pinLength(uid), 6);
    await lock.setPin(uid, '2580', '258046');
    await lock.checkPin(uid, '2580');
    await assert.rejects(lock.checkPin(uid, '1111'), /Wrong PIN\. 4 tries left/);
  });

  it('refuses PINs that are too short, long or easy', async () => {
    await assert.rejects(lock.setPin(uid, '123'), /4 to 8 digits/);
    await assert.rejects(lock.setPin(uid, '123456789'), /4 to 8 digits/);
    await assert.rejects(lock.setPin(uid, '12a4'), /4 to 8 digits/);
    await assert.rejects(lock.setPin(uid, '0000'), /harder to guess/);
    await assert.rejects(lock.setPin(uid, '1234'), /harder to guess/);
    await assert.rejects(lock.setPin(uid, '8765'), /harder to guess/);
  });

  it('slows guessing: after 5 misses, a wait that grows, and a right PIN clears it', async () => {
    await lock.setPin(uid, '2580');
    const t = 1_000_000;
    for (let i = 0; i < 4; i++) await assert.rejects(lock.checkPin(uid, '9999', t), /(try|tries) left/);
    await assert.rejects(lock.checkPin(uid, '9999', t), (e: any) => e.status === 403 && e.retryAfterSeconds === 60);
    // Even the right PIN waits its turn.
    await assert.rejects(lock.checkPin(uid, '2580', t + 30_000), (e: any) => e.status === 429);
    await assert.rejects(lock.checkPin(uid, '9999', t + 61_000), (e: any) => e.retryAfterSeconds === 120);
    await lock.checkPin(uid, '2580', t + 61_000 + 121_000);
    await assert.rejects(lock.checkPin(uid, '9999', t + 400_000), /4 tries left/);
  });

  it('changing or removing it needs the PIN or the account password', async () => {
    await lock.setPin(uid, '2580');
    await assert.rejects(lock.setPin(uid, '1470'), /Wrong PIN/);
    await lock.setPin(uid, '1470', '2580');
    await assert.rejects(lock.removePin(uid, undefined, 'not-it'), /password isn’t right/);
    await lock.removePin(uid, undefined, 'tablet-password-1');
    assert.equal(lock.hasPin(uid), false);
    await assert.rejects(lock.checkPin(uid, '1470'), (e: any) => e.status === 404);
  });

  it('the route answers a wrong PIN with 403, never 401, so the app doesn’t sign the screen out', async () => {
    const express = (await import('express')).default;
    const { lockRouter } = await import('../routes/lock');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { sub: uid, name: 'Kitchen tablet', role: 'member' } as never; next(); });
    app.use('/api/lock', lockRouter);
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/lock`;
      const call = (method: string, body?: unknown, sub = '') => fetch(url + sub, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      assert.deepEqual(await (await call('GET')).json(), { set: false, length: null });
      assert.equal((await call('PUT', { pin: '2580' })).status, 200);
      assert.deepEqual(await (await call('GET')).json(), { set: true, length: 4 });
      const wrong = await call('POST', { pin: '1111' }, '/check');
      assert.equal(wrong.status, 403);
      assert.equal((await call('POST', { pin: '2580' }, '/check')).status, 200);
      assert.equal((await call('DELETE', { current: '9999' })).status, 403);
    } finally {
      server.close();
    }
  });
});
