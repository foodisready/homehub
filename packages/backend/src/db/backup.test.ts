/**
 * Drives runBackup against a real SQLite DB in WAL mode.
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this file
 * stays on its temp DB even under a runner that hoists static imports.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const TMP_BASE   = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-backup-test-'));
const BACKUP_DIR = path.join(TMP_BASE, 'backups');
const today      = () => new Date().toISOString().slice(0, 10);
const todayFile  = () => path.join(BACKUP_DIR, `db-${today()}.sqlite`);

let runBackup: () => void;
let getDb: () => Database.Database;

const addUser = (name: string) =>
  getDb().prepare("INSERT INTO users (name, password_hash, role) VALUES (?, 'x', 'member')").run(name);

function usersInBackup(file: string): string[] {
  const backup = new Database(file, { readonly: true });
  try {
    return (backup.prepare('SELECT name FROM users').all() as { name: string }[]).map((u) => u.name);
  } finally {
    backup.close();
  }
}

describe('runBackup', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP_BASE, 'db.sqlite');
    ({ getDb } = await import('./index'));
    ({ runBackup } = await import('./backup'));
    getDb();
  });

  after(() => {
    getDb().close();
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    getDb().prepare('DELETE FROM users').run();
  });

  it('includes writes still sitting in the WAL', () => {
    addUser('in-wal');
    assert.ok(fs.statSync(`${process.env.DB_PATH}-wal`).size > 0, 'expected an uncheckpointed WAL');

    runBackup();

    assert.deepEqual(usersInBackup(todayFile()), ['in-wal']);
  });

  it('replaces the same-day backup on a second run', () => {
    addUser('first');
    runBackup();
    addUser('second');
    runBackup();

    assert.deepEqual(usersInBackup(todayFile()).sort(), ['first', 'second']);
  });

  it('keeps the seven newest backups and leaves other files alone', () => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    for (let day = 1; day <= 9; day++) {
      fs.writeFileSync(path.join(BACKUP_DIR, `db-2020-01-0${day}.sqlite`), 'old');
    }
    fs.writeFileSync(path.join(BACKUP_DIR, 'notes.txt'), 'keep');

    runBackup();

    const backups = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.sqlite')).sort();
    assert.equal(backups.length, 7);
    assert.equal(backups[0], 'db-2020-01-04.sqlite');
    assert.ok(backups.includes(path.basename(todayFile())));
    assert.ok(fs.existsSync(path.join(BACKUP_DIR, 'notes.txt')));
  });

  it('keeps the earlier backup, cleans up, and does not throw on failure', () => {
    addUser('good');
    runBackup();

    // A directory at the temp path makes the backup fail partway through.
    const tmp = `${todayFile()}.tmp`;
    const realRmSync = fs.rmSync;
    fs.mkdirSync(tmp);
    (fs as { rmSync: typeof fs.rmSync }).rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
      if (String(target) === tmp) return;
      realRmSync(target, options);
    }) as typeof fs.rmSync;

    try {
      assert.doesNotThrow(() => runBackup());
    } finally {
      (fs as { rmSync: typeof fs.rmSync }).rmSync = realRmSync;
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    assert.deepEqual(usersInBackup(todayFile()), ['good']);
  });
});
