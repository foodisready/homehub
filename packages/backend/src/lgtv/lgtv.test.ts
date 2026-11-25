/**
 * LG webOS TVs: pairing, power, waking and the remote, against a pretend TV on a local port and a
 * temp DB.
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this file stays on its temp DB.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-lgtv-test-'));
const IP = '127.0.0.1';
const KEY = 'tv-test-key-1';
const MAC = 'A8:23:FE:01:02:03';

let db: Database.Database;
let protocol: typeof import('./protocol');
let link: typeof import('./link');
let driverMod: typeof import('../drivers/LgTvDriver');
let routes: typeof import('../routes/lgtv');

/** A TV: lets in a known key, asks on screen for anyone else, and answers what it's asked. */
class FakeTv {
  server: WebSocketServer | null = null;
  port = 0;
  /** What happens when someone new connects: asked on screen, then OK, no, or nobody answers. */
  answer: 'ok' | 'no' | 'nobody' = 'ok';
  /** Firmware that refuses the signed manifest. */
  refusesSigned = false;
  keys = new Set([KEY]);
  power: Record<string, unknown> = { state: 'Active' };
  noPowerState = false;
  volume: Record<string, unknown> = { volumeStatus: { volume: 12, muteStatus: false } };
  foreground = 'netflix';
  requests: { uri: string; payload?: Record<string, unknown> }[] = [];
  registers: Record<string, unknown>[] = [];
  prompts = 0;
  sockets = new Set<WebSocket>();

  async start(port = 0): Promise<void> {
    this.server = new WebSocketServer({ host: IP, port });
    await new Promise<void>((ok) => this.server!.once('listening', () => ok()));
    this.port = (this.server.address() as AddressInfo).port;
    this.server.on('connection', (ws) => {
      this.sockets.add(ws);
      ws.on('close', () => this.sockets.delete(ws));
      ws.on('message', (raw) => this.onMessage(ws, JSON.parse(String(raw))));
    });
  }

  /** Off: stops listening, and drops whoever was connected. */
  async stop(): Promise<void> {
    for (const ws of this.sockets) ws.terminate();
    await new Promise<void>((ok) => (this.server ? this.server.close(() => ok()) : ok()));
    this.server = null;
  }

  private onMessage(ws: WebSocket, m: Record<string, any>) {
    const reply = (o: Record<string, unknown>) => ws.send(JSON.stringify({ id: m.id, ...o }));
    if (m.type === 'register') {
      this.registers.push(m.payload);
      if (this.refusesSigned && m.payload.manifest.signed) { reply({ type: 'error', error: '403 blacklisted certificate detected' }); return; }
      const key = m.payload['client-key'];
      if (key && this.keys.has(key)) { reply({ type: 'registered', payload: { 'client-key': key } }); return; }
      this.prompts++;
      reply({ type: 'response', payload: { pairingType: 'PROMPT', returnValue: true } });
      if (this.answer === 'ok') setTimeout(() => { this.keys.add('new-key'); reply({ type: 'registered', payload: { 'client-key': 'new-key' } }); }, 50);
      if (this.answer === 'no') setTimeout(() => reply({ type: 'error', error: '403 cancelled' }), 50);
      return;
    }
    this.requests.push({ uri: m.uri, payload: m.payload });
    const ok = (payload: Record<string, unknown> = {}) => reply({ type: 'response', payload: { returnValue: true, ...payload } });
    switch (m.uri) {
      case 'ssap://com.webos.service.tvpower/power/getPowerState':
        if (this.noPowerState) reply({ type: 'error', error: '404 no such service or method' });
        else ok(this.power);
        return;
      case 'ssap://com.webos.service.connectionmanager/getinfo': ok({ wiredInfo: { macAddress: MAC.toLowerCase() }, wifiInfo: { macAddress: '00:00:00:00:00:00' } }); return;
      case 'ssap://system/getSystemInfo': ok({ modelName: 'OLED55C1PUB' }); return;
      case 'ssap://audio/getVolume': ok(this.volume); return;
      case 'ssap://com.webos.applicationManager/getForegroundAppInfo': ok({ appId: this.foreground }); return;
      case 'ssap://tv/getExternalInputList': ok({ devices: [{ id: 'HDMI_1', label: 'Xbox' }, { id: 'HDMI_2', label: 'HDMI2' }] }); return;
      case 'ssap://com.webos.applicationManager/listLaunchPoints':
        ok({ launchPoints: [{ id: 'youtube.leanback.v4', title: 'YouTube' }, { id: 'netflix', title: 'Netflix' }, { id: 'com.webos.app.hdmi1', title: 'HDMI 1' }] });
        return;
      case 'ssap://system/turnOff': ok(); this.power = { state: 'Active Standby' }; return;
      case 'ssap://tv/switchInput': this.foreground = `com.webos.app.${String(m.payload.inputId).toLowerCase().replace('_', '')}`; ok(); return;
      case 'ssap://system.launcher/launch': this.foreground = m.payload.id; ok(); return;
      case 'ssap://audio/setMute': (this.volume.volumeStatus as Record<string, unknown>).muteStatus = m.payload.mute; ok(); return;
      case 'ssap://audio/setVolume': (this.volume.volumeStatus as Record<string, unknown>).volume = m.payload.volume; ok(); return;
      default: ok();
    }
  }
}

