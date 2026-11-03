/**
 * JSON backup, edit and restore against a temp SQLite DB.
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

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-json-backup-test-'));
const BACKUP_DIR = path.join(TMP_BASE, 'backups');

let getDb: () => Database.Database;
let jb: typeof import('./json-backup');

const db = () => getDb();
const aliases = () => (db().prepare('SELECT alias FROM devices ORDER BY id').all() as { alias: string }[]).map((r) => r.alias);
const TABLES = ['energy_readings', 'schedules', 'settings', 'devices', 'notification_preferences', 'push_subscriptions', 'users'];
const count = (sql: string) => (db().prepare(sql).get() as { n: number }).n;

function seed(): void {
  const d = db();
  d.prepare("INSERT INTO users (id, name, password_hash, role) VALUES (1, 'admin', 'bcrypt-hash', 'admin')").run();
  d.prepare(`INSERT INTO devices (id, alias, ip, driver_type, driver_config, room)
             VALUES (1, 'Kitchen lights', '10.0.0.1', 'shelly', ?, 'Kitchen')`)
    .run(JSON.stringify({ gen: 1, auth: { user: 'admin', pass: 'shelly-pass' } }));
  d.prepare("INSERT INTO devices (id, alias, ip, driver_type) VALUES (2, 'Porch', '10.0.0.2', 'kasa')").run();
  d.prepare("INSERT INTO schedules (device_id, label, trigger_type, cron_expression, state) VALUES (1, 'Morning', 'cron', '0 7 * * *', 1)").run();
  d.prepare("INSERT INTO settings (key, value) VALUES ('kasa_auth_v2', 'secret-hash'), ('kasa_username', 'me')").run();
  d.prepare('INSERT INTO energy_readings (device_id, wattage) VALUES (1, 5), (2, 7)').run();
}

describe('JSON backups', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP_BASE, 'db.sqlite');
    ({ getDb } = await import('./index'));
    jb = await import('./json-backup');
    getDb();
  });

  after(() => {
    getDb().close();
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    db().pragma('foreign_keys = OFF');
    for (const t of TABLES) db().prepare(`DELETE FROM ${t}`).run();
    db().pragma('foreign_keys = ON');
    seed();
  });

  it('writes a JSON file to the backups folder and lists it', () => {
    const entry = jb.createBackup('before moving to the Pi');
    assert.match(entry.name, /^homehub-\d{4}-\d{2}-\d{2}-\d{6}\.json$/);
    assert.ok(fs.existsSync(path.join(BACKUP_DIR, entry.name)));
    assert.equal(entry.note, 'before moving to the Pi');
    assert.equal(entry.counts.devices, 2);

    const file = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, entry.name), 'utf8'));
    assert.deepEqual(file.tables.devices[0].driver_config.auth, { user: 'admin', pass: 'shelly-pass' }, 'JSON columns are objects');
    assert.equal(file.tables.energy_readings, undefined, 'history is left out');
    assert.deepEqual(jb.listBackups().map((b) => b.name), [entry.name]);
  });

  it('restores deleted devices and their schedules', () => {
    const { name } = jb.createBackup();
    db().prepare('DELETE FROM devices WHERE id = 1').run();
    assert.equal(count('SELECT COUNT(*) n FROM schedules'), 0);

    const result = jb.restoreBackup(name);

    assert.deepEqual(aliases(), ['Kitchen lights', 'Porch']);
    assert.equal(count('SELECT COUNT(*) n FROM schedules'), 1);
    assert.equal(result.counts.devices, 2);
    const cfg = (db().prepare('SELECT driver_config c FROM devices WHERE id = 1').get() as { c: string }).c;
    assert.deepEqual(JSON.parse(cfg).auth.pass, 'shelly-pass');
  });

  it("keeps the energy history of devices that are in the backup", () => {
    const { name } = jb.createBackup();
    jb.restoreBackup(name);
    assert.equal(count('SELECT COUNT(*) n FROM energy_readings'), 2);
  });

  it('removes history for devices that are not in the backup', () => {
    const { name } = jb.createBackup();
    db().prepare("INSERT INTO devices (id, alias, ip) VALUES (3, 'New plug', '10.0.0.3')").run();
    db().prepare('INSERT INTO energy_readings (device_id, wattage) VALUES (3, 1)').run();

    const result = jb.restoreBackup(name);

    assert.deepEqual(aliases(), ['Kitchen lights', 'Porch']);
    assert.equal(count('SELECT COUNT(*) n FROM energy_readings'), 2);
    assert.equal(result.removed, 1);
    assert.equal(count('SELECT COUNT(*) n FROM energy_readings WHERE device_id NOT IN (SELECT id FROM devices)'), 0);
  });

  it('saves the current state before restoring', () => {
    const { name } = jb.createBackup();
    const { safetyBackup } = jb.restoreBackup(name);
    assert.match(safetyBackup, /^before-restore-/);
    assert.equal(jb.listBackups().length, 2);
  });

  it('hides passwords and keys when viewed', () => {
    const { name } = jb.createBackup();
    const shown = jb.readMasked(name);
    for (const secret of ['shelly-pass', 'bcrypt-hash', 'secret-hash']) assert.ok(!shown.includes(secret), secret);
    const data = JSON.parse(shown);
    assert.equal(data.tables.devices[0].driver_config.auth.user, 'admin');
    assert.equal(data.tables.devices[0].driver_config.auth.pass, jb.HIDDEN);
    assert.equal(data.tables.settings.find((s: { key: string }) => s.key === 'kasa_username').value, 'me');
  });

  it('saves edits and keeps hidden values', () => {
    const { name } = jb.createBackup();
    const data = JSON.parse(jb.readMasked(name));
    data.tables.devices[1].alias = 'Front porch';
    data.tables.devices[1].room = 'Outside';
    jb.saveEdited(name, JSON.stringify(data));

    jb.restoreBackup(name);

    assert.deepEqual(aliases(), ['Kitchen lights', 'Front porch']);
    const cfg = JSON.parse((db().prepare('SELECT driver_config c FROM devices WHERE id = 1').get() as { c: string }).c);
    assert.equal(cfg.auth.pass, 'shelly-pass');
    assert.equal((db().prepare("SELECT value FROM settings WHERE key = 'kasa_auth_v2'").get() as { value: string }).value, 'secret-hash');
    assert.equal((db().prepare('SELECT password_hash p FROM users').get() as { p: string }).p, 'bcrypt-hash');
  });

  it('rejects an edit that breaks a link, and leaves the file alone', () => {
    const { name } = jb.createBackup();
    const before = fs.readFileSync(path.join(BACKUP_DIR, name), 'utf8');
    const data = JSON.parse(jb.readMasked(name));
    data.tables.devices = data.tables.devices.filter((d: { id: number }) => d.id !== 1);

    assert.throws(() => jb.saveEdited(name, JSON.stringify(data)), /schedules id \d+ refers to devices 1/);
    assert.equal(fs.readFileSync(path.join(BACKUP_DIR, name), 'utf8'), before);
    assert.deepEqual(aliases(), ['Kitchen lights', 'Porch'], 'test restore was rolled back');
  });

  it('rejects broken JSON and duplicate names', () => {
    const { name } = jb.createBackup();
    assert.throws(() => jb.saveEdited(name, '{ "format": '), /Not valid JSON/);

    const data = JSON.parse(jb.readMasked(name));
    data.tables.devices[1].alias = 'Kitchen lights';
    assert.throws(() => jb.saveEdited(name, JSON.stringify(data)), /devices row 2: UNIQUE/);
  });

  it('rejects a hidden value it has nothing to fill in from', () => {
    const { name } = jb.createBackup();
    const data = JSON.parse(jb.readMasked(name));
    data.tables.devices[1].driver_config = { auth: { user: 'x', pass: jb.HIDDEN } };
    assert.throws(() => jb.saveEdited(name, JSON.stringify(data)), /devices id 2\.driver_config\.auth\.pass is <hidden>/);
  });

  it('leaves tables that are removed from the file untouched', () => {
    const { name } = jb.createBackup();
    const data = JSON.parse(jb.readMasked(name));
    delete data.tables.users;
    jb.saveEdited(name, JSON.stringify(data));
    db().prepare("INSERT INTO users (name, password_hash) VALUES ('newer', 'h')").run();

    const result = jb.restoreBackup(name);

    assert.equal(result.counts.users, undefined);
    assert.equal(count('SELECT COUNT(*) n FROM users'), 2);
  });

  it('refuses names outside the backups folder', () => {
    assert.throws(() => jb.readMasked('../db.sqlite'), /Invalid backup name/);
    assert.throws(() => jb.deleteBackup('../../x.json'), /Invalid backup name/);
  });

  it('downloads the whole file, passwords included, and moves it to another HomeHub', () => {
    const { name } = jb.createBackup('from the Mac');
    const file = jb.readFull(name);
    assert.ok(file.includes('shelly-pass'));

    // The other HomeHub: empty, with only its own admin.
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    db().pragma('foreign_keys = OFF');
    for (const t of TABLES) db().prepare(`DELETE FROM ${t}`).run();
    db().pragma('foreign_keys = ON');
    db().prepare("INSERT INTO users (id, name, password_hash, role) VALUES (1, 'admin', 'pi-hash', 'admin')").run();

    const uploaded = jb.importBackup(file);
    assert.match(uploaded.name, /^uploaded-\d{4}-\d{2}-\d{2}-\d{6}\.json$/);
    assert.equal(uploaded.note, 'from the Mac');
    assert.deepEqual(aliases(), [], 'uploading changes nothing until restored');

    const result = jb.restoreBackup(uploaded.name);
    assert.deepEqual(aliases(), ['Kitchen lights', 'Porch']);
    const cfg = JSON.parse((db().prepare('SELECT driver_config c FROM devices WHERE id = 1').get() as { c: string }).c);
    assert.equal(cfg.auth.pass, 'shelly-pass');
    assert.equal((db().prepare('SELECT password_hash p FROM users').get() as { p: string }).p, 'pi-hash', "the Pi's admin keeps its password");
    assert.deepEqual(result.accounts, { added: [], kept: ['admin'] });
  });

  it('adds accounts from the backup, with their passwords and notification choices, and keeps the ones here', () => {
    db().prepare("INSERT INTO users (id, name, password_hash, role) VALUES (2, 'sam', 'sam-hash', 'member')").run();
    db().prepare("INSERT INTO notification_preferences (user_id, channel, min_level) VALUES (1, 'push', 2), (2, 'push', 3)").run();
    const { name } = jb.createBackup();

    // This HomeHub: a different admin password and an account of its own on id 2.
    db().prepare('DELETE FROM notification_preferences').run();
    db().prepare('DELETE FROM users WHERE id = 2').run();
    db().prepare("UPDATE users SET password_hash = 'here-hash' WHERE id = 1").run();
    db().prepare("INSERT INTO users (id, name, password_hash, role) VALUES (2, 'alex', 'alex-hash', 'admin')").run();
    db().prepare("INSERT INTO notification_preferences (user_id, channel, min_level) VALUES (1, 'push', 1)").run();

    const result = jb.restoreBackup(name);

    assert.deepEqual(result.accounts, { added: ['sam'], kept: ['admin'] });
    const users = db().prepare('SELECT id, name, password_hash p, role FROM users ORDER BY id').all();
    assert.deepEqual(users, [
      { id: 1, name: 'admin', p: 'here-hash', role: 'admin' },
      { id: 2, name: 'alex', p: 'alex-hash', role: 'admin' },
      { id: 3, name: 'sam', p: 'sam-hash', role: 'member' },
    ]);
    const prefs = db().prepare('SELECT user_id u, min_level l FROM notification_preferences ORDER BY user_id').all();
    assert.deepEqual(prefs, [{ u: 1, l: 1 }, { u: 3, l: 3 }], "sam's choice moves to sam's new id; admin's here stays");
  });

  it("keeps this HomeHub's home location and time zone, and fills them in when unset", () => {
    db().prepare("INSERT INTO settings (key, value) VALUES ('home_latitude', '40.71'), ('home_longitude', '-74.01'), ('home_timezone', 'America/New_York')").run();
    const { name } = jb.createBackup();
    db().prepare("UPDATE settings SET value = '51.5' WHERE key = 'home_latitude'").run();
    db().prepare("UPDATE settings SET value = '-0.13' WHERE key = 'home_longitude'").run();
    db().prepare("DELETE FROM settings WHERE key = 'home_timezone'").run();
    db().prepare("UPDATE settings SET value = 'someone-else' WHERE key = 'kasa_username'").run();

    jb.restoreBackup(name);

    const get = (k: string) => (db().prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value;
    assert.equal(get('home_latitude'), '51.5');
    assert.equal(get('home_longitude'), '-0.13');
    assert.equal(get('home_timezone'), 'America/New_York', 'unset here, so taken from the backup');
    assert.equal(get('kasa_username'), 'me', 'other settings come from the backup');
  });

  it('refuses an upload with hidden values or that would not restore', () => {
    const { name } = jb.createBackup();
    assert.throws(() => jb.importBackup(jb.readMasked(name)), /<hidden> in place of passwords/);
    assert.throws(() => jb.importBackup('{"format":"other"}'), /Not a HomeHub backup/);

    const data = JSON.parse(jb.readFull(name));
    data.tables.devices = data.tables.devices.filter((d: { id: number }) => d.id !== 1);
    assert.throws(() => jb.importBackup(JSON.stringify(data)), /refers to devices 1/);
    assert.equal(jb.listBackups().length, 1, 'nothing saved');
  });

  it('deletes a backup', () => {
    const { name } = jb.createBackup();
    jb.deleteBackup(name);
    assert.deepEqual(jb.listBackups(), []);
  });
});
