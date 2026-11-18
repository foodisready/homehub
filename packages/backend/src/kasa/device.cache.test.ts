/**
 * A backup HomeHub leaves Tuya plugs alone: each check takes the plug's only connection.
 * Against a temp SQLite DB. Modules load in before(), after DB_PATH is set.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-device-cache-test-'));
let db: Database.Database;
let cache: typeof import('./device.cache');
let reads: string[] = [];

describe('checking devices on a backup HomeHub', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    const { getDriver } = await import('../drivers/registry');
    for (const type of ['tuya', 'kasa']) {
      (getDriver(type) as any).getPower = async (ip: string) => { reads.push(`${type} ${ip}`); return true; };
      (getDriver(type) as any).getEnergy = async () => null;
    }
    cache = await import('./device.cache');
    db.prepare("INSERT INTO devices (alias, ip, driver_type, driver_config) VALUES ('Bedside', '10.0.0.38', 'tuya', '{\"deviceId\":\"x\",\"key\":\"y\"}')").run();
    db.prepare("INSERT INTO devices (alias, ip, driver_type) VALUES ('Lamp', '10.0.0.99', 'kasa')").run();
  });

  after(() => {
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  const id = (alias: string) => (db.prepare('SELECT id FROM devices WHERE alias = ?').get(alias) as { id: number }).id;
  const role = (r: string) => db.prepare("INSERT INTO settings (key, value) VALUES ('server_role', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(r);

  it('leaves Tuya plugs alone on a backup, but still checks the others', async () => {
    role('backup');
    reads = [];
    await cache.pollDeviceNow(id('Bedside'));
    await cache.pollDeviceNow(id('Lamp'));
    assert.deepEqual(reads, ['kasa 10.0.0.99']);
  });

  it('checks Tuya plugs on the active HomeHub', async () => {
    role('active');
    reads = [];
    await cache.pollDeviceNow(id('Bedside'));
    assert.deepEqual(reads, ['tuya 10.0.0.38']);
  });
});
