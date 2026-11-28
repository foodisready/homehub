/**
 * PATCH /api/users/:id/password, as Settings → Users sends it. Against a temp SQLite DB; modules load
 * in before(), after DB_PATH is set.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-users-test-'));

let server: http.Server;
let baseUrl: string;
let closeDb: () => void;
let auth: typeof import('../auth/auth.service');
let adminId: number;
let memberId: number;

const patch = (id: number, body: object) => fetch(`${baseUrl}/api/users/${id}/password`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('changing a password', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    const { getDb } = await import('../db');
    auth = await import('../auth/auth.service');
    const { usersRouter } = await import('./users');
    closeDb = () => getDb().close();
    adminId = (await auth.createUser('admin', 'admin-pass-1', 'admin')).id;
    memberId = (await auth.createUser('kitchen', 'old-pass-1', 'member')).id;

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { sub: adminId, name: 'admin', role: 'admin' } as typeof req.user; next(); });
    app.use('/api/users', usersRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('takes the new password as Settings sends it', async () => {
    assert.equal((await patch(memberId, { newPassword: 'kitchen1000' })).status, 204);
    assert.ok(await auth.validateCredentials('kitchen', 'kitchen1000'));
  });

  it('still takes it from a page that sends it as "password"', async () => {
    assert.equal((await patch(memberId, { password: 'kitchen2000' })).status, 204);
    assert.ok(await auth.validateCredentials('kitchen', 'kitchen2000'));
  });

  it('refuses one shorter than 8 characters, and says so plainly', async () => {
    const res = await patch(memberId, { newPassword: 'short' });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'The password must be at least 8 characters.');
    assert.ok(await auth.validateCredentials('kitchen', 'kitchen2000'), 'unchanged');
  });
});
