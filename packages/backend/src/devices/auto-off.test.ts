/**
 * When devices will turn themselves off, against a temp DB.
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-autooff-test-'));
const NOW = Date.parse('2026-11-02T20:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const sqlTime = (iso: string) => iso.slice(0, 19).replace('T', ' ');

let db: Database.Database;
let autoOff: typeof import('./auto-off');
let cache: typeof import('../kasa/device.cache');

function addDevice(alias: string, on = true, turnedOnMinAgo = 5): number {
  const id = Number(db.prepare('INSERT INTO devices (alias, ip, turned_on_at) VALUES (?, ?, ?)')
    .run(alias, `10.0.0.${alias.length}${Math.floor(Math.random() * 100)}`, on ? sqlTime(ago(turnedOnMinAgo)) : null).lastInsertRowid);
  cache.getAllCachedStates().set(id, { state: on, wattage: null, online: true, lastPolled: new Date(NOW) });
  return id;
}

function addRule(deviceId: number, opts: { occupied: boolean; lastMotionMinAgo: number; minutes?: number }): void {
  db.prepare(`INSERT INTO motion_rules (name, token, device_id, off_after_minutes, occupied, last_motion_at)
              VALUES ('Kitchen sensor', ?, ?, ?, ?, ?)`)
    .run(`t${deviceId}`, deviceId, opts.minutes ?? 10, opts.occupied ? 1 : 0, ago(opts.lastMotionMinAgo));
}

describe('auto-off', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    autoOff = await import('./auto-off');
    cache = await import('../kasa/device.cache');
  });

  after(() => {
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.pragma('foreign_keys = OFF');
    for (const t of ['motion_rules', 'schedules', 'devices']) db.prepare(`DELETE FROM ${t}`).run();
    db.pragma('foreign_keys = ON');
    cache.getAllCachedStates().clear();
  });

  it('reports a timer someone set', () => {
    const id = addDevice('Porch');
    db.prepare('UPDATE devices SET timer_off_at = ? WHERE id = ?').run(sqlTime(new Date(NOW + 30 * 60_000).toISOString()), id);
    assert.deepEqual(autoOff.pendingAutoOff(NOW).get(id), { at: '2026-11-02T20:30:00.000Z', cause: 'timer', detail: null });
  });

  it('counts down a motion rule once the room is empty', () => {
    const id = addDevice('Kitchen lights', true, 20);
    addRule(id, { occupied: false, lastMotionMinAgo: 3 });
    assert.deepEqual(autoOff.pendingAutoOff(NOW).get(id), { at: '2026-11-02T20:07:00.000Z', cause: 'motion', detail: 'Kitchen sensor' });
  });

  it('says a motion rule is waiting while the room is occupied', () => {
    const id = addDevice('Kitchen lights');
    addRule(id, { occupied: true, lastMotionMinAgo: 1 });
    assert.deepEqual(autoOff.pendingAutoOff(NOW).get(id), { at: null, cause: 'motion', detail: 'Kitchen sensor', afterMinutes: 10 });
  });

  it('counts a "turn off after" schedule from when the device came on', () => {
    const id = addDevice('Fan', true, 25);
    db.prepare("INSERT INTO schedules (device_id, label, trigger_type, duration_minutes, state) VALUES (?, 'Fan off', 'auto_off', 60, 0)").run(id);
    assert.deepEqual(autoOff.pendingAutoOff(NOW).get(id), { at: '2026-11-02T20:35:00.000Z', cause: 'schedule', detail: 'Fan off' });
  });

  it('picks the earliest, and prefers a countdown to waiting', () => {
    const id = addDevice('Kitchen lights', true, 25);
    addRule(id, { occupied: true, lastMotionMinAgo: 1 });
    db.prepare("INSERT INTO schedules (device_id, label, trigger_type, duration_minutes, state) VALUES (?, 'Long', 'auto_off', 120, 0)").run(id);
    db.prepare("INSERT INTO schedules (device_id, label, trigger_type, duration_minutes, state) VALUES (?, 'Short', 'auto_off', 30, 0)").run(id);
    assert.equal(autoOff.pendingAutoOff(NOW).get(id)?.detail, 'Short');
  });

  it('ignores devices that are off, and schedules paused by a hold', () => {
    const off = addDevice('Lamp', false);
    db.prepare("INSERT INTO schedules (device_id, label, trigger_type, duration_minutes, state) VALUES (?, 'x', 'auto_off', 30, 0)").run(off);
    const held = addDevice('Heater');
    db.prepare('UPDATE devices SET override_until = ? WHERE id = ?').run(sqlTime(new Date(NOW + 3_600_000).toISOString()), held);
    db.prepare("INSERT INTO schedules (device_id, label, trigger_type, duration_minutes, state) VALUES (?, 'y', 'auto_off', 30, 0)").run(held);
    db.prepare("INSERT INTO schedules (device_id, label, trigger_type, duration_minutes, state, enabled) VALUES (?, 'z', 'auto_off', 30, 0, 0)").run(addDevice('Disabled'));
    assert.equal(autoOff.pendingAutoOff(NOW).size, 0);
  });
});
