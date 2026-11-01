/**
 * Runs the power timers against a real SQLite DB with a stubbed driver.
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this file
 * stays on its temp DB even under a runner that hoists static imports.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-power-test-'));

let db: Database.Database;
let power: typeof import('./power');

const calls: { ip: string; state: boolean }[] = [];
let failing = false;

function addDevice(alias = 'Lamp', ip = '10.0.0.1'): number {
  return Number(db.prepare('INSERT INTO devices (alias, ip) VALUES (?, ?)').run(alias, ip).lastInsertRowid);
}

const device = (id: number) => db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as any;

const endTimer = (id: number) => db.prepare(
  "UPDATE devices SET timer_off_at = datetime('now', '-1 minute'), override_until = datetime('now', '-1 minute') WHERE id = ?"
).run(id);

describe('power timers', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP_BASE, 'db.sqlite');
    const { getDb } = await import('../db');
    const { getDriver } = await import('../drivers/registry');
    power = await import('./power');
    db = getDb();

    getDriver('kasa').setPower = async (ip: string, state: boolean) => {
      if (failing) throw new Error('unreachable');
      calls.push({ ip, state });
    };
  });

  after(() => {
    db.close();
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.prepare('DELETE FROM devices').run();
    db.prepare('DELETE FROM sensors').run();
    calls.length = 0;
    failing = false;
  });

  it('stores the turn-off time in the database', async () => {
    const id = addDevice();
    await power.applyPower(device(id), true, 60);

    const row = device(id);
    assert.deepEqual(calls, [{ ip: '10.0.0.1', state: true }]);
    assert.ok(row.timer_off_at);
    assert.equal(row.timer_off_at, row.override_until);
    assert.equal(row.override_state, 1);
  });

  it('leaves a device on before its timer ends', async () => {
    const id = addDevice();
    await power.applyPower(device(id), true, 60);
    calls.length = 0;

    await power.sweepPowerTimers();

    assert.deepEqual(calls, []);
    assert.ok(device(id).timer_off_at);
  });

  it('turns the device off when the timer ends, then clears it', async () => {
    const id = addDevice();
    await power.applyPower(device(id), true, 60);
    endTimer(id);
    calls.length = 0;

    await power.sweepPowerTimers();

    const row = device(id);
    assert.deepEqual(calls, [{ ip: '10.0.0.1', state: false }]);
    assert.equal(row.timer_off_at, null);
    assert.equal(row.override_until, null);
    assert.equal(row.override_state, null);
    assert.equal(row.turned_on_at, null);
  });

  it('turns off a device whose timer ended while the backend was down', async () => {
    const id = addDevice();
    db.prepare("UPDATE devices SET timer_off_at = datetime('now', '-3 hours') WHERE id = ?").run(id);

    await power.sweepPowerTimers();

    assert.deepEqual(calls, [{ ip: '10.0.0.1', state: false }]);
  });

  it('keeps retrying while the device is unreachable', async () => {
    const id = addDevice();
    await power.applyPower(device(id), true, 60);
    endTimer(id);
    calls.length = 0;

    failing = true;
    await power.sweepPowerTimers();
    assert.ok(device(id).timer_off_at);

    failing = false;
    await power.sweepPowerTimers();
    assert.deepEqual(calls, [{ ip: '10.0.0.1', state: false }]);
    assert.equal(device(id).timer_off_at, null);
  });

  it('does not store a timer when the device could not be turned on', async () => {
    const id = addDevice();
    failing = true;

    await assert.rejects(power.applyPower(device(id), true, 60));

    assert.equal(device(id).timer_off_at, null);
  });

  it('replaces the timer when the device is switched without a duration', async () => {
    const id = addDevice();
    await power.applyPower(device(id), true, 60);

    await power.applyPower(device(id), false);
    const row = device(id);
    assert.equal(row.timer_off_at, null);
    assert.equal(row.override_until, null);

    await power.applyPower(device(id), true, 60);
    await power.applyPower(device(id), true);
    assert.equal(device(id).timer_off_at, null);
  });

  it('does not turn off a device when an old override lapses', async () => {
    const id = addDevice();
    db.prepare("UPDATE devices SET override_state = 1, override_until = datetime('now', '-3 hours') WHERE id = ?").run(id);

    await power.sweepPowerTimers();

    const row = device(id);
    assert.deepEqual(calls, []);
    assert.equal(row.override_until, null);
    assert.equal(row.override_state, null);
  });

  it('keeps a device off without a timer', () => {
    const id = addDevice();
    power.setOverride(id, false, 60);

    const row = device(id);
    assert.equal(row.override_state, 0);
    assert.ok(row.override_until);
    assert.equal(row.timer_off_at, null);
  });

  it('protects a device by setting, by name or by shutoff link', () => {
    const named = addDevice('Main Valve', '10.0.0.1');
    const linked = addDevice('Water', '10.0.0.2');
    const lamp = addDevice('Lamp', '10.0.0.3');
    db.prepare("INSERT INTO sensors (sensor_id, type, alias, config) VALUES ('s1', 'flow', 'Meter', ?)")
      .run(JSON.stringify({ shutoffDeviceId: linked }));

    const heater = addDevice('Heater', '10.0.0.4');
    db.prepare('UPDATE devices SET is_protected = 1 WHERE id = ?').run(heater);

    assert.equal(power.isProtectedDevice(device(named)), true);
    assert.equal(power.isProtectedDevice(device(linked)), true);
    assert.equal(power.isProtectedDevice(device(heater)), true);
    assert.equal(power.isProtectedDevice(device(lamp)), false);
  });
});
