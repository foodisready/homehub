/**
 * A backup HomeHub is read-only, against a temp SQLite DB for the role.
 * Modules load dynamically in before(), after DB_PATH is set.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-read-only-test-'));

let getDb: () => Database.Database;
let ro: typeof import('./backup-read-only');

const setRole = (role: string) => getDb().prepare(
  "INSERT INTO settings (key, value) VALUES ('server_role', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
).run(role);

describe('Read-only backup', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP_BASE, 'db.sqlite');
    ({ getDb } = await import('../db'));
    ro = await import('./backup-read-only');
    getDb();
  });

  after(() => {
    getDb().close();
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  });

  it('allows switching by hand, accounts, backups and becoming active; nothing else that changes things', () => {
    const allowed: [string, string][] = [
      ['GET', '/devices'], ['GET', '/schedules'],
      ['POST', '/devices/7/on'], ['POST', '/devices/7/off'], ['POST', '/scenes/3/run'],
      ['POST', '/nlp'], ['POST', '/nlp/stream'],
      ['PUT', '/system/role'], ['POST', '/system/update'], ['PUT', '/system/automations'],
      ['POST', '/backups'], ['POST', '/backups/sync/now'], ['PUT', '/backups/sync/follow'], ['POST', '/backups/x.json/restore'],
      ['PATCH', '/users/2/password'], ['POST', '/users'],
      ['POST', '/push/subscribe'], ['PUT', '/setup'],
      ['POST', '/sensors/4/events/9/ack'], ['POST', '/cameras/12/ptz'],
    ];
    const refused: [string, string][] = [
      ['POST', '/devices'], ['PATCH', '/devices/7'], ['DELETE', '/devices/7'], ['POST', '/devices/discover'],
      ['POST', '/devices/7/override'], ['DELETE', '/devices/7/override'],
      ['POST', '/schedules'], ['PUT', '/schedules/1'], ['DELETE', '/schedules/1'],
      ['POST', '/scenes'], ['PATCH', '/scenes/3'], ['DELETE', '/scenes/3'],
      ['PUT', '/home-settings'], ['POST', '/nlp/teach'], ['PUT', '/nlp/voice'],
      ['POST', '/sensors'], ['PUT', '/sensors/4'], ['POST', '/sensors/4/snooze'],
      ['POST', '/matter/pair'], ['POST', '/kasa/login'], ['PUT', '/cameras/settings'],
      ['POST', '/setup/starters'], ['POST', '/setup/invites'],
      ['POST', '/devices/7/on/extra'], ['POST', '/systemx'],
    ];
    for (const [m, p] of allowed) assert.equal(ro.allowedOnBackup(m, p), true, `${m} ${p}`);
    for (const [m, p] of refused) assert.equal(ro.allowedOnBackup(m, p), false, `${m} ${p}`);
  });

  it('refuses changes only while this HomeHub is a backup', async () => {
    const express = (await import('express')).default;
    const app = express();
    app.use('/api', ro.backupReadOnly);
    app.use('/api', (_req, res) => { res.json({ done: true }); });
    const server = http.createServer(app).listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const call = (method: string, p: string) => fetch(base + p, { method });
    try {
      setRole('backup');
      const refused = await call('PATCH', '/devices/7');
      assert.equal(refused.status, 409);
      const body = await refused.json() as { code: string; error: string };
      assert.equal(body.code, 'BACKUP_READ_ONLY');
      assert.match(body.error, /Make changes on the active HomeHub/);
      assert.equal((await call('POST', '/devices/7/on')).status, 200);
      assert.equal((await call('GET', '/devices')).status, 200);
      assert.equal((await call('PUT', '/system/role')).status, 200, 'it can always become active');

      setRole('active');
      assert.equal((await call('PATCH', '/devices/7')).status, 200, 'unlocked the moment it is active');
      setRole('dev');
      assert.equal((await call('PATCH', '/devices/7')).status, 200, 'a development copy is for trying changes');
    } finally {
      server.close();
    }
  });
});
