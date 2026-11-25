/**
 * Sonos speakers: reading what they are and what's playing, play and pause going to a group's
 * leader, and the remote, against a pretend speaker on a local port and a temp DB.
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this file stays on its temp DB.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-sonos-test-'));
const KITCHEN = 'RINCON_KITCHEN01400';
const LIVING = 'RINCON_LIVING01400';

let db: Database.Database;
let protocol: typeof import('./protocol');
let driverMod: typeof import('../drivers/SonosDriver');
let routes: typeof import('../routes/sonos');

const enc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const DIDL = (inner: string) => enc(`<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/"><item>${inner}</item></DIDL-Lite>`);

/**
 * Two speakers behind one port, told apart by the address asked for: "127.0.0.1" is the Kitchen
 * and "localhost" the Living room. They can be grouped, the Living room leading.
 */
class FakeSonos {
  server!: http.Server;
  port = 0;
  grouped = false;
  state: Record<string, string> = { '127.0.0.1': 'PAUSED_PLAYBACK', localhost: 'PAUSED_PLAYBACK' };
  queued = true;
  radio = false;
  volume: Record<string, number> = { '127.0.0.1': 30, localhost: 20 };
  sent: { host: string; action: string; body: string }[] = [];

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const host = (req.headers.host ?? '').split(':')[0];
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => this.answer(host, req.url ?? '', String(req.headers.soapaction ?? ''), body, res));
    });
    await new Promise<void>((ok) => this.server.listen(0, '127.0.0.1', () => ok()));
    this.port = (this.server.address() as AddressInfo).port;
  }

  private answer(host: string, url: string, soapAction: string, body: string, res: http.ServerResponse) {
    if (url === '/xml/device_description.xml') {
      const kitchen = host === '127.0.0.1';
      res.end(`<root><device><manufacturer>Sonos, Inc.</manufacturer><modelName>Sonos ${kitchen ? 'Connect:Amp' : 'One'}</modelName><MACAddress>b8:e9:37:a4:35:ee</MACAddress><UDN>uuid:${kitchen ? KITCHEN : LIVING}</UDN><roomName>${kitchen ? 'Kitchen' : 'Living room'}</roomName></device></root>`);
      return;
    }
    const action = /#(\w+)"?$/.exec(soapAction)?.[1] ?? '';
    this.sent.push({ host, action, body });
    const ok = (inner = '') => res.end(`<s:Envelope><s:Body><u:${action}Response>${inner}</u:${action}Response></s:Body></s:Envelope>`);
    const fault = (code: number) => { res.statusCode = 500; res.end(`<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>`); };
    const leader = this.grouped ? 'localhost' : host;
    switch (action) {
      case 'GetZoneGroupState': {
        const member = (uuid: string, h: string, room: string, extra = '') => `<ZoneGroupMember UUID="${uuid}" Location="http://${h}:${this.port}/xml/device_description.xml" ZoneName="${room}"${extra}/>`;
        const hiddenPair = member('RINCON_PAIR01400', '127.0.0.9', 'Living room', ' Invisible="1"');
        const groups = this.grouped
          ? `<ZoneGroup Coordinator="${LIVING}" ID="g1">${member(LIVING, 'localhost', 'Living room')}${member(KITCHEN, '127.0.0.1', 'Kitchen')}${hiddenPair}</ZoneGroup>`
          : `<ZoneGroup Coordinator="${KITCHEN}" ID="g1">${member(KITCHEN, '127.0.0.1', 'Kitchen')}</ZoneGroup><ZoneGroup Coordinator="${LIVING}" ID="g2">${member(LIVING, 'localhost', 'Living room')}${hiddenPair}</ZoneGroup>`;
        ok(`<ZoneGroupState>${enc(`<ZoneGroupState><ZoneGroups>${groups}</ZoneGroups></ZoneGroupState>`)}</ZoneGroupState>`);
        return;
      }
      case 'GetTransportInfo': ok(`<CurrentTransportState>${this.state[leader]}</CurrentTransportState>`); return;
      case 'Play':
        if (!this.queued) { fault(701); return; }
        this.state[host] = 'PLAYING'; ok(); return;
      case 'Pause':
        if (this.radio) { fault(701); return; }
        this.state[host] = 'PAUSED_PLAYBACK'; ok(); return;
      case 'Stop': this.state[host] = 'STOPPED'; ok(); return;
      case 'Next': case 'Previous': if (this.radio) { fault(711); return; } ok(); return;
      case 'GetPositionInfo':
        ok(this.radio
          ? `<TrackMetaData>${DIDL('<dc:title>x-sonosapi-stream:s1234</dc:title><r:streamContent>Nina Simone - Feeling Good</r:streamContent>')}</TrackMetaData>`
          : `<TrackMetaData>${DIDL('<dc:title>Blue in Green</dc:title><dc:creator>Miles Davis</dc:creator><upnp:album>Kind of Blue</upnp:album>')}</TrackMetaData>`);
        return;
      case 'GetMediaInfo': ok(`<CurrentURIMetaData>${DIDL('<dc:title>Jazz FM</dc:title>')}</CurrentURIMetaData>`); return;
      case 'GetVolume': ok(`<CurrentVolume>${this.volume[host]}</CurrentVolume>`); return;
      case 'GetMute': ok('<CurrentMute>0</CurrentMute>'); return;
      case 'SetRelativeVolume': this.volume[host] += Number(/<Adjustment>(-?\d+)/.exec(body)?.[1]); ok(); return;
      case 'SetVolume': this.volume[host] = Number(/<DesiredVolume>(\d+)/.exec(body)?.[1]); ok(); return;
      default: ok();
    }
  }
}