const tv = new FakeTv();

describe('LG TVs', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    protocol = await import('./protocol');
    link = await import('./link');
    driverMod = await import('../drivers/LgTvDriver');
    routes = await import('../routes/lgtv');
    await tv.start();
    protocol.setPortsForTests([{ port: tv.port, secure: false }]);
  });

  after(async () => {
    link.closeLink(IP);
    await tv.stop();
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    link.closeLink(IP);
    tv.requests = []; tv.registers = []; tv.prompts = 0;
    tv.answer = 'ok'; tv.refusesSigned = false; tv.noPowerState = false;
    tv.power = { state: 'Active' };
    tv.keys = new Set([KEY]);
  });

  describe('pairing', () => {
    it('waits for OK on the TV and comes back with its key, saying when it asks', async () => {
      let asked = 0;
      const { connection, key } = await protocol.TvConnection.open(IP, { key: null, pairForMs: 2000, onPrompt: () => asked++ });
      connection.close();
      assert.equal(key, 'new-key');
      assert.equal(asked, 1);
      assert.ok((tv.registers[0].manifest as Record<string, unknown>).signed, 'the signed manifest goes first');
    });

    it('says so when it is turned down on the TV, or nobody answers', async () => {
      tv.answer = 'no';
      await assert.rejects(protocol.TvConnection.open(IP, { key: null, pairForMs: 2000 }), { code: 'DENIED' });
      tv.answer = 'nobody';
      await assert.rejects(protocol.TvConnection.open(IP, { key: null, pairForMs: 300 }), { code: 'TIMEOUT' });
    });

    it('asks again unsigned when the firmware refuses the signed manifest', async () => {
      tv.refusesSigned = true;
      const { connection, key } = await protocol.TvConnection.open(IP, { key: null, pairForMs: 2000 });
      connection.close();
      assert.equal(key, 'new-key');
      assert.equal(tv.registers.length, 2);
      assert.equal((tv.registers[1].manifest as Record<string, unknown>).signed, undefined);
    });

    it('a TV that has forgotten HomeHub is not left asking, and is not asked again for a while', async () => {
      tv.keys = new Set();
      await assert.rejects(link.linkTo(IP, { key: KEY }), { code: 'NOT_PAIRED' });
      assert.equal(tv.prompts, 1);
      await assert.rejects(link.linkTo(IP, { key: KEY }), { code: 'NOT_PAIRED' });
      assert.equal(tv.prompts, 1, 'the second try never reached the TV');
      await assert.rejects(link.powerOf(IP, { key: KEY }), { code: 'NOT_PAIRED' });
    });
  });

  describe('power', () => {
    it('reads on and off from the power state, and an unreachable TV as off', async () => {
      const login = { key: KEY };
      const cases: [Record<string, unknown>, boolean][] = [
        [{ state: 'Active' }, true], [{ state: 'Screen Off' }, true], [{ state: 'Screen Saver' }, true],
        [{ state: 'Active Standby' }, false], [{ state: 'Suspend' }, false],
        [{ state: 'Active', processing: 'Request Power Off' }, false],
      ];
      for (const [power, on] of cases) {
        tv.power = power;
        assert.equal(await link.powerOf(IP, login), on, JSON.stringify(power));
      }
      tv.noPowerState = true;
      assert.equal(await link.powerOf(IP, login), true, 'an older TV that answers is on');
      const port = tv.port;
      await tv.stop();
      assert.equal(await link.powerOf(IP, login), false);
      await tv.start(port);
    });

    it('turns off over the network, and does nothing to a TV already off', async () => {
      const driver = new driverMod.LgTvDriver();
      await driver.setPower(IP, false, { key: KEY, macs: [MAC] });
      assert.ok(tv.requests.some((r) => r.uri === 'ssap://system/turnOff'));
      tv.requests = [];
      await driver.setPower(IP, false, { key: KEY, macs: [MAC] });
      assert.ok(!tv.requests.some((r) => r.uri === 'ssap://system/turnOff'));
    });

    it('wakes a TV that is off with magic packets for its address, and waits for it', async () => {
      const port = tv.port;
      await tv.stop();
      const udp = dgram.createSocket('udp4');
      await new Promise<void>((ok) => udp.bind(0, IP, () => ok()));
      const packets: Buffer[] = [];
      udp.on('message', (m) => {
        packets.push(m);
        if (packets.length === 1) void tv.start(port);
      });
      protocol.setWakeTargetsForTests(() => [{ address: IP, port: (udp.address() as AddressInfo).port }]);
      driverMod.setWakeWaitForTests(3000);
      try {
        await new driverMod.LgTvDriver().setPower(IP, true, { key: KEY, macs: [MAC] });
        const expected = protocol.magicPacket(MAC);
        assert.equal(packets[0].length, 102);
        assert.deepEqual(packets[0], expected);
        assert.deepEqual(packets[0].subarray(6, 12), Buffer.from('a823fe010203', 'hex'));
      } finally {
        udp.close();
      }
    });

    it('says what to change when the TV does not wake, or how to fix not knowing its address', async () => {
      const port = tv.port;
      await tv.stop();
      protocol.setWakeTargetsForTests(() => [{ address: IP, port: 9 }]);
      driverMod.setWakeWaitForTests(400);
      const driver = new driverMod.LgTvDriver();
      await assert.rejects(driver.setPower(IP, true, { key: KEY, macs: [MAC] }), (err: Error) => /Turn on via Wi-Fi/.test(err.message));
      await assert.rejects(driver.setPower(IP, true, { key: KEY }), (err: Error) => /pair it again/.test(err.message));
      await assert.rejects(driver.setPower(IP, true, {}), { code: 'NOT_PAIRED' });
      await tv.start(port);
    });
  });

  describe('the remote', () => {
    it('shows volume, what is on screen, and the inputs and apps, with inputs left out of the apps', async () => {
      const remote = await link.remoteOf(IP, { key: KEY });
      assert.deepEqual(remote, {
        on: true, volume: 12, muted: false, input: null, app: 'netflix',
        inputs: [{ id: 'HDMI_1', label: 'Xbox' }, { id: 'HDMI_2', label: 'HDMI2' }],
        apps: [{ id: 'netflix', label: 'Netflix' }, { id: 'youtube.leanback.v4', label: 'YouTube' }],
      });
    });

    it('a TV that is off shows as off, with nothing to choose', async () => {
      tv.power = { state: 'Active Standby' };
      assert.deepEqual(await link.remoteOf(IP, { key: KEY }), { on: false, volume: null, muted: null, input: null, app: null, inputs: [], apps: [] });
    });

    it('sends each button as the TV expects it', async () => {
      const login = { key: KEY };
      const sent = async (action: Parameters<typeof link.press>[2]) => { tv.requests = []; await link.press(IP, login, action); return tv.requests.at(-1); };
      assert.deepEqual(await sent({ kind: 'volume', level: 20 }), { uri: 'ssap://audio/setVolume', payload: { volume: 20 } });
      assert.deepEqual(await sent({ kind: 'step', up: false }), { uri: 'ssap://audio/volumeDown', payload: undefined });
      assert.deepEqual(await sent({ kind: 'mute', on: true }), { uri: 'ssap://audio/setMute', payload: { mute: true } });
      assert.deepEqual(await sent({ kind: 'input', id: 'HDMI_2' }), { uri: 'ssap://tv/switchInput', payload: { inputId: 'HDMI_2' } });
      assert.deepEqual(await sent({ kind: 'app', id: 'netflix' }), { uri: 'ssap://system.launcher/launch', payload: { id: 'netflix' } });
      assert.deepEqual(await sent({ kind: 'message', text: 'Dinner’s ready' }), { uri: 'ssap://system.notifications/createToast', payload: { message: 'Dinner’s ready' } });
      // HDMI 2 now shows as the input, not an app.
      tv.foreground = 'com.webos.app.hdmi2';
      const remote = await link.remoteOf(IP, login);
      assert.equal(remote.input, 'HDMI_2');
      assert.equal(remote.app, null);
    });

    it('reads either volume shape, and a soundbar’s volume as unknown', () => {
      assert.deepEqual(link.volumeOf({ volume: 7, muted: true }), { volume: 7, muted: true });
      assert.deepEqual(link.volumeOf({ volumeStatus: { volume: 30, muteStatus: false } }), { volume: 30, muted: false });
      assert.deepEqual(link.volumeOf({ volume: -1, muted: false }), { volume: null, muted: false });
    });

    it('checks each button before sending it', () => {
      assert.deepEqual(routes.actionOf({ volume: 40 }), { kind: 'volume', level: 40 });
      assert.deepEqual(routes.actionOf({ step: 'up' }), { kind: 'step', up: true });
      assert.deepEqual(routes.actionOf({ message: '  Dinner\n is   ready ' }), { kind: 'message', text: 'Dinner is ready' });
      for (const bad of [{ volume: 101 }, { volume: 2.5 }, { volume: '5' }, { step: 'sideways' }, { mute: 'yes' }, { input: '' },
        { message: '' }, { message: 'x'.repeat(201) }, {}]) {
        assert.equal(typeof routes.actionOf(bad as Record<string, unknown>), 'string', JSON.stringify(bad));
      }
    });
  });

  describe('adding a TV', () => {
    let server: http.Server;
    let base = '';
    before(async () => {
      const express = (await import('express')).default;
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.user = { sub: 1, name: 't', role: 'admin' } as never; next(); });
      app.use('/api/lgtv', routes.lgtvRouter);
      await new Promise<void>((ok) => { server = app.listen(0, IP, () => ok()); });
      base = `http://${IP}:${(server.address() as AddressInfo).port}`;
    });
    after(() => new Promise<void>((ok) => server.close(() => ok())));

    const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    it('pairs, saves the key and the TV’s address for waking, never shows the key, and pairs again in place', async () => {
      const res = await post('/api/lgtv/pair', { ip: IP, alias: 'Living room TV', room: 'Living room' });
      assert.equal(res.status, 201);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.alias, 'Living room TV');
      assert.equal(body.canWake, true);
      assert.ok(!JSON.stringify(body).includes('new-key'));
      const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(body.id) as Record<string, string>;
      assert.equal(row.driver_type, 'lgtv');
      assert.equal(row.model, 'LG OLED55C1PUB');
      assert.equal(row.mac, MAC);
      assert.equal(row.room, 'Living room');
      assert.deepEqual(JSON.parse(row.driver_config), { key: 'new-key', macs: [MAC] });

      const again = await post('/api/lgtv/pair', { ip: IP });
      assert.equal(again.status, 200);
      assert.equal((await again.json() as Record<string, unknown>).updated, true);
      assert.equal((db.prepare("SELECT COUNT(*) n FROM devices WHERE driver_type = 'lgtv'").get() as { n: number }).n, 1);
    });

    it('says what went wrong when the TV is turned down, off, or the address is taken', async () => {
      tv.answer = 'no';
      const denied = await post('/api/lgtv/pair', { ip: IP });
      assert.equal(denied.status, 409);
      assert.match((await denied.json() as { error: string }).error, /turned HomeHub down/);
      assert.equal((await post('/api/lgtv/pair', { ip: '1.2.3' })).status, 400);
      db.prepare("INSERT INTO devices (alias, ip, driver_type) VALUES ('Lamp', '127.0.0.9', 'kasa')").run();
      const taken = await post('/api/lgtv/pair', { ip: '127.0.0.9' });
      assert.equal(taken.status, 409);
      assert.match((await taken.json() as { error: string }).error, /Lamp is saved/);
    });

    it('the remote answers with the TV as it is afterwards, and says when the TV is off', async () => {
      const id = (db.prepare("SELECT id FROM devices WHERE driver_type = 'lgtv'").get() as { id: number }).id;
      db.prepare('UPDATE devices SET driver_config = ? WHERE id = ?').run(JSON.stringify({ key: KEY, macs: [MAC] }), id);
      const res = await post(`/api/lgtv/${id}/remote`, { mute: true });
      assert.equal(res.status, 200);
      assert.equal((await res.json() as { muted: boolean }).muted, true);
      assert.equal((await post(`/api/lgtv/${id}/remote`, { volume: 900 })).status, 400);
      tv.power = { state: 'Active Standby' };
      const off = await post(`/api/lgtv/${id}/remote`, { step: 'up' });
      assert.equal(off.status, 409);
      assert.match((await off.json() as { error: string }).error, /is off/);
    });
  });

  it('a TV is never one of a room’s lights, whatever it’s called', async () => {
    const { notALight } = await import('../nlp/find-device');
    assert.equal(notALight({ alias: 'Bedroom LG', driver_type: 'lgtv' }), true);
    assert.equal(notALight({ alias: 'Bedroom lamp', driver_type: 'kasa' }), false);
    assert.equal(notALight({ alias: 'Den TV plug', driver_type: 'kasa' }), true);
  });

  it('reads MAC addresses, and a TV’s name and model from its description', async () => {
    assert.equal(protocol.normalMac('a8-23-fe-01-02-03'), MAC);
    assert.equal(protocol.normalMac('00:00:00:00:00:00'), null);
    assert.equal(protocol.normalMac('nope'), null);
    const server = http.createServer((_req, res) => res.end(
      '<root><device><friendlyName>[LG] webOS TV OLED55C1PUB</friendlyName><manufacturer>LG Electronics</manufacturer><modelName>OLED55C1PUB</modelName></device></root>'));
    await new Promise<void>((ok) => server.listen(0, IP, () => ok()));
    try {
      const d = await protocol.describe(`http://${IP}:${(server.address() as AddressInfo).port}/dd.xml`);
      assert.deepEqual(d, { name: 'webOS TV OLED55C1PUB', model: 'LG OLED55C1PUB' });
      assert.deepEqual(await protocol.describe('nonsense'), { name: 'LG TV', model: 'LG webOS TV' });
    } finally {
      server.close();
    }
  });
});
