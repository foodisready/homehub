/**
 * The Health page's checks, against a temporary database, a fake probe for
 * services, and temporary folders for backups and temperatures.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-health-test-'));
process.env.DB_PATH = path.join(TMP, 'db.sqlite');
process.env.HOMEHUB_VERSION = 'v9.9.9';
process.env.WATCHTOWER_HTTP_API_TOKEN = 'token';
process.env.HOMEHUB_CAMERA_BRIDGE = '0';

import { getDb } from '../db';
import { getAllCachedStates } from '../kasa/device.cache';
import { checkHealth, temperature, ago, type HealthReport } from './health';
import { recordBridgeReport, resetBridgeReport, forgetBridge } from './voice-bridge';
import { setAutomationsPaused } from '../automation/pause';

const NOW = Date.parse('2026-11-04T21:00:00Z');
const up = async () => true;
const item = (r: HealthReport, id: string) => r.items.find((i) => i.id === id);

function writeBackup(ageHours: number): void {
  const dir = path.join(TMP, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'db-2026-11-04.sqlite');
  fs.writeFileSync(f, 'x');
  const t = new Date(NOW - ageHours * 3_600_000);
  fs.utimesSync(f, t, t);
}

before(() => {
  const db = getDb();
  db.prepare("INSERT INTO devices (alias, ip, driver_type) VALUES ('Office Lamp', '10.0.0.1', 'kasa'), ('Porch', '10.0.0.2', 'kasa')").run();
});

after(() => {
  try { getDb().close(); } catch { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  getAllCachedStates().clear();
  resetBridgeReport();
  forgetBridge();
  setAutomationsPaused(false);
  fs.rmSync(path.join(TMP, 'backups'), { recursive: true, force: true });
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'home_%'").run();
  getDb().prepare('DELETE FROM schedules').run();
});

function allOnline(): void {
  const states = getAllCachedStates();
  for (const id of [1, 2]) states.set(id, { state: false, wattage: null, online: true, lastPolled: new Date() });
}

describe('checkHealth', () => {
  it('is ok when everything is', async () => {
    allOnline();
    writeBackup(5);
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('home_latitude', '39.8'), ('home_longitude', '-89.6')").run();
    const r = await checkHealth({ probe: up, now: NOW, dataDir: TMP, thermalRoot: path.join(TMP, 'none') });
    const bad = r.items.filter((i) => i.level !== 'ok' && i.id !== 'disk');   // the disk is this computer's
    assert.deepEqual(bad, []);
    if (item(r, 'disk')?.level === 'ok') assert.equal(r.status, 'ok');
    assert.equal(r.version, 'v9.9.9');
    assert.equal(item(r, 'devices')?.detail, 'All 2 are responding');
    assert.match(item(r, 'backups')!.detail, /5 hours ago/);
    assert.ok(item(r, 'disk'));
    assert.equal(item(r, 'voice-bridge'), undefined, 'no voice items without a bridge');
  });

  it('names devices that are offline', async () => {
    allOnline();
    getAllCachedStates().get(2)!.online = false;
    const r = await checkHealth({ probe: up, now: NOW, dataDir: TMP });
    assert.equal(item(r, 'devices')?.level, 'warn');
    assert.match(item(r, 'devices')!.detail, /1 of 2 aren't responding: Porch/);
    assert.equal(r.status, 'problem', 'no backup is the worse problem');
  });

  it('says devices are still being checked before the first poll', async () => {
    const r = await checkHealth({ probe: up, now: NOW, dataDir: TMP });
    assert.equal(item(r, 'devices')?.level, 'info');
  });

  it('reports a service that is down, with what to do', async () => {
    const r = await checkHealth({ probe: async (url) => !url.includes(':3002'), now: NOW, dataDir: TMP });
    assert.equal(item(r, 'scheduler')?.level, 'error');
    assert.match(item(r, 'scheduler')!.detail, /schedules won't run/);
    assert.equal(item(r, 'updater')?.level, 'ok');
    const old = await checkHealth({ probe: async (url) => !url.includes(':8081'), now: NOW, dataDir: TMP });
    assert.equal(item(old, 'updater')?.level, 'info', 'Watchtower only: works, but suggests the installer');
    assert.match(item(old, 'updater')!.detail, /install\.sh/);
    assert.equal(item(r, 'cameras'), undefined, 'camera bridge not installed');
  });

  it('never probes the updater at its update address', async () => {
    const urls: string[] = [];
    await checkHealth({ probe: async (u) => { urls.push(u); return true; }, now: NOW, dataDir: TMP });
    assert.ok(urls.length >= 4);
    assert.ok(!urls.some((u) => u.includes('/v1/update') || u.includes('/switch')));
    assert.ok(urls.some((u) => u.endsWith(':8081/health')));
  });

  it('flags an old backup and a missing one', async () => {
    let r = await checkHealth({ probe: up, now: NOW, dataDir: TMP });
    assert.equal(item(r, 'backups')?.level, 'error');
    writeBackup(50);
    r = await checkHealth({ probe: up, now: NOW, dataDir: TMP });
    assert.equal(item(r, 'backups')?.level, 'warn');
    assert.match(item(r, 'backups')!.detail, /2 days ago/);
  });

  it('shows the voice bridge and its speakers', async () => {
    recordBridgeReport({ version: '0.1', speakers: [{ name: 'Tablet', address: '10.0.0.20', connected: true }, { name: 'Kitchen', address: '10.0.0.21', connected: false }] }, NOW - 30_000);
    const r = await checkHealth({ probe: up, now: NOW, dataDir: TMP });
    assert.equal(item(r, 'voice-bridge')?.level, 'ok');
    assert.equal(item(r, 'speaker:10.0.0.20')?.label, 'Tablet');
    assert.equal(item(r, 'speaker:10.0.0.20')?.level, 'ok');
    assert.equal(item(r, 'speaker:10.0.0.21')?.level, 'warn');
  });

  it('offers a restart, and shows it happening', async () => {
    const vb = await import('./voice-bridge');
    recordBridgeReport({ speakers: [] }, NOW - 30_000);
    assert.equal(item(await checkHealth({ probe: up, now: NOW, dataDir: TMP }), 'voice-bridge')?.action, 'restart-voice-bridge');

    vb.requestBridgeRestart(NOW);
    let r = await checkHealth({ probe: up, now: NOW, dataDir: TMP });
    assert.match(item(r, 'voice-bridge')!.detail, /Asked to restart/);
    assert.equal(item(r, 'voice-bridge')?.action, undefined, 'no second request while one is waiting');

    vb.bridgeInstructions(NOW + 20_000);   // its next check-in: told to restart
    r = await checkHealth({ probe: up, now: NOW + 21_000, dataDir: TMP });
    assert.equal(item(r, 'voice-bridge')?.detail, 'Restarting…');

    recordBridgeReport({ speakers: [] }, NOW + 40_000);   // back, and checking in
    vb.bridgeInstructions(NOW + 40_000);
    r = await checkHealth({ probe: up, now: NOW + 41_000, dataDir: TMP });
    assert.equal(item(r, 'voice-bridge')?.level, 'ok');
  });

  describe('the voice bridge that comes with HomeHub', () => {
    const vb = () => import('./voice-bridge');
    const voiceItems = async (now = NOW) => (await checkHealth({ probe: up, now, dataDir: TMP })).items.filter((i) => i.group === 'Voice');
    afterEach(async () => { (await vb()).setVoiceSettings({ enabled: false, languages: ['en'] }); });

    it('says nothing while voice is off and it waits', async () => {
      recordBridgeReport({ speakers: [], state: 'off', kind: 'docker', id: 'a' }, NOW - 30_000);
      assert.deepEqual(await voiceItems(), []);
      resetBridgeReport();   // after a backend restart, the saved state still says it was waiting
      assert.deepEqual(await voiceItems(NOW + 10 * 60_000), []);
    });

    it('says it is starting while it downloads its models', async () => {
      (await vb()).setVoiceSettings({ enabled: true, languages: ['en', 'yue'] });
      recordBridgeReport({ speakers: [], state: 'starting', kind: 'docker', id: 'a' }, NOW - 5_000);
      assert.match((await voiceItems())[0].detail, /downloads its speech models/);
    });

    it('warns when voice is on but no bridge ever checked in', async () => {
      (await vb()).setVoiceSettings({ enabled: true, languages: ['en'] });
      const items = await voiceItems(Date.now() + 10 * 60_000);   // well after HomeHub started
      assert.equal(items[0].level, 'warn');
      assert.match(items[0].detail, /HOMEHUB_VOICE_BRIDGE/);
    });

    it('warns about two bridges answering', async () => {
      (await vb()).setVoiceSettings({ enabled: true, languages: ['en'] });
      recordBridgeReport({ speakers: [], kind: 'service', id: 'old' }, NOW - 40_000);
      recordBridgeReport({ speakers: [], kind: 'docker', id: 'new', state: 'running' }, NOW - 10_000);
      const two = (await voiceItems()).find((i) => i.id === 'voice-bridges');
      assert.equal(two?.level, 'warn');
      assert.match(two!.detail, /systemctl --user disable --now homehub-voice/);
    });
  });

  it('notices a bridge that stopped checking in, even after a restart', async () => {
    recordBridgeReport({ speakers: [] }, NOW - 20 * 60_000);
    let r = await checkHealth({ probe: up, now: NOW, dataDir: TMP });
    assert.equal(item(r, 'voice-bridge')?.level, 'warn');
    assert.match(item(r, 'voice-bridge')!.detail, /20 minutes ago/);
    resetBridgeReport();   // as after a backend restart: only the saved time is left
    r = await checkHealth({ probe: up, now: NOW, dataDir: TMP });
    assert.ok(item(r, 'voice-bridge'), 'still reported from the saved time');
  });

  it('rejects a malformed bridge report', () => {
    assert.equal(recordBridgeReport({ speakers: 'no' }), null);
    assert.equal(recordBridgeReport(null), null);
    const r = recordBridgeReport({ speakers: [{ address: '' }, { name: 'x'.repeat(500), address: 'a', connected: 'yes' }] });
    assert.equal(r?.speakers.length, 1);
    assert.equal(r?.speakers[0].name.length, 100);
    assert.equal(r?.speakers[0].connected, false);
  });

  it('warns about paused automations and sunset schedules without a location', async () => {
    setAutomationsPaused(true);
    getDb().prepare("INSERT INTO schedules (device_id, label, trigger_type, solar_event, state, enabled) VALUES (1, 'Dusk', 'solar', 'sunset', 1, 1)").run();
    const r = await checkHealth({ probe: up, now: NOW, dataDir: TMP });
    assert.equal(item(r, 'paused')?.level, 'warn');
    assert.equal(item(r, 'location')?.level, 'warn');
    assert.match(item(r, 'location')!.detail, /1 sunrise or sunset schedule may/);
  });
});

describe('temperature', () => {
  it('reports the hottest zone', () => {
    const root = path.join(TMP, 'thermal');
    for (const [z, t] of [['thermal_zone0', '48000'], ['thermal_zone1', '79500'], ['cooling_device0', '99000']]) {
      fs.mkdirSync(path.join(root, z), { recursive: true });
      fs.writeFileSync(path.join(root, z, 'temp'), t);
    }
    const [t] = temperature(root);
    assert.equal(t.level, 'warn');
    assert.match(t.detail, /^80 °C/);
    assert.deepEqual(temperature(path.join(TMP, 'missing')), []);
  });
});

describe('ago', () => {
  it('reads naturally', () => {
    assert.equal(ago(10_000), 'just now');
    assert.equal(ago(60_000), '1 minute ago');
    assert.equal(ago(3 * 3_600_000), '3 hours ago');
    assert.equal(ago(72 * 3_600_000), '3 days ago');
  });
});