const sonos = new FakeSonos();

describe('Sonos speakers', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    protocol = await import('./protocol');
    driverMod = await import('../drivers/SonosDriver');
    routes = await import('../routes/sonos');
    await sonos.start();
    protocol.setPortForTests(sonos.port);
  });

  after(() => {
    sonos.server.close();
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    sonos.grouped = false; sonos.queued = true; sonos.radio = false; sonos.sent = [];
    sonos.state = { '127.0.0.1': 'PAUSED_PLAYBACK', localhost: 'PAUSED_PLAYBACK' };
  });

  it('reads what a speaker is, and is found as "<room> Sonos", ready to add with no login', async () => {
    assert.deepEqual(await protocol.describe('127.0.0.1'), { ip: '127.0.0.1', uuid: KITCHEN, room: 'Kitchen', model: 'Sonos Connect:Amp', mac: 'B8:E9:37:A4:35:EE' });
    const found = await new driverMod.SonosDriver().probe('127.0.0.1');
    assert.deepEqual(found, { ip: '127.0.0.1', alias: 'Kitchen Sonos', model: 'Sonos Connect:Amp', hasEmeter: false, driverConfig: { uuid: KITCHEN }, mac: 'B8:E9:37:A4:35:EE' });
  });

  it('a device that isn’t a Sonos, or nothing at all, isn’t one', async () => {
    const other = http.createServer((_q, r) => r.end('<root><device><manufacturer>Acme</manufacturer><UDN>uuid:x</UDN></device></root>'));
    await new Promise<void>((ok) => other.listen(0, '127.0.0.1', () => ok()));
    protocol.setPortForTests((other.address() as AddressInfo).port);
    try {
      assert.equal(await protocol.describe('127.0.0.1'), null);
    } finally {
      protocol.setPortForTests(sonos.port);
      other.close();
    }
  });

  it('reads groups, leaving out the hidden half of a pair', async () => {
    sonos.grouped = true;
    const group = await protocol.groupOf('127.0.0.1', KITCHEN);
    assert.deepEqual(group, { coordinator: LIVING, members: [
      { uuid: LIVING, ip: 'localhost', room: 'Living room' }, { uuid: KITCHEN, ip: '127.0.0.1', room: 'Kitchen' },
    ] });
  });

  it('on is playing: play and pause go to the group’s leader, so the whole group follows', async () => {
    const driver = new driverMod.SonosDriver();
    const kitchen = { uuid: KITCHEN };
    assert.equal(await driver.getPower('127.0.0.1', kitchen), false);
    await driver.setPower('127.0.0.1', true, kitchen);
    assert.deepEqual(sonos.sent.filter((s) => s.action === 'Play').map((s) => s.host), ['127.0.0.1']);
    assert.equal(await driver.getPower('127.0.0.1', kitchen), true);

    sonos.grouped = true;
    sonos.sent = [];
    await driver.setPower('127.0.0.1', true, kitchen);
    assert.deepEqual(sonos.sent.filter((s) => s.action === 'Play').map((s) => s.host), ['localhost'], 'the Living room leads the group');
    await driver.setPower('127.0.0.1', false, kitchen);
    assert.deepEqual(sonos.sent.filter((s) => s.action === 'Pause').map((s) => s.host), ['localhost']);
  });

  it('does nothing when it’s already as asked', async () => {
    await new driverMod.SonosDriver().setPower('127.0.0.1', false, { uuid: KITCHEN });
    assert.ok(!sonos.sent.some((s) => s.action === 'Pause' || s.action === 'Play'));
  });

  it('says to start something in the Sonos app when there’s nothing to play', async () => {
    sonos.queued = false;
    await assert.rejects(new driverMod.SonosDriver().setPower('127.0.0.1', true, { uuid: KITCHEN }),
      (err: Error & { code?: string }) => err.code === 'NOTHING_TO_PLAY' && /Sonos app/.test(err.message));
  });

  it('stops the radio, which can’t pause', async () => {
    sonos.radio = true;
    sonos.state['127.0.0.1'] = 'PLAYING';
    await new driverMod.SonosDriver().setPower('127.0.0.1', false, { uuid: KITCHEN });
    assert.deepEqual(sonos.sent.filter((s) => /Pause|Stop/.test(s.action)).map((s) => s.action), ['Pause', 'Stop']);
    assert.equal(sonos.state['127.0.0.1'], 'STOPPED');
  });

  it('says what’s playing: a song’s title and artist, or what a station is playing', async () => {
    assert.deepEqual(await protocol.nowPlaying('127.0.0.1'), { title: 'Blue in Green', artist: 'Miles Davis', album: 'Kind of Blue' });
    sonos.radio = true;
    assert.deepEqual(await protocol.nowPlaying('127.0.0.1'), { title: 'Feeling Good', artist: 'Nina Simone', album: null });
    assert.deepEqual(protocol.parseNowPlaying(`<TrackMetaData>${DIDL('<r:streamContent>Talk show</r:streamContent>')}</TrackMetaData>`,
      `<CurrentURIMetaData>${DIDL('<dc:title>BBC Radio 4</dc:title>')}</CurrentURIMetaData>`), { title: 'Talk show', artist: 'BBC Radio 4', album: null });
    assert.deepEqual(protocol.parseNowPlaying('<TrackMetaData>NOT_IMPLEMENTED</TrackMetaData>'), { title: null, artist: null, album: null });
  });

  describe('the remote', () => {
    let server: http.Server;
    let base = '';
    let id = 0;
    before(async () => {
      const express = (await import('express')).default;
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.user = { sub: 1, name: 't', role: 'member' } as never; next(); });
      app.use('/api/sonos', routes.sonosRouter);
      await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      id = Number(db.prepare("INSERT INTO devices (alias, ip, driver_type, driver_config) VALUES ('Kitchen Sonos', '127.0.0.1', 'sonos', ?)").run(JSON.stringify({ uuid: KITCHEN })).lastInsertRowid);
    });
    after(() => new Promise<void>((ok) => server.close(() => ok())));
    const post = (body: unknown) => fetch(`${base}/api/sonos/${id}/remote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    it('shows what’s playing, the volume, and the rooms it’s grouped with', async () => {
      sonos.grouped = true;
      const r = await (await fetch(`${base}/api/sonos/${id}/remote`)).json();
      assert.deepEqual(r, { playing: false, nowPlaying: { title: 'Blue in Green', artist: 'Miles Davis', album: 'Kind of Blue' }, volume: 30, muted: false, groupedWith: ['Living room'] });
    });

    it('steps this speaker’s volume by 2, plays, and skips on the group’s leader', async () => {
      sonos.volume['127.0.0.1'] = 30;
      assert.equal(((await (await post({ step: 'up' })).json()) as { volume: number }).volume, 32);
      sonos.grouped = true;
      const played = await (await post({ action: 'play' })).json() as { playing: boolean };
      assert.equal(played.playing, true);
      sonos.sent = [];
      assert.equal((await post({ action: 'next' })).status, 200);
      assert.deepEqual(sonos.sent.filter((s) => s.action === 'Next').map((s) => s.host), ['localhost']);
    });

    it('checks each button, and says when what’s playing can’t skip', async () => {
      for (const bad of [{ action: 'shuffle' }, { volume: 101 }, { step: 3 }, { mute: 'no' }, {}]) {
        assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
      }
      sonos.radio = true;
      const skip = await post({ action: 'next' });
      assert.equal(skip.status, 409);
      assert.match(((await skip.json()) as { error: string }).error, /can’t skip/);
    });
  });
});
