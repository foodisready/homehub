/**
 * Keeping a backup HomeHub in step with the active one, against a temp SQLite DB.
 * The active HomeHub's side is tested over HTTP; the backup's with a fake fetch,
 * since one test process has one database.
 *
 * Modules load dynamically in before(), after DB_PATH is set.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-backup-sync-test-'));

let getDb: () => Database.Database;
let sync: typeof import('./backup-sync');
let jb: typeof import('./json-backup');
let routes: typeof import('../routes/backups');

const db = () => getDb();
const TABLES = ['schedules', 'settings', 'devices', 'notification_preferences', 'push_subscriptions', 'users'];
const aliases = () => (db().prepare('SELECT alias FROM devices ORDER BY id').all() as { alias: string }[]).map((r) => r.alias);
const setting = (key: string) => (db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
const setRole = (role: string) => db().prepare(
  "INSERT INTO settings (key, value) VALUES ('server_role', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
).run(role);

function seed(): void {
  const d = db();
  d.prepare("INSERT INTO users (id, name, password_hash, role) VALUES (1, 'admin', 'backup-admin-hash', 'admin')").run();
  d.prepare(`INSERT INTO devices (id, alias, ip, driver_type, driver_config, room)
             VALUES (1, 'Kitchen lights', '192.0.2.1', 'shelly', ?, 'Kitchen')`)
    .run(JSON.stringify({ gen: 1, auth: { user: 'admin', pass: 'shelly-pass' } }));
  d.prepare("INSERT INTO devices (id, alias, ip, driver_type) VALUES (2, 'Porch', '192.0.2.2', 'kasa')").run();
}

/** The active HomeHub's settings, as it would hand them out: one more device, and a family account. */
function activeCopy(changes: (d: Database.Database) => void = () => undefined): string {
  const d = db();
  const was = jb.snapshot();
  d.prepare("INSERT OR REPLACE INTO devices (id, alias, ip, driver_type) VALUES (3, 'Garage', '192.0.2.3', 'kasa')").run();
  d.prepare("UPDATE users SET password_hash = 'active-admin-hash' WHERE name = 'admin'").run();
  d.prepare("INSERT OR IGNORE INTO users (name, password_hash, role) VALUES ('brenden', 'family-hash', 'member')").run();
  changes(d);
  const text = JSON.stringify(jb.snapshot());
  // Back to the backup's own state. A restore keeps accounts, so put those back by hand.
  jb.applyBackup(was);
  d.prepare('DELETE FROM users').run();
  for (const u of was.tables.users!) d.prepare('INSERT INTO users (id, name, password_hash, role) VALUES (?, ?, ?, ?)').run(u.id, u.name, u.password_hash, u.role);
  return text;
}

interface Call { url: string; headers: Record<string, string> }
function fakeFetch(answer: { status: number; text: string } | Error) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    if (answer instanceof Error) throw answer;
    return { status: answer.status, text: async () => answer.text };
  };
  return { calls, fetcher };
}

const CODE = 'ABCD-EFGH-JKMN-PQRS-TWXY';

