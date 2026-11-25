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
let music: typeof import('./music');

const enc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const DIDL = (inner: string) => enc(`<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/"><item>${inner}</item></DIDL-Lite>`);

const META_NS = 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"';
/** A Sonos Favorite, as the speaker lists it: its address, and the metadata to play it with (escaped inside). */
const favorite = (id: string, title: string, res: string, type: string, innerClass: string, extra = '') =>
  `<item id="${id}" parentID="FV:2" restricted="false"><dc:title>${enc(title)}</dc:title><upnp:class>object.itemobject.item.sonos-favorite</upnp:class>`
  + `<res protocolInfo="x:*:*:*">${enc(res)}</res>${extra}<r:type>${type}</r:type><r:description>Service</r:description>`
  + `<r:resMD>${enc(`<DIDL-Lite ${META_NS}><item id="X" parentID="" restricted="true"><dc:title>${enc(title)}</dc:title><upnp:class>${innerClass}</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON3079_X_#Svc3079-0-Token</desc></item></DIDL-Lite>`)}</r:resMD></item>`;
const FAVORITES = [
  favorite('FV:2/3', 'Morning Song', 'x-sonos-http:abc.mp3?sid=151&flags=32&sn=2', 'instantPlay', 'object.item.audioItem.musicTrack',
    '<upnp:albumArtURI>http://lh6.ggpht.com/art.jpg</upnp:albumArtURI>'),
  favorite('FV:2/5', 'My Stations', '', 'shortcut', 'object.container'),
  favorite('FV:2/2', 'Q100 & Friends', 'x-sonosapi-stream:s21507?sid=333&flags=8224&sn=4', 'instantPlay', 'object.item.audioItem.audioBroadcast'),
  favorite('FV:2/6', 'Snow Song', 'x-sonos-spotify:spotify%3atrack%3a4uLU6hMCjMI75M1A2tKUQC?sid=12&flags=8224&sn=7', 'instantPlay', 'object.item.audioItem.musicTrack',
    '<upnp:albumArtURI>https://i.scdn.co/image/ab67</upnp:albumArtURI>'),
];
const PLAYLIST = '<container id="SQ:0" parentID="SQ:" restricted="true"><dc:title>Dinner</dc:title><res protocolInfo="file:*:audio/mpegurl:*">file:///jffs/settings/savedqueues.rsq#0</res><upnp:class>object.container.playlistContainer</upnp:class><upnp:albumArtURI>/getaa?s=1&amp;u=x</upnp:albumArtURI></container>';

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
  favorites = FAVORITES;
  queueLength = 5;
  /** What GetPositionInfo says the current track's address is. */
  trackUri = 'x-file-cifs://nas/music/blue.flac';

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
          : `<TrackURI>${enc(this.trackUri)}</TrackURI><TrackMetaData>${DIDL('<dc:title>Blue in Green</dc:title><dc:creator>Miles Davis</dc:creator><upnp:album>Kind of Blue</upnp:album>')}</TrackMetaData>`);
        return;
      case 'GetMediaInfo': ok(`<CurrentURIMetaData>${DIDL('<dc:title>Jazz FM</dc:title>')}</CurrentURIMetaData>`); return;
      case 'Browse': {
        const objectId = /<ObjectID>([^<]*)/.exec(body)?.[1] ?? '';
        const entries = objectId === 'FV:2' ? this.favorites : objectId === 'SQ:' ? [PLAYLIST] : [];
        const didl = `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">${entries.join('')}</DIDL-Lite>`;
        ok(`<Result>${enc(didl)}</Result><NumberReturned>${entries.length}</NumberReturned><TotalMatches>${entries.length}</TotalMatches><UpdateID>1</UpdateID>`);
        return;
      }
      case 'AddURIToQueue': {
        if (/spotify%3aalbum%3aBADBADBADBADBADBADBADB|dead\.mp3/.test(body)) { fault(800); return; }
        const first = this.queueLength + 1;
        this.queueLength += 12;
        ok(`<FirstTrackNumberEnqueued>${first}</FirstTrackNumberEnqueued><NumTracksAdded>12</NumTracksAdded><NewQueueLength>${this.queueLength}</NewQueueLength>`); return;
      }
      case 'RemoveTrackRangeFromQueue': this.queueLength -= Number(/<NumberOfTracks>(\d+)/.exec(body)?.[1]); ok('<NewUpdateID>2</NewUpdateID>'); return;
      case 'SetAVTransportURI':
        if (/<CurrentURI>x-rincon:/.test(body)) { if (host === '127.0.0.1' && body.includes(LIVING)) this.grouped = true; ok(); return; }
        this.queued = true; ok(); return;
      case 'BecomeCoordinatorOfStandaloneGroup': this.grouped = false; ok(); return;
      case 'DelegateGroupCoordinationTo': this.grouped = false; ok(); return;
      case 'GetGroupVolume': ok('<CurrentVolume>25</CurrentVolume>'); return;
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
    process.env.SCHEDULER_URL = 'http://127.0.0.1:9';
    process.env.INTERNAL_API_KEY = 'test-internal-key';
    db = (await import('../db')).getDb();
    protocol = await import('./protocol');
    driverMod = await import('../drivers/SonosDriver');
    routes = await import('../routes/sonos');
    music = await import('./music');
    routes.setRouteWaitForTests(0);
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
    sonos.favorites = FAVORITES; sonos.trackUri = 'x-file-cifs://nas/music/blue.flac'; sonos.queueLength = 5;
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
    it('lists what to play without the speaker’s addresses', async () => {
      const r = await (await fetch(`${base}/api/sonos/${id}/library`)).json() as { favorites: Record<string, unknown>[]; playlists: unknown[]; shortcuts: number };
      assert.deepEqual(r.favorites[0], { id: 'FV:2/3', title: 'Morning Song', note: 'Service', kind: 'favorite', art: 'https://lh6.ggpht.com/art.jpg' });
      assert.equal(r.favorites.length, 3);
      assert.equal(r.playlists.length, 1);
      assert.equal(r.shortcuts, 1);
    });

    it('starts a favorite and a Spotify link, and the switch shows playing', async () => {
      const chose = await post({ choose: { id: 'FV:2/2', title: 'Q100 & Friends' } });
      assert.equal(chose.status, 200);
      assert.equal(((await chose.json()) as { playing: boolean }).playing, true);
      sonos.sent = [];
      const spotify = await post({ spotify: 'https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC?si=x' });
      assert.equal(spotify.status, 200);
      assert.match(sonos.sent.find((x) => x.action === 'AddURIToQueue')!.body, /1004206cspotify%3aalbum%3a4uLU6hMCjMI75M1A2tKUQC/);
    });

    it('says why it can’t: a bad link, a favorite that’s gone, no Spotify on the Sonos, Sonos refusing', async () => {
      assert.equal((await post({ spotify: 'https://open.spotify.com/artist/4uLU6hMCjMI75M1A2tKUQC' })).status, 400);
      assert.equal((await post({ choose: { id: 'Q:0' } })).status, 400);
      const gone = await post({ choose: { id: 'FV:2/40', title: 'Old Song' } });
      assert.equal(gone.status, 409);
      assert.match(((await gone.json()) as { error: string }).error, /Old Song.*isn’t in Sonos Favorites/);
      const refused = await post({ spotify: 'spotify:album:BADBADBADBADBADBADBADB' });
      assert.equal(refused.status, 502);
      assert.match(((await refused.json()) as { error: string }).error, /couldn’t play that Spotify album \(code 800\)/);
      sonos.favorites = FAVORITES.slice(0, 3);
      const none = await post({ spotify: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC' });
      assert.equal(none.status, 409);
      assert.match(((await none.json()) as { error: string }).error, /Play any Spotify song/);
    });
  });

  describe('what to play', () => {
    const queueOps = () => sonos.sent.filter((x) => /Queue|SetAVTransportURI|Seek|^Play$/.test(x.action));

    it('lists favorites and Sonos playlists, leaving out shortcuts, with web art only', async () => {
      const lib = await music.libraryOf('127.0.0.1');
      assert.deepEqual(lib.favorites.map((f) => [f.id, f.title, f.station, f.art]), [
        ['FV:2/3', 'Morning Song', false, 'https://lh6.ggpht.com/art.jpg'],
        ['FV:2/2', 'Q100 & Friends', true, null],
        ['FV:2/6', 'Snow Song', false, 'https://i.scdn.co/image/ab67'],
      ]);
      assert.equal(lib.shortcuts, 1);
      assert.deepEqual(lib.playlists.map((p) => [p.id, p.title, p.uri, p.art]), [['SQ:0', 'Dinner', 'file:///jffs/settings/savedqueues.rsq#0', null]]);
      assert.match(lib.favorites[1].meta, /<dc:title>Q100 &amp; Friends<\/dc:title>/, 'the metadata stays XML, as Sonos gave it');
    });

    it('finds a saved choice by id, or by its name when the id moved, and not a different one', () => {
      const lib = { favorites: [{ id: 'FV:2/9', title: 'Morning Song' }], playlists: [{ id: 'SQ:0', title: 'Dinner' }], shortcuts: 0 } as never;
      assert.equal(music.findChoice(lib, { id: 'FV:2/9', title: 'Morning Song' })?.id, 'FV:2/9');
      assert.equal(music.findChoice(lib, { id: 'FV:2/3', title: 'Morning Song' })?.id, 'FV:2/9', 're-made favorite');
      assert.equal(music.findChoice(lib, { id: 'FV:2/9', title: 'Evening Song' }), null, 'same id, different favorite now');
      assert.equal(music.findChoice(lib, { id: 'FV:2/1', title: 'Dinner' }), null, 'a playlist isn’t a favorite');
    });

    it('a station becomes the source; a song replaces the queue and plays from the top, on the group’s leader', async () => {
      const driver = new driverMod.SonosDriver();
      await driver.setPower('127.0.0.1', true, { uuid: KITCHEN, play: { id: 'FV:2/2', title: 'Q100 & Friends' } });
      assert.deepEqual(queueOps().map((x) => x.action), ['SetAVTransportURI', 'Play']);
      const set = queueOps()[0].body;
      assert.match(set, /<CurrentURI>x-sonosapi-stream:s21507\?sid=333&amp;flags=8224&amp;sn=4<\/CurrentURI>/);
      assert.match(set, /<CurrentURIMetaData>&lt;DIDL-Lite/, 'metadata sent escaped once');

      sonos.grouped = true; sonos.sent = [];
      sonos.state.localhost = 'PLAYING';
      await driver.setPower('127.0.0.1', true, { uuid: KITCHEN, play: { id: 'FV:2/3', title: 'Morning Song' } });
      assert.deepEqual(queueOps().map((x) => `${x.host} ${x.action}`), [
        'localhost AddURIToQueue', 'localhost RemoveTrackRangeFromQueue', 'localhost SetAVTransportURI', 'localhost Seek', 'localhost Play',
      ], 'started even though the group was already playing');
      assert.match(queueOps()[1].body, /<StartingIndex>1<\/StartingIndex><NumberOfTracks>5<\/NumberOfTracks>/, 'the 5 old tracks go, after the new ones are in');
      assert.equal(sonos.queueLength, 12);
      assert.match(queueOps()[2].body, new RegExp(`<CurrentURI>x-rincon-queue:${LIVING}#0</CurrentURI>`), 'the leader’s queue');
    });

    it('plays a Sonos playlist through the queue', async () => {
      await music.playOn('127.0.0.1', KITCHEN, (await music.libraryOf('127.0.0.1')).playlists[0]);
      const add = queueOps().find((x) => x.action === 'AddURIToQueue')!.body;
      assert.match(add, /<EnqueuedURI>file:\/\/\/jffs\/settings\/savedqueues.rsq#0<\/EnqueuedURI>/);
      assert.match(add, /SQ:0.*playlistContainer/);
    });

    it('a favorite Sonos refuses leaves the queue and what’s playing alone', async () => {
      sonos.favorites = [...FAVORITES, favorite('FV:2/9', 'Closed Service Song', 'x-sonos-http:dead.mp3?sid=151&flags=32&sn=2', 'instantPlay', 'object.item.audioItem.musicTrack')];
      sonos.state['127.0.0.1'] = 'PLAYING';
      await assert.rejects(new driverMod.SonosDriver().setPower('127.0.0.1', true, { uuid: KITCHEN, play: { id: 'FV:2/9', title: 'Closed Service Song' } }),
        (err: Error & { upnpCode?: number }) => err.upnpCode === 800);
      assert.deepEqual(queueOps().map((x) => x.action), ['AddURIToQueue'], 'nothing removed, nothing restarted');
      assert.equal(sonos.queueLength, 5);
      assert.equal(sonos.state['127.0.0.1'], 'PLAYING');
    });

    it('a favorite that’s gone says so, and plays nothing', async () => {
      await assert.rejects(new driverMod.SonosDriver().setPower('127.0.0.1', true, { uuid: KITCHEN, play: { id: 'FV:2/40', title: 'Old Song' } }),
        (err: Error & { code?: string }) => err.code === 'GONE' && /Old Song/.test(err.message));
      assert.deepEqual(queueOps(), []);
    });

    it('a saved choice is checked; Turn OFF ignores it and pauses', async () => {
      assert.equal(driverMod.playChoiceOf('{"id":"FV:2/3","title":"Morning Song"}')?.title, 'Morning Song');
      for (const bad of ['', 'nope', '{"id":"Q:0","title":"x"}', '{"id":"FV:2/3"}', '{"id":"FV:2/3","title":"  "}']) assert.equal(driverMod.playChoiceOf(bad), null, bad);
      assert.equal(driverMod.configWithPlay('{"uuid":"U"}', null), '{"uuid":"U"}');
      assert.deepEqual(JSON.parse(driverMod.configWithPlay('{"uuid":"U"}', { id: 'SQ:0', title: 'Dinner' })!), { uuid: 'U', play: { id: 'SQ:0', title: 'Dinner' } });
      sonos.state['127.0.0.1'] = 'PLAYING';
      await new driverMod.SonosDriver().setPower('127.0.0.1', false, { uuid: KITCHEN, play: { id: 'FV:2/3', title: 'Morning Song' } });
      assert.deepEqual(sonos.sent.filter((x) => /Pause|Queue|Play$/.test(x.action)).map((x) => x.action), ['Pause']);
    });
  });

  describe('Spotify links', () => {
    it('reads the links Spotify’s Share gives, and nothing else', () => {
      const id = '4uLU6hMCjMI75M1A2tKUQC';
      for (const [text, kind] of [
        [`https://open.spotify.com/track/${id}?si=a1b2c3`, 'track'],
        [`open.spotify.com/album/${id}`, 'album'],
        [`https://open.spotify.com/intl-de/playlist/${id}`, 'playlist'],
        [`  spotify:playlist:${id} `, 'playlist'],
      ] as const) assert.deepEqual(music.parseSpotifyLink(text), { kind, id }, text);
      for (const bad of [`https://open.spotify.com/artist/${id}`, `https://evil.example/track/${id}`, `spotify:track:${id}x`, 'https://spotify.link/abc', `https://open.spotify.com/track/${id} and more`]) {
        assert.equal(music.parseSpotifyLink(bad), null, bad);
      }
    });

    it('learns the Spotify account from what’s playing first, then the favorites', async () => {
      assert.deepEqual(await music.spotifyAccountOf('127.0.0.1'), { sid: 12, sn: 7 }, 'from the favorite');
      sonos.trackUri = 'x-sonos-spotify:spotify%3atrack%3aAAAAAAAAAAAAAAAAAAAAAA?sid=12&flags=8224&sn=9';
      assert.deepEqual(await music.spotifyAccountOf('127.0.0.1'), { sid: 12, sn: 9 }, 'what’s playing is freshest');
      sonos.trackUri = ''; sonos.favorites = FAVORITES.slice(0, 3);
      assert.equal(await music.spotifyAccountOf('127.0.0.1'), null);
    });

    it('builds what the Sonos app sends: a song’s address with the account, an album as a container', () => {
      const account = { sid: 12, sn: 7 };
      const song = music.spotifyPlayable({ kind: 'track', id: '4uLU6hMCjMI75M1A2tKUQC' }, account);
      assert.equal(song.uri, 'x-sonos-spotify:spotify%3atrack%3a4uLU6hMCjMI75M1A2tKUQC?sid=12&flags=8224&sn=7');
      assert.match(song.meta, /SA_RINCON3079_X_#Svc3079-0-Token/);
      const album = music.spotifyPlayable({ kind: 'album', id: '4uLU6hMCjMI75M1A2tKUQC' }, account);
      assert.equal(album.uri, 'x-rincon-cpcontainer:1004206cspotify%3aalbum%3a4uLU6hMCjMI75M1A2tKUQC');
      assert.match(album.meta, /object\.container\.album\.musicAlbum/);
      assert.match(music.spotifyPlayable({ kind: 'playlist', id: '4uLU6hMCjMI75M1A2tKUQC' }, account).uri, /^x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a/);
      assert.equal(song.station, false);
    });
  });
  describe('schedules and scenes', () => {
    let server: http.Server;
    let base = '';
    let speaker = 0;
    let plug = 0;
    before(async () => {
      const express = (await import('express')).default;
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.user = { sub: 1, name: 'admin', role: 'admin' } as never; next(); });
      app.use('/api/schedules', (await import('../routes/schedules')).schedulesRouter);
      app.use('/api/scenes', (await import('../routes/scenes')).scenesRouter);
      app.use('/internal', (await import('../routes/internal')).internalRouter);
      await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      // The Kitchen speaker the remote's tests added (addresses are unique), or a new one.
      db.prepare("INSERT OR IGNORE INTO devices (alias, ip, driver_type, driver_config) VALUES ('Kitchen Sonos', '127.0.0.1', 'sonos', ?)").run(JSON.stringify({ uuid: KITCHEN }));
      speaker = (db.prepare("SELECT id FROM devices WHERE ip = '127.0.0.1'").get() as { id: number }).id;
      plug = Number(db.prepare("INSERT INTO devices (alias, ip, driver_type) VALUES ('Lamp', '127.0.0.5', 'kasa')").run().lastInsertRowid);
    });
    after(() => new Promise<void>((ok) => server.close(() => ok())));
    const send = (method: string, url: string, body?: unknown) =>
      fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', 'x-internal-key': 'test-internal-key' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const morning = { id: 'FV:2/3', title: 'Morning Song' };

    it('a Play schedule keeps its favorite; other schedules don’t take one', async () => {
      const made = await (await send('POST', '/api/schedules', { deviceId: speaker, label: 'Wake up', triggerType: 'cron', cronExpression: '0 7 * * *', state: true, play: morning })).json() as { id: number; play: unknown };
      assert.deepEqual(made.play, morning);
      const pause = await (await send('POST', '/api/schedules', { deviceId: speaker, label: 'Quiet', triggerType: 'cron', cronExpression: '0 22 * * *', state: false, play: morning })).json() as { play: unknown };
      assert.equal(pause.play, null, 'a Pause schedule plays nothing');
      const lamp = await (await send('POST', '/api/schedules', { deviceId: plug, label: 'Lamp', triggerType: 'cron', cronExpression: '0 7 * * *', state: true, play: morning })).json() as { play: unknown };
      assert.equal(lamp.play, null);
      assert.equal((await send('POST', '/api/schedules', { deviceId: speaker, label: 'Bad', triggerType: 'cron', cronExpression: '0 7 * * *', state: true, play: { id: 'http://x' } })).status, 400);
      const edited = await (await send('PUT', `/api/schedules/${made.id}`, { deviceId: speaker, label: 'Wake up', triggerType: 'cron', cronExpression: '0 7 * * *', state: true })).json() as { play: unknown };
      assert.equal(edited.play, null, 'saving without one goes back to carrying on');
    });

    it('a schedule firing with its favorite starts it', async () => {
      const r = await send('POST', `/internal/devices/${speaker}/execute`, { state: true, label: 'Wake up', play: JSON.stringify(morning) });
      assert.equal(r.status, 200, await r.clone().text());
      assert.ok(sonos.sent.some((x) => x.action === 'AddURIToQueue' && /abc\.mp3/.test(x.body)));
    });

    it('a scene’s Play action keeps its favorite, and running the scene starts it', async () => {
      const made = await (await send('POST', '/api/scenes', { name: 'Morning', actions: [{ deviceId: speaker, state: true, play: { id: 'FV:2/2', title: 'Q100 & Friends' } }, { deviceId: plug, state: true }] })).json() as { id: number; actions: { play?: unknown }[] };
      assert.deepEqual(made.actions.map((a) => a.play ?? null), [{ id: 'FV:2/2', title: 'Q100 & Friends' }, null]);
      assert.equal((await send('PATCH', `/api/scenes/${made.id}`, { actions: [{ deviceId: speaker, state: true, play: 'Q100' }] })).status, 400);
      // Just the speaker, so the run doesn't wait on a lamp that isn't there.
      assert.equal((await send('PATCH', `/api/scenes/${made.id}`, { actions: [{ deviceId: speaker, state: true, play: { id: 'FV:2/2', title: 'Q100 & Friends' } }] })).status, 200);
      sonos.sent = [];
      await send('POST', `/api/scenes/${made.id}/run`);
      assert.match(sonos.sent.find((x) => x.action === 'SetAVTransportURI')?.body ?? '', /x-sonosapi-stream:s21507/);
    });
  });
  describe('the whole sound system', () => {
    let server: http.Server;
    let base = '';
    let kitchen = 0;
    let living = 0;
    before(async () => {
      const express = (await import('express')).default;
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.user = { sub: 1, name: 't', role: 'member' } as never; next(); });
      app.use('/api/sonos', routes.sonosRouter);
      await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      db.prepare("INSERT OR IGNORE INTO devices (alias, ip, driver_type, driver_config) VALUES ('Kitchen Sonos', '127.0.0.1', 'sonos', ?)").run(JSON.stringify({ uuid: KITCHEN }));
      db.prepare("INSERT OR IGNORE INTO devices (alias, ip, driver_type, driver_config) VALUES ('Living room Sonos', 'localhost', 'sonos', ?)").run(JSON.stringify({ uuid: LIVING }));
      kitchen = (db.prepare("SELECT id FROM devices WHERE ip = '127.0.0.1'").get() as { id: number }).id;
      living = (db.prepare("SELECT id FROM devices WHERE ip = 'localhost'").get() as { id: number }).id;
    });
    after(() => new Promise<void>((ok) => server.close(() => ok())));
    const post = (id: number, url: string, body: unknown) => fetch(`${base}/api/sonos/${id}/${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const sent = (action: string) => sonos.sent.filter((x) => x.action === action).map((x) => x.host);

    it('shows each group, its rooms and volumes, playing first', async () => {
      sonos.state.localhost = 'PLAYING';
      const sys = await (await fetch(`${base}/api/sonos/system`)).json() as { groups: { deviceId: number; rooms: { name: string; volume: number }[]; playing: boolean; groupVolume: number | null }[] };
      assert.deepEqual(sys.groups.map((g) => [g.deviceId, g.rooms.map((r) => r.name), g.playing, g.groupVolume]), [
        [living, ['Living room Sonos'], true, null],
        [kitchen, ['Kitchen Sonos'], false, null],
      ]);
      sonos.grouped = true;
      const together = await (await fetch(`${base}/api/sonos/system`)).json() as { groups: { deviceId: number; rooms: { name: string }[]; groupVolume: number | null }[] };
      assert.deepEqual(together.groups.map((g) => [g.deviceId, g.rooms.map((r) => r.name), g.groupVolume]), [[living, ['Living room Sonos', 'Kitchen Sonos'], 25]], 'the leader first, the hidden pair half left out');
    });

    it('adds a room: it joins the group’s leader, and nothing else changes', async () => {
      const r = await post(kitchen, 'play-on', { rooms: [kitchen, living] });
      assert.equal(r.status, 200);
      assert.deepEqual(sonos.sent.filter((x) => /x-rincon:/.test(x.body)).map((x) => [x.host, x.body.includes(KITCHEN)]), [['localhost', true]], 'the Living room joins the Kitchen');
      assert.deepEqual([...sent('BecomeCoordinatorOfStandaloneGroup'), ...sent('DelegateGroupCoordinationTo')], []);
    });

    it('takes a room out: it leaves; taking the leader out hands the music to a room that stays', async () => {
      sonos.grouped = true;
      await post(kitchen, 'play-on', { rooms: [living] });
      assert.deepEqual(sent('BecomeCoordinatorOfStandaloneGroup'), ['127.0.0.1']);
      assert.deepEqual(sent('DelegateGroupCoordinationTo'), []);
      sonos.grouped = true; sonos.sent = [];
      await post(kitchen, 'play-on', { rooms: [kitchen] });
      assert.deepEqual(sent('DelegateGroupCoordinationTo'), ['localhost']);
      assert.match(sonos.sent.find((x) => x.action === 'DelegateGroupCoordinationTo')!.body, new RegExp(`<NewCoordinator>${KITCHEN}</NewCoordinator><RejoinGroup>0`));
      assert.deepEqual(sent('BecomeCoordinatorOfStandaloneGroup'), [], 'the old leader already left');
    });

    it('everywhere adds every speaker; a bad list is refused', async () => {
      await post(kitchen, 'play-on', { everywhere: true });
      assert.deepEqual(sonos.sent.filter((x) => /x-rincon:/.test(x.body)).map((x) => x.host), ['localhost']);
      for (const bad of [{ rooms: [] }, { rooms: [99999] }, { rooms: 'all' }, {}]) assert.equal((await post(kitchen, 'play-on', bad)).status, 400, JSON.stringify(bad));
    });

    it('moves the whole group’s volume on its leader', async () => {
      sonos.grouped = true;
      assert.equal((await post(kitchen, 'group-volume', { step: 'up' })).status, 200);
      assert.deepEqual(sonos.sent.filter((x) => /GroupVolume/.test(x.action)).map((x) => `${x.host} ${x.action}`).filter((x) => !x.includes('Get')),
        ['localhost SnapshotGroupVolume', 'localhost SetRelativeGroupVolume']);
      assert.match(sonos.sent.find((x) => x.action === 'SetRelativeGroupVolume')!.body, /<Adjustment>2<\/Adjustment>/);
      assert.equal((await post(kitchen, 'group-volume', { step: 5 })).status, 400);
    });
  });
});
