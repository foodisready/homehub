/**
 * This server's role (active, backup, dev), against a temp SQLite DB and a
 * temp Wyze sign-in folder. Modules load in before(), after DB_PATH is set.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-role-test-'));
const WYZE = path.join(TMP, 'wyze');

let getDb: () => Database.Database;
let role: typeof import('./role');
let pause: typeof import('../automation/pause');
let bridge: typeof import('../cameras/bridge');
let voice: typeof import('./voice-bridge');
let jb: typeof import('../db/json-backup');

const db = () => getDb();
const exists = (f: string) => fs.existsSync(path.join(WYZE, f));
const LOGIN = { email: 'me@example.test', password: 'pw', keyId: 'kid', apiKey: 'key' };

describe('server role', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    process.env.WYZE_SIGNIN_DIR = WYZE;
    ({ getDb } = await import('../db'));
    role = await import('./role');
    pause = await import('../automation/pause');
    bridge = await import('../cameras/bridge');
    voice = await import('./voice-bridge');
    jb = await import('../db/json-backup');
    getDb();
  });

  after(() => {
    role.applyRole('active');
    delete process.env.WYZE_SIGNIN_DIR;
    getDb().close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    db().pragma('foreign_keys = OFF');
    for (const t of ['settings', 'devices']) db().prepare(`DELETE FROM ${t}`).run();
    db().pragma('foreign_keys = ON');
    fs.rmSync(WYZE, { recursive: true, force: true });
    role.applyRole('active');
    voice.setVoiceSettings({ enabled: true, languages: ['en', 'yue'] });
  });

  it('is active when never set, so existing HomeHubs carry on', () => {
    assert.equal(role.serverRole(), 'active');
    assert.equal(pause.automationsPaused(), false);
    assert.equal(voice.voiceConfig().enabled, true);
  });

  it('a backup pauses automations, turns voice off for the bridge and holds the camera bridge back', () => {
    bridge.saveSignIn(LOGIN, 1000);
    assert.ok(exists('version'));

    const status = role.setServerRole('backup');

    assert.equal(status.role, 'backup');
    assert.equal(pause.automationsPaused(), true);
    assert.equal(pause.pausedByHand(), false, 'the hand switch is separate');
    assert.equal(voice.voiceConfig().enabled, false, 'the bridge waits');
    assert.equal(voice.getVoiceSettings().enabled, true, 'the saved voice setting is kept');
    assert.ok(!exists('version') && exists('version.standby'), 'the bridge only runs while "version" exists');
    assert.equal(bridge.signInSavedAt(), 1000, 'HomeHub still knows it is signed in to Wyze');
    assert.equal(bridge.bridgeStandby(), true);
  });

  it('becoming active again lets the bridge run with the same sign-in and turns voice back on', () => {
    bridge.saveSignIn(LOGIN, 1000);
    role.setServerRole('backup');
    const voiceVersionWhileBackup = voice.voiceConfig().version;

    const status = role.setServerRole('active');

    assert.equal(status.role, 'active');
    assert.ok(status.activeSince);
    assert.ok(exists('version') && !exists('version.standby'));
    assert.equal(fs.readFileSync(path.join(WYZE, 'version'), 'utf8'), '1000', 'the same sign-in, so the bridge keeps its Wyze login');
    assert.equal(voice.voiceConfig().enabled, true);
    assert.notEqual(voice.voiceConfig().version, voiceVersionWhileBackup, 'a new version makes the voice bridge restart');
    assert.equal(pause.automationsPaused(), false);
  });

  it('keeps a sign-in made on a backup for when it becomes active, without starting the bridge', () => {
    role.setServerRole('backup');
    bridge.saveSignIn(LOGIN, 2000);
    assert.ok(!exists('version') && exists('version.standby'));
    role.setServerRole('active');
    assert.equal(fs.readFileSync(path.join(WYZE, 'version'), 'utf8'), '2000');
  });

  it('signing out on a backup removes the held-back sign-in too', () => {
    bridge.saveSignIn(LOGIN, 1000);
    role.setServerRole('backup');
    bridge.clearSignIn();
    assert.equal(bridge.signInSavedAt(), null);
    assert.ok(!exists('version.standby'));
  });

  it('a dev server is held back the same way', () => {
    role.setServerRole('dev');
    assert.equal(pause.automationsPaused(), true);
    assert.equal(voice.voiceConfig().enabled, false);
  });

  it('ends timers that ran out while it was a backup, instead of firing them all', () => {
    db().prepare(`INSERT INTO devices (id, alias, ip, driver_type, timer_off_at) VALUES
      (1, 'Old timer', '192.0.2.1', 'kasa', datetime('now', '-1 hour')),
      (2, 'Future timer', '192.0.2.2', 'kasa', datetime('now', '+1 hour'))`).run();
    role.setServerRole('backup');
    role.setServerRole('active');
    const timers = db().prepare('SELECT id, timer_off_at FROM devices ORDER BY id').all() as { id: number; timer_off_at: string | null }[];
    assert.equal(timers[0].timer_off_at, null);
    assert.ok(timers[1].timer_off_at);
  });

  it('refuses an unknown role', () => {
    assert.throws(() => role.setServerRole('primary'), /role must be one of/);
    assert.equal(role.serverRole(), 'active');
  });

  it('stays out of backups, and a restore keeps this server\'s role', () => {
    role.setServerRole('backup');
    const { name } = jb.createBackup();
    const keys = JSON.parse(jb.readFull(name)).tables.settings.map((r: { key: string }) => r.key);
    assert.ok(!keys.includes('server_role') && !keys.includes('server_active_since'));

    role.setServerRole('active');
    jb.restoreBackup(name);
    assert.equal(role.serverRole(), 'active', 'restoring a backup made on a backup server does not make this one a backup');
  });
});