describe('Backup sync', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP_BASE, 'db.sqlite');
    ({ getDb } = await import('./index'));
    sync = await import('./backup-sync');
    jb = await import('./json-backup');
    routes = await import('../routes/backups');
    getDb();
  });

  after(() => {
    getDb().close();
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  });

  beforeEach(() => {
    db().pragma('foreign_keys = OFF');
    for (const t of TABLES) db().prepare(`DELETE FROM ${t}`).run();
    db().pragma('foreign_keys = ON');
    sync.resetLockout();
    seed();
  });

  describe('on the active HomeHub', () => {
    it('makes a pairing code that only the backup with it can use', () => {
      const { code } = sync.makePairingCode();
      assert.match(code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
      assert.ok(!setting(sync.SERVE_KEY)!.includes(code.replace(/-/g, '')), 'only a hash of the code is kept');

      const served = sync.serveSnapshot(code.toLowerCase().replace(/-/g, ' '), '192.0.2.50');
      assert.equal(served.status, 200, 'typed in any case, spaced any way');
      const copy = served.body as import('./json-backup').BackupFile;
      assert.equal((copy.tables.devices![0].driver_config as { auth: { pass: string } }).auth.pass, 'shelly-pass', 'passwords and keys come along');
      assert.ok(!copy.tables.settings!.some((r) => String(r.key).startsWith('backup_sync')), 'the pairing never travels');
      assert.equal(sync.syncStatus().serving?.last?.address, '192.0.2.50');

      assert.equal(sync.serveSnapshot('WRONG', '192.0.2.66').status, 401);
      assert.equal(sync.serveSnapshot(undefined, '192.0.2.66').status, 401);
    });

    it('a new code or unpairing shuts out the old one', () => {
      const first = sync.makePairingCode().code;
      sync.makePairingCode();
      assert.equal(sync.serveSnapshot(first, 'x').status, 401);
      const second = sync.makePairingCode().code;
      sync.unpair();
      assert.equal(sync.serveSnapshot(second, 'x').status, 401);
    });

    it('stops answering for a while after many wrong codes', () => {
      const { code } = sync.makePairingCode();
      const now = Date.now();
      for (let i = 0; i < 10; i++) sync.serveSnapshot('WRONG', 'x', now);
      assert.equal(sync.serveSnapshot(code, 'x', now + 1000).status, 429, 'even the right code, for now');
      assert.equal(sync.serveSnapshot(code, 'x', now + 11 * 60_000).status, 200);
    });

    it("hands nothing out once it isn't the active one", () => {
      const { code } = sync.makePairingCode();
      setRole('backup');
      assert.equal(sync.serveSnapshot(code, 'x').status, 409);
      assert.throws(() => sync.makePairingCode(), /Only the active HomeHub/);
    });

    it('answers over HTTP, with the code as the key and no login', async () => {
      const express = (await import('express')).default;
      const app = express();
      app.use('/sync', routes.backupSyncPublicRouter);
      const server = http.createServer(app).listen(0);
      await new Promise((r) => server.once('listening', r));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sync/snapshot`;
      try {
        const { code } = sync.makePairingCode();
        const ok = await fetch(url, { headers: { Authorization: `Bearer ${code}` } });
        assert.equal(ok.status, 200);
        assert.equal(ok.headers.get('cache-control'), 'no-store');
        assert.equal(((await ok.json()) as { format: string }).format, 'homehub-backup');
        assert.equal((await fetch(url)).status, 401);
        assert.equal((await fetch(url, { headers: { Authorization: 'Bearer WRONG' } })).status, 401);
      } finally {
        server.close();
      }
    });
  });

  describe('on a backup', () => {
    beforeEach(() => setRole('backup'));

    it('pairs and copies the active HomeHub straight away', async () => {
      const { calls, fetcher } = fakeFetch({ status: 200, text: activeCopy() });
      await sync.follow(CODE.toLowerCase(), '192.0.2.10', fetcher);

      assert.deepEqual(calls.map((c) => c.url), ['http://192.0.2.10:3000/sync/snapshot']);
      assert.equal(calls[0].headers.Authorization, 'Bearer ABCDEFGHJKMNPQRSTWXY');
      assert.deepEqual(aliases(), ['Kitchen lights', 'Porch', 'Garage']);
      const users = db().prepare('SELECT name, password_hash FROM users ORDER BY name').all();
      assert.deepEqual(users, [
        { name: 'admin', password_hash: 'backup-admin-hash' },   // kept as it is here, so you can still sign in
        { name: 'brenden', password_hash: 'family-hash' },       // added from the active HomeHub
      ]);
      assert.equal(setting('server_role'), 'backup', 'still a backup');
      const s = sync.syncStatus();
      assert.equal(s.following?.address, '192.0.2.10');
      assert.equal(s.following?.error, null);
      assert.ok(s.following?.copiedAt);
      assert.ok(!JSON.stringify(s).includes('ABCD'), 'the code is never shown');
    });

    it("doesn't restore again when nothing changed", async () => {
      const text = activeCopy();
      await sync.follow(CODE, '192.0.2.10', fakeFetch({ status: 200, text }).fetcher);
      const copiedAt = sync.syncStatus().following!.copiedAt;
      db().prepare("UPDATE devices SET alias = 'Changed here' WHERE id = 2").run();
      await sync.syncNow(fakeFetch({ status: 200, text }).fetcher);
      assert.ok(aliases().includes('Changed here'), 'left alone');
      assert.equal(sync.syncStatus().following!.copiedAt, copiedAt);

      await sync.syncNow(fakeFetch({ status: 200, text: activeCopy((d) => d.prepare("UPDATE devices SET alias = 'Front porch' WHERE id = 2").run()) }).fetcher);
      assert.deepEqual(aliases(), ['Kitchen lights', 'Front porch', 'Garage'], 'a change on the active HomeHub is copied');
    });

    it('keeps its copy when the active HomeHub is down, refuses the code, or has no devices', async () => {
      const cases: [Parameters<typeof fakeFetch>[0], RegExp][] = [
        [new Error('connect ECONNREFUSED'), /Can't reach the active HomeHub at 192\.0\.2\.10/],
        [{ status: 401, text: '{}' }, /didn't accept the pairing code/],
        [{ status: 409, text: '{}' }, /isn't the active one any more/],
        [{ status: 200, text: 'not json' }, /couldn't be restored/],
        [{ status: 200, text: activeCopy((d) => d.prepare('DELETE FROM devices').run()) }, /has no devices/],
      ];
      await sync.follow(CODE, '192.0.2.10', fakeFetch({ status: 200, text: activeCopy() }).fetcher);
      const copied = aliases();
      for (const [answer, message] of cases) {
        await sync.syncNow(fakeFetch(answer).fetcher);
        assert.deepEqual(aliases(), copied, String(message));
        assert.match(sync.syncStatus().following!.error!, message);
      }
    });

    it("isn't paired when the first copy fails, so the code can be typed again", async () => {
      await assert.rejects(sync.follow(CODE, '192.0.2.10', fakeFetch({ status: 401, text: '{}' }).fetcher), /didn't accept the pairing code/);
      await assert.rejects(sync.follow(CODE, '192.0.2.10', fakeFetch(new Error('timeout')).fetcher), /Can't reach/);
      assert.equal(sync.syncStatus().following, null);
      assert.deepEqual(aliases(), ['Kitchen lights', 'Porch']);
    });

    it('only a backup copies, and only with a well-formed code and a known address', async () => {
      await assert.rejects(sync.follow('too-short', '192.0.2.10'), /20 letters and digits/);
      await assert.rejects(sync.follow(CODE, 'http://evil/'), /should look like/);
      await assert.rejects(sync.follow(CODE), /Can't see the active HomeHub/);

      const { calls, fetcher } = fakeFetch({ status: 200, text: activeCopy() });
      await sync.follow(CODE, '192.0.2.10:3100', fetcher);
      assert.equal(calls[0].url, 'http://192.0.2.10:3100/sync/snapshot', 'a port typed with the address is used');

      setRole('active');
      const later = fakeFetch({ status: 200, text: activeCopy() });
      await sync.syncNow(later.fetcher);
      assert.equal(later.calls.length, 0, 'an active HomeHub is never overwritten');
      await assert.rejects(sync.follow(CODE, '192.0.2.10'), /Only a backup HomeHub/);
    });

    it('stops when asked', async () => {
      await sync.follow(CODE, '192.0.2.10', fakeFetch({ status: 200, text: activeCopy() }).fetcher);
      sync.stopFollowing();
      const later = fakeFetch({ status: 200, text: activeCopy() });
      await sync.syncNow(later.fetcher);
      assert.equal(later.calls.length, 0);
      assert.equal(sync.syncStatus().following, null);
    });
  });
});
