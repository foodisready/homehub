/**
 * Matter, end to end: HomeHub pairs a simulated Matter light running in its
 * own process, switches it, hears changes made at the light, survives a
 * restart from the database alone, and unpairs it. Temp DB and storage only.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-matter-test-'));
const FIXTURE = path.join(__dirname, '..', '..', 'test-fixtures', 'matter-light.cjs');

let db: Database.Database;
let light: ChildProcessWithoutNullStreams;
let output = '';
let controller: typeof import('./controller');
let service: typeof import('./service');
let cache: typeof import('../kasa/device.cache');
let registry: typeof import('../drivers/registry');

const waitFor = async (pattern: RegExp, ms = 15000) => {
  const start = Date.now();
  while (!pattern.test(output)) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${pattern}. Light said:\n${output}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return pattern.exec(output)!;
};
const until = async (check: () => boolean, ms = 10000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('Matter devices', { timeout: 120_000 }, () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    controller = await import('./controller');
    service = await import('./service');
    cache = await import('../kasa/device.cache');
    registry = await import('../drivers/registry');

    light = spawn(process.execPath, [FIXTURE, path.join(TMP, 'light'), String(5600 + Math.floor(Math.random() * 300))]);
    light.stdout.on('data', (d) => { output += d; });
    light.stderr.on('data', (d) => { output += d; });
    await waitFor(/READY (\d+)/);
  });

  after(async () => {
    await controller.stopController().catch(() => undefined);
    light?.kill('SIGKILL');   // matter.js traps SIGTERM in the simulated light
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('reads pairing codes as people type them', () => {
    assert.deepEqual(controller.parsePairingCode('3497-011-2332'), controller.parsePairingCode('34970112332'));
    assert.throws(() => controller.parsePairingCode('1234'), /11 digits/);
    assert.throws(() => controller.parsePairingCode('34970112333'), /doesn’t check out/);
    assert.throws(() => controller.parsePairingCode('MT:nonsense'), /isn’t a Matter code/);
  });

  let deviceId = 0;

  it('pairs a device from its code and adds it', async () => {
    const code = (await waitFor(/READY (\d+)/))[1];
    const created = await service.addMatterDevice(`${code.slice(0, 4)}-${code.slice(4, 7)}-${code.slice(7)}`);
    assert.equal(created.length, 1);
    assert.equal(created[0].alias, 'Test light');
    deviceId = created[0].id;
    const row = db.prepare('SELECT ip, driver_type, model, driver_config FROM devices WHERE id = ?').get(deviceId) as Record<string, string>;
    assert.equal(row.driver_type, 'matter');
    assert.match(row.ip, /^matter:\d+:1$/);
    assert.equal(row.model, 'HomeHub Test Test light');
    assert.ok((db.prepare('SELECT COUNT(*) AS n FROM matter_storage').get() as { n: number }).n > 20, 'pairing kept in the database');
  });

  it('switches it, and reads its state', async () => {
    const row = db.prepare('SELECT ip, driver_config FROM devices WHERE id = ?').get(deviceId) as { ip: string; driver_config: string };
    const driver = registry.getDriver('matter');
    await driver.setPower(row.ip, true, JSON.parse(row.driver_config));
    await waitFor(/LIGHT ON/);
    await until(() => cache.getCachedState(deviceId)?.state === true);
    assert.equal(await driver.getPower(row.ip, JSON.parse(row.driver_config)), true);
  });

  it('hears a change made at the light, and records it as from outside', async () => {
    light.stdin.write('toggle\n');
    await waitFor(/LIGHT OFF/);
    await until(() => cache.getCachedState(deviceId)?.state === false);
    const event = db.prepare("SELECT state, source FROM device_events WHERE device_id = ? AND kind = 'power' ORDER BY id DESC LIMIT 1").get(deviceId);
    assert.deepEqual(event, { state: 0, source: 'outside' });
  });

  it('reconnects after a restart, from the database alone', async () => {
    await controller.stopController();
    fs.rmSync(path.join(TMP, 'matter'), { recursive: true, force: true });
    // As if HomeHub had been running an older matter.js: it backs up before starting.
    db.prepare("UPDATE settings SET value = '0.17.0' WHERE key = 'matter_js_version'").run();
    await service.startMatter();
    assert.ok(fs.existsSync(path.join(TMP, 'backups', 'before-matter.js-0.17.0-to-0.18.0.sqlite')), 'backed up before the upgrade');
    const row = db.prepare('SELECT ip, driver_config FROM devices WHERE id = ?').get(deviceId) as { ip: string; driver_config: string };
    await registry.getDriver('matter').setPower(row.ip, true, JSON.parse(row.driver_config));
    await until(() => (output.match(/LIGHT ON/g) ?? []).length === 2);
  });

  it('unpairs it when it is deleted', async () => {
    const nodeId = JSON.parse((db.prepare('SELECT driver_config FROM devices WHERE id = ?').get(deviceId) as { driver_config: string }).driver_config).nodeId;
    db.prepare('DELETE FROM devices WHERE id = ?').run(deviceId);
    service.forgetIfUnused(nodeId);
    await waitFor(/DECOMMISSIONED/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM matter_storage WHERE context LIKE 'nodes.%'").get() as { n: number }).n, 0, 'HomeHub forgot it too');
  });
});
