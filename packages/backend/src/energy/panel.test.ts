/**
 * The panel monitor, against a fake Shelly Pro 3EM on a local port (with its SHA-256 digest login)
 * and a temp SQLite DB: reading both layouts, adding up its running totals by hour, and the month.
 */
process.env.TZ = 'America/New_York';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-panel-test-'));
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

let db: Database.Database;
let panel: typeof import('./panel');
let server: http.Server;
let ip: string;

/** What the fake meter reports, and its password (null: none). */
const meter = {
  password: null as string | null,
  status: {} as Record<string, unknown>,
};
const REALM = 'shellypro3em-84cca87bf250';
const NONCE = 'abc123';

const triphase = (wh: number) => ({
  'em:0': { id: 0, a_act_power: 951.2, a_voltage: 120.1, b_act_power: 812.5, b_voltage: 119.8, c_act_power: 2400, c_voltage: 240.2, total_act_power: 4163.7 },
  'emdata:0': { id: 0, a_total_act_energy: wh, b_total_act_energy: wh / 2, c_total_act_energy: wh / 4, total_act: wh * 1.75 },
});

describe('panel monitor', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    panel = await import('./panel');
    server = http.createServer((req, res) => {
      if (req.url === '/shelly') { res.end(JSON.stringify({ id: REALM, model: 'SPEM-003CEBEU', gen: 2, auth_en: !!meter.password })); return; }
      if (meter.password) {
        const h = req.headers.authorization ?? '';
        const f = (k: string) => h.match(new RegExp(`${k}="?([^",]+)"?`))?.[1] ?? '';
        const ha1 = sha(`admin:${REALM}:${meter.password}`);
        const ok = h.startsWith('Digest ') && f('response') === sha(`${ha1}:${f('nonce')}:${f('nc')}:${f('cnonce')}:auth:${sha(`GET:${req.url}`)}`);
        if (!ok) {
          res.writeHead(401, { 'WWW-Authenticate': `Digest qop="auth", realm="${REALM}", nonce="${NONCE}", algorithm=SHA-256` });
          res.end();
          return;
        }
      }
      if (req.url === '/rpc/Shelly.GetStatus') { res.end(JSON.stringify(meter.status)); return; }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    ip = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => { server.close(); db.close(); fs.rmSync(TMP, { recursive: true, force: true }); });
  beforeEach(() => {
    db.exec("DELETE FROM panel_hours; DELETE FROM panel_counters; DELETE FROM settings WHERE key LIKE 'panel_monitor%';");
    meter.password = null;
    meter.status = triphase(1000);
  });

  it('reads the three phases of the default layout', async () => {
    const r = await panel.readPanel(ip, null);
    assert.equal(r.profile, 'triphase');
    assert.equal(r.model, 'SPEM-003CEBEU');
    assert.deepEqual(r.channels.map((c) => [c.key, c.watts, c.wh]), [['a', 951.2, 1000], ['b', 812.5, 500], ['c', 2400, 250]]);
  });

  it('reads three separate channels in the monophase layout', async () => {
    meter.status = {
      'em1:0': { id: 0, act_power: 500, voltage: 120 }, 'em1data:0': { id: 0, total_act_energy: 10 },
      'em1:1': { id: 1, act_power: 300, voltage: 120 }, 'em1data:1': { id: 1, total_act_energy: 20 },
      'em1:2': { id: 2, act_power: 0, voltage: 240, errors: ['ct_type_not_set'] }, 'em1data:2': { id: 2, total_act_energy: 0 },
    };
    const r = await panel.readPanel(ip, null);
    assert.equal(r.profile, 'monophase');
    assert.deepEqual(r.channels.map((c) => c.key), ['0', '1', '2']);
    assert.deepEqual(r.errors, ['ct_type_not_set']);
  });

  it('logs in with the meter’s password, and says when it’s wrong or missing', async () => {
    meter.password = 'hunter2-test';
    assert.equal((await panel.readPanel(ip, 'hunter2-test')).channels.length, 3);
    await assert.rejects(panel.readPanel(ip, 'wrong'), /refused the password/);
    await assert.rejects(panel.readPanel(ip, null), /has a password/);
  });

  it('says plainly when nothing answers or it isn’t a meter', async () => {
    await assert.rejects(panel.readPanel('127.0.0.1:1', null), /Nothing answered/);
    meter.status = { 'switch:0': { id: 0, output: true } };
    await assert.rejects(panel.readPanel(ip, null), /isn’t an energy meter/);
  });

  it('adds up the running totals by hour, spreading a gap over the hours it covers', () => {
    const t0 = new Date(2026, 10, 15, 9, 30).getTime();
    const read = (a: number) => ({ model: null, profile: 'triphase' as const, errors: [], channels: [{ key: 'a', watts: 0, wh: a, volts: 120 }] });
    panel.record(read(1000), t0);
    panel.record(read(1100), t0 + 15 * 60_000);             // 9:45
    panel.record(read(1400), t0 + 135 * 60_000);            // 11:45: HomeHub was off for 2 hours
    const hours = db.prepare("SELECT hour, ROUND(wh, 1) wh FROM panel_hours WHERE channel = 'a' ORDER BY hour").all();
    assert.deepEqual(hours, [
      { hour: '2026-11-15T09', wh: 100 + 300 * 15 / 120 },
      { hour: '2026-11-15T10', wh: 300 * 60 / 120 },
      { hour: '2026-11-15T11', wh: 300 * 45 / 120 },
    ]);
    // A counter reset (the meter's totals cleared) adds nothing, and the next reading goes on from it.
    panel.record(read(5), t0 + 140 * 60_000);
    panel.record(read(25), t0 + 145 * 60_000);
    const sum = (db.prepare("SELECT SUM(wh) n FROM panel_hours WHERE channel = 'a'").get() as { n: number }).n;
    assert.equal(Math.round(sum), 420);
  });

  it('gives the month, with the mains as the whole home', async () => {
    panel.savePanel({ ip, channels: { a: { name: 'Main A', role: 'main' }, b: { name: '', role: 'main' }, c: { name: 'Dryer', role: 'circuit' } } });
    const t0 = new Date(2026, 10, 3, 8).getTime();
    meter.status = triphase(1000);
    await panel.pollPanel(fetch, t0);
    meter.status = triphase(3000);
    await panel.pollPanel(fetch, t0 + 3_600_000);
    const m = panel.panelMonth('2026-11')!;
    assert.deepEqual(m.channels.map((c) => [c.key, c.name, c.role, c.kwh]), [['a', 'Main A', 'main', 2], ['b', 'Main B', 'main', 1], ['c', 'Dryer', 'circuit', 0.5]]);
    assert.equal(m.wholeKwh, 3);
    assert.equal(m.since, '2026-11-03T08');
    assert.deepEqual(panel.panelMonth('2026-10')!.channels, []);
    assert.equal(panel.panelLive().read?.channels[2].watts, 2400);
  });

  it('keeps the password apart, so backups hide it, and keeps it unless changed', () => {
    panel.savePanel({ ip: '192.168.86.60', password: 'pw-test' });
    const row = db.prepare("SELECT value FROM settings WHERE key = 'panel_monitor'").get() as { value: string };
    assert.ok(!row.value.includes('pw-test'));
    panel.savePanel({ channels: { c: { name: 'Furnace', role: 'circuit' } } });
    assert.equal(panel.getPanel()!.password, 'pw-test');
    assert.equal(panel.getPanel()!.channels.c.name, 'Furnace');
    assert.throws(() => panel.savePanel({ ip: '300.1.1.1' }), /address/);
    assert.throws(() => panel.savePanel({ channels: { a: { role: 'both' } } }), /main, a circuit/);
    assert.equal(panel.savePanel({ ip: null }), null);
    assert.equal(panel.getPanel(), null);
    assert.equal(db.prepare("SELECT 1 FROM settings WHERE key = 'panel_monitor_password'").get(), undefined);
  });
});
