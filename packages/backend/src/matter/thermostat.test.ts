/**
 * Matter thermostats, end to end: HomeHub pairs a simulated thermostat running in its own
 * process, reads it, changes its mode and targets, hears changes made at the thermostat,
 * keeps automation inside the allowed range, and turns it off and back on. Temp DB only.
 *
 * Needs mDNS, which the Mac's command sandbox blocks: run it in the backend's Docker dev image.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-thermostat-test-'));
const FIXTURE = path.join(__dirname, '..', '..', 'test-fixtures', 'matter-thermostat.cjs');

let db: Database.Database;
let device: ChildProcessWithoutNullStreams;
let output = '';
let controller: typeof import('./controller');
let service: typeof import('./service');
let thermostat: typeof import('../thermostat/thermostat');
let registry: typeof import('../drivers/registry');
let cache: typeof import('../kasa/device.cache');

const waitFor = async (pattern: RegExp, ms = 15000) => {
  const start = Date.now();
  while (!pattern.test(output)) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${pattern}. Thermostat said:\n${output}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return pattern.exec(output)!;
};
const eventually = async (check: () => Promise<boolean> | boolean, ms = 10000) => {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};
const say = (line: string) => { device.stdin.write(`${line}\n`); return waitFor(new RegExp(`DONE ${line}`)); };

describe('Matter thermostats', { timeout: 120_000 }, () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    controller = await import('./controller');
    service = await import('./service');
    thermostat = await import('../thermostat/thermostat');
    registry = await import('../drivers/registry');
    cache = await import('../kasa/device.cache');
    device = spawn(process.execPath, [FIXTURE, path.join(TMP, 'thermostat'), String(5900 + Math.floor(Math.random() * 300))]);
    device.stdout.on('data', (d) => { output += d; });
    device.stderr.on('data', (d) => { output += d; });
    await waitFor(/READY (\d+)/);
  });

  after(async () => {
    await controller.stopController().catch(() => undefined);
    device?.kill('SIGKILL');
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  let id = 0;

  it('pairs it as one thermostat device', async () => {
    const code = (await waitFor(/READY (\d+)/))[1];
    const created = await service.addMatterDevice(code);
    assert.equal(created.length, 1);
    assert.equal(created[0].alias, 'Hall thermostat');
    id = created[0].id;
    const config = JSON.parse((db.prepare('SELECT driver_config FROM devices WHERE id = ?').get(id) as { driver_config: string }).driver_config);
    assert.equal(config.kind, 'thermostat');
  });

  it('reads its temperatures, mode, modes and what it is doing', async () => {
    const t = await thermostat.getThermostat(id);
    assert.equal(t.online, true);
    assert.deepEqual([t.temperature, t.heat, t.cool, t.mode, t.running], [21, 20, 26, 'heat', 'heating']);
    assert.deepEqual(t.modes, ['off', 'heat', 'cool', 'auto']);
    assert.equal(t.deadband, 2.5);
    assert.deepEqual(t.comfort, thermostat.DEFAULT_RANGES.comfort, 'the default ranges until set');
    assert.deepEqual((await thermostat.listThermostats()).map((x) => x.id), [id]);
  });

  it('changes its target and mode from the card', async () => {
    await thermostat.changeThermostat(id, { heat: 21.5 }, 'app');
    await waitFor(/HEAT 2150/);
    await thermostat.changeThermostat(id, { mode: 'cool', cool: 24 }, 'app');
    await waitFor(/COOL 2400/);
    await waitFor(/MODE 3/);
    await eventually(async () => (await thermostat.getThermostat(id)).mode === 'cool');
  });

  it('keeps the targets apart in auto', async () => {
    // Cooling is at 24: heating to 23 would leave them 1 °C apart, so cooling moves up to 25.5.
    await thermostat.changeThermostat(id, { mode: 'auto', heat: 23 }, 'app');
    await waitFor(/COOL 2550/);
    await eventually(async () => { const t = await thermostat.getThermostat(id); return t.mode === 'auto' && t.heat === 23 && t.cool === 25.5; });
  });

  it('hears changes made at the thermostat and in the room', async () => {
    await say('room 22.5');
    await eventually(async () => (await thermostat.getThermostat(id)).temperature === 22.5);
    await say('running idle');
    await eventually(async () => (await thermostat.getThermostat(id)).running === 'idle');
    await say('running cool');
    await eventually(async () => (await thermostat.getThermostat(id)).running === 'cooling');
    await say('mode heat');
    await eventually(async () => (await thermostat.getThermostat(id)).mode === 'heat');
  });

  it('keeps Chat, voice and schedules inside the allowed range, but not a person on the card', async () => {
    thermostat.saveRanges(id, { comfort: { low: 20, high: 24 }, allowed: { low: 16, high: 27 } });
    await assert.rejects(thermostat.changeThermostat(id, { heat: 15 }, 'voice'), /outside the range allowed/);
    await assert.rejects(thermostat.changeThermostat(id, { heat: 28 }, 'schedule'), /outside the range allowed/);
    await thermostat.changeThermostat(id, { heat: 17 }, 'chat');
    await waitFor(/HEAT 1700/);
    await thermostat.changeThermostat(id, { heat: 15 }, 'app');
    await waitFor(/HEAT 1500/);
    await assert.rejects(thermostat.changeThermostat(id, { heat: 45 }, 'app'), /can only be set between/, 'never past the thermostat’s own limits');
    await assert.rejects(thermostat.changeThermostat(id, { mode: 'dry' }, 'app'), /can be set to/);
  });

  it('turns off, and back on in the mode it was in', async () => {
    const row = db.prepare('SELECT ip, driver_config FROM devices WHERE id = ?').get(id) as { ip: string; driver_config: string };
    const driver = registry.getDriver('matter');
    await driver.setPower(row.ip, false, JSON.parse(row.driver_config));
    await eventually(async () => (await thermostat.getThermostat(id)).mode === 'off');
    assert.equal(await driver.getPower(row.ip, JSON.parse(row.driver_config)), false);
    await eventually(() => cache.getCachedState(id)?.state === false);
    await driver.setPower(row.ip, true, JSON.parse(row.driver_config));
    await eventually(async () => (await thermostat.getThermostat(id)).mode === 'heat');
  });
});
