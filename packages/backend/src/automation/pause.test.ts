/**
 * Pausing automations, against a temp SQLite DB.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-pause-test-'));

let db: Database.Database;
let pause: typeof import('./pause');
let power: typeof import('../devices/power');
let motion: typeof import('../sensors/motion');
let backup: typeof import('../db/json-backup');
const calls: boolean[] = [];

const sqlite = (minutesFromNow: number) =>
  new Date(Date.now() + minutesFromNow * 60_000).toISOString().slice(0, 19).replace('T', ' ');
const timer = () => (db.prepare('SELECT timer_off_at t FROM devices WHERE id = 1').get() as { t: string | null }).t;

describe('pausing automations', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    pause = await import('./pause');
    power = await import('../devices/power');
    motion = await import('../sensors/motion');
    backup = await import('../db/json-backup');
    (await import('../drivers/registry')).getDriver('kasa').setPower = async (_ip: string, state: boolean) => { calls.push(state); };
  });

  after(() => {
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.pragma('foreign_keys = OFF');
    for (const t of ['motion_rules', 'devices', 'settings', 'users']) db.prepare(`DELETE FROM ${t}`).run();
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO devices (id, alias, ip, driver_type) VALUES (1, 'Kitchen lights', '10.0.0.1', 'kasa')").run();
    calls.length = 0;
    db.prepare("INSERT INTO users (id, name, password_hash, role) VALUES (1, 'admin', 'h', 'admin')").run();
  });

  it('is off until turned on', () => {
    assert.equal(pause.automationsPaused(), false);
    pause.setAutomationsPaused(true);
    assert.equal(pause.automationsPaused(), true);
    pause.setAutomationsPaused(false);
    assert.equal(pause.automationsPaused(), false);
  });

  it("doesn't fire timers while paused, and drops the ones that ran out when resumed", async () => {
    pause.setAutomationsPaused(true);
    db.prepare('UPDATE devices SET override_state = 1, override_until = ?, timer_off_at = ? WHERE id = 1').run(sqlite(-1), sqlite(-1));
    await power.sweepPowerTimers();
    assert.deepEqual(calls, [], 'nothing switched');
    assert.ok(timer());

    pause.setAutomationsPaused(false);
    assert.equal(timer(), null, 'ended quietly instead of switching off on resume');

    db.prepare('UPDATE devices SET override_state = 1, override_until = ?, timer_off_at = ? WHERE id = 1').run(sqlite(30), sqlite(30));
    pause.setAutomationsPaused(true);
    pause.setAutomationsPaused(false);
    assert.ok(timer(), 'a timer still running carries on');
    assert.deepEqual(calls, []);
  });

  it("doesn't turn lights on or off for motion while paused", async () => {
    const rule = motion.createMotionRule('Kitchen sensor', 1, 10, true);
    db.prepare('UPDATE devices SET turned_on_at = ? WHERE id = 1').run(sqlite(-60));
    db.prepare('UPDATE motion_rules SET last_motion_at = ? WHERE id = ?').run(new Date(Date.now() - 60 * 60_000).toISOString(), rule.id);
    pause.setAutomationsPaused(true);

    await motion.sweepMotionRules();
    assert.equal(await motion.handleMotion(rule.token, true), true);
    assert.deepEqual(calls, [], 'not switched off by the sweep, nor on by motion');
    const seen = (db.prepare('SELECT occupied FROM motion_rules WHERE id = ?').get(rule.id) as { occupied: number }).occupied;
    assert.equal(seen, 1, 'the motion is still recorded');

    // Resumed, the same rule acts: the room was empty for an hour before that motion.
    pause.setAutomationsPaused(false);
    db.prepare('UPDATE motion_rules SET occupied = 0, last_motion_at = ? WHERE id = ?').run(new Date(Date.now() - 60 * 60_000).toISOString(), rule.id);
    await motion.sweepMotionRules();
    assert.deepEqual(calls, [false], 'switched off once resumed');
  });

  it("stays out of backups, and a restore keeps this HomeHub's choice", () => {
    pause.setAutomationsPaused(true);
    const data = backup.snapshot();
    assert.ok(!data.tables.settings!.some((r) => r.key === pause.PAUSE_KEY), 'not in the backup');

    // A backup made elsewhere that does carry the setting, unpaused.
    data.tables.settings!.push({ key: pause.PAUSE_KEY, value: '0' });
    backup.applyBackup(data);
    assert.equal(pause.automationsPaused(), true, 'restoring left this HomeHub paused');

    pause.setAutomationsPaused(false);
    data.tables.settings!.find((r) => r.key === pause.PAUSE_KEY)!.value = '1';
    backup.applyBackup(data);
    assert.equal(pause.automationsPaused(), false, "and a paused backup doesn't pause the HomeHub it's restored to");
  });
});
