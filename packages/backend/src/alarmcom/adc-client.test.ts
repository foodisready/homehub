/**
 * The Alarm.com client against a fake Alarm.com on localhost: sign-in with its redirects and
 * cookies, two-step verification, reading the alarm, keep-alive and commands. No real network.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  AdcConnection, AdcLiveSession, devBase, errorCode, parseHistory, socketUrl, hiddenField, parseCatalog, parseEvent, sensorKind, sensorState, signIn,
} from './adc-client';
import { AdcError } from './types';

const LOGIN_PAGE = `<html><form name="aspnetForm" method="post" action="./login.aspx" id="aspnetForm">
<input type="hidden" name="__EVENTTARGET" id="__EVENTTARGET" value="" />
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="vs+/=&amp;1" />
<input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="C2EE9ABB" />
<input type="hidden" name="__PREVIOUSPAGE" id="__PREVIOUSPAGE" value="prev" />
<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="ev" />
<input name="ctl00$ContentPlaceHolder1$loginform$txtUserName" type="text" />
<input name="txtPassword" type="password" /></form></html>`;

const CATALOG = {
  data: { id: 13276704, type: 'settings/manage-devices/device-catalog' },
  included: [
    {
      id: '555-127', type: 'devices/partition',
      attributes: { state: 1, desiredState: 3, description: 'House', extendedArmingOptions: { ArmedStay: [2, 1, 0, 4], ArmedAway: [[2, 1], 0], ArmedNight: [] } },
      relationships: { sensors: { data: [{ id: '555-1', type: 'devices/sensor' }, { id: '555-5', type: 'devices/sensor' }] } },
    },
    { id: '555-1', type: 'devices/sensor', attributes: { description: 'GARAGE DR', deviceType: 1, state: 2, isBypassed: false } },
    { id: '555-8', type: 'devices/sensor', attributes: { description: 'L Family Wndw', deviceType: 1, state: 1, lowBattery: true } },
    { id: '555-5', type: 'devices/sensor', attributes: { description: 'MOTION', deviceType: 2, state: 4 } },
    { id: '555-12', type: 'devices/sensor', attributes: { description: 'CENTER BASEMENT', deviceType: 1, state: 10, displayStateText: 'Not Reset' } },
    { id: '555-19', type: 'devices/sensor', attributes: { description: 'Glass', deviceType: 19, state: 1, isBypassed: true } },
    { id: '555-99', type: 'devices/lock', attributes: { description: 'Front lock' } },
  ],
};

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

const server = {
  seen: [] as Seen[],
  password: 'right',
  /** Ask for a code unless the trust cookie comes. */
  twoFactor: true,
  expired: false,
  keepAliveExpired: false,
  lockedOut: false,
  commandStatus: 200,
};

function cookies(req: http.IncomingMessage): Record<string, string> {
  return Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
}

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

function handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
  const url = new URL(req.url!, 'http://x');
  const c = cookies(req);
  const signedIn = c.auth === 'A1' && !server.expired;
  const ajaxOk = req.headers.ajaxrequestuniquekey === 'AFG1';
  const p = url.pathname;
  if (req.method === 'GET' && p === '/login') {
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'ASP.NET_SessionId=s1; path=/; HttpOnly' });
    res.end(LOGIN_PAGE);
    return;
  }
  if (req.method === 'POST' && p === '/web/Default.aspx') {
    const form = new URLSearchParams(body);
    const ok = c['ASP.NET_SessionId'] === 's1' && form.get('__VIEWSTATE') === 'vs+/=&1' && form.get('IsFromNewSite') === '1'
      && form.get('ctl00$ContentPlaceHolder1$loginform$txtUserName') === 'home' && form.get('txtPassword') === server.password;
    if (server.lockedOut) { res.writeHead(302, { location: '/login?m=LockedOut' }); res.end(); return; }
    if (!ok) { res.writeHead(302, { location: '/login?m=login_fail' }); res.end(); return; }
    // The cookies that matter arrive on a hop in the middle.
    res.writeHead(302, { location: '/web/redirect', 'set-cookie': ['auth=A1; path=/; secure; HttpOnly', 'afg=AFG1; path=/'] });
    res.end();
    return;
  }
  if (p === '/web/redirect') { res.writeHead(302, { location: '/web/system/home' }); res.end(); return; }
  if (p === '/web/system/home') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>home</html>'); return; }
  if (p === '/web/KeepAlive.aspx') { res.writeHead(server.keepAliveExpired || !signedIn ? 403 : 200); res.end(); return; }
  if (!signedIn) { res.writeHead(302, { location: '/login?m=no_session' }); res.end(); return; }
  if (!ajaxOk) return json(res, 403, { errors: [{ status: '403', code: 403, detail: 'Invalid Anti Forgery' }] });
  if (p === '/web/api/identities') {
    return json(res, 200, { data: [{ id: 15672471, type: 'identity', attributes: { applicationSessionProperties: { keepAliveUrl: '/web/KeepAlive.aspx', inactivityWarningTimeoutMs: 780000 } }, relationships: { selectedSystem: { data: { id: '13276704' } } } }] });
  }
  const tf = '/web/api/engines/twoFactorAuthentication/twoFactorAuthentications/15672471';
  if (p === tf) {
    const trusted = c.twoFactorAuthenticationId === 'T1';
    return json(res, 200, { data: { id: 1, attributes: { enabledTwoFactorTypes: server.twoFactor ? 6 : 0, isCurrentDeviceTrusted: trusted, showSuggestedSetup: false } } });
  }
  if (p === `${tf}/sendTwoFactorAuthenticationCodeViaSms`) return json(res, 200, { value: null, errors: [] });
  if (p === `${tf}/verifyTwoFactorCode`) {
    const b = JSON.parse(body);
    if (b.code !== '123456' || b.typeOf2FA !== 2) return json(res, 422, { errors: [{ status: '422', code: 422, detail: 'The entered verification code is invalid.' }] });
    return json(res, 200, { value: { deviceName: 'Windows' }, errors: [] });
  }
  if (p === `${tf}/trustTwoFactorDevice`) {
    res.writeHead(302, { location: '/web/api/trusted', 'set-cookie': 'twoFactorAuthenticationId=T1; domain=.alarm.com; path=/; secure; HttpOnly' });
    res.end();
    return;
  }
  if (p === '/web/api/trusted') return json(res, 200, { value: {}, errors: [] });
  if (p === '/web/api/systems/availableSystemItems') return json(res, 200, { data: [{ id: '13276704', attributes: { isSelected: true } }] });
  if (p === '/web/api/settings/manageDevices/deviceCatalogs/13276704') return json(res, 200, CATALOG);
  if (p === '/web/api/identities/15672471/reloadContext') return json(res, 200, { data: {} });
  if (p.startsWith('/web/api/devices/partitions/555-127/')) {
    if (server.commandStatus !== 200) return json(res, server.commandStatus, { errors: [{ code: server.commandStatus, detail: 'Nope' }] });
    return json(res, 200, { data: { id: '555-127' } });
  }
  if (p === '/web/api/activity/activityDays') {
    const page = Number(url.searchParams.get('page'));
    const n = page === 1 ? 100 : 1;
    return json(res, 200, { data: [], included: Array.from({ length: n }, (_, i) => ({ id: `M-${page}-${i}`, type: 'activity/history-event', attributes: { eventDate: new Date(Date.UTC(2026, 10, 22, 1, page, i % 60)).toISOString(), globalDeviceId: '555-1', eventTypeName: 'Opened' } })) });
  }
  if (p === '/web/api/websockets/token') return json(res, 200, { value: 'tok', metaData: { endpoint: 'wss://ws.example:8443' } });
  res.writeHead(404); res.end();
}

process.env.ALARMCOM_WS_SETTLED_MS = '60';
process.env.ALARMCOM_WS_RETRY_MS = '5';

describe('Alarm.com client', () => {
  let app: http.Server;
  let base: string;

  before(async () => {
    app = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => { server.seen.push({ method: req.method!, url: req.url!, headers: req.headers, body }); handle(req, res, body); });
    });
    await new Promise<void>((ok) => { app.listen(0, '127.0.0.1', () => ok()); });
    base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  });

  after(async () => {
    app.closeAllConnections();
    await new Promise<void>((ok) => app.close(() => ok()));
  });

  beforeEach(() => {
    Object.assign(server, { seen: [], password: 'right', twoFactor: true, expired: false, keepAliveExpired: false, lockedOut: false, commandStatus: 200 });
  });

  const noSocket = () => { throw new Error('no websocket in this test'); };

  describe('signing in', () => {
    it('signs in, keeping the cookies set on a redirect in the middle, then asks for a code', async () => {
      const r = await signIn('home', 'right', null, fetch, base, noSocket);
      assert.equal(r.kind, 'code');
      if (r.kind !== 'code') return;
      assert.deepEqual(r.methods, ['sms', 'email']);
      // Every API call carried the afg cookie as Ajaxrequestuniquekey.
      const api = server.seen.filter((s) => s.url.startsWith('/web/api/'));
      assert.ok(api.length >= 2);
      for (const s of api) assert.equal(s.headers.ajaxrequestuniquekey, 'AFG1');
      // A browser's User-Agent, and a real Referer.
      assert.match(String(server.seen[0].headers['user-agent']), /Chrome/);

      assert.equal(await r.challenge.send('sms'), null);
      await assert.rejects(r.challenge.verify('000000', 'sms'), (e: AdcError) => e.kind === 'rejected');
      const done = await r.challenge.verify('123456', 'sms');
      assert.equal(done.trust, 'T1');   // set on a redirect hop
      const snap = await done.session.read();
      assert.equal(snap.partitions.length, 1);
      assert.equal(snap.sensors.length, 5);
      const trust = server.seen.find((s) => s.url.endsWith('/trustTwoFactorDevice'))!;
      assert.match(JSON.parse(trust.body).deviceName, /^HomeHub/);
    });

    it('skips the code with the trust cookie', async () => {
      const r = await signIn('home', 'right', 'T1', fetch, base, noSocket);
      assert.equal(r.kind, 'ok');
      const login = server.seen.find((s) => s.url === '/web/Default.aspx')!;
      assert.match(String(login.headers.cookie), /twoFactorAuthenticationId=T1/);
    });

    it('skips the code when the account has no two-step verification', async () => {
      server.twoFactor = false;
      assert.equal((await signIn('home', 'right', null, fetch, base, noSocket)).kind, 'ok');
    });

    it('says a wrong password is a wrong password', async () => {
      await assert.rejects(signIn('home', 'wrong', null, fetch, base, noSocket), (e: AdcError) => e.kind === 'rejected' && /didn’t accept/.test(e.message));
    });

    it('says a locked account is locked', async () => {
      server.lockedOut = true;
      await assert.rejects(signIn('home', 'right', null, fetch, base, noSocket), (e: AdcError) => e.kind === 'rejected' && /locked/.test(e.message));
    });

    it('calls a missing server unreachable, not a wrong password', async () => {
      await assert.rejects(signIn('home', 'right', null, fetch, 'http://127.0.0.1:9', noSocket), (e: AdcError) => e.kind === 'unreachable');
    });
  });

  describe('a session', () => {
    async function session(): Promise<AdcLiveSession> {
      const r = await signIn('home', 'right', 'T1', fetch, base, noSocket);
      assert.equal(r.kind, 'ok');
      return (r as unknown as { session: AdcLiveSession }).session;
    }

    it('notices when the session ended', async () => {
      const s = await session();
      server.expired = true;
      await assert.rejects(s.read(), (e: AdcError) => e.kind === 'expired');
    });

    it('keeps the session alive, and says when it has ended', async () => {
      const s = await session();
      await s.keepAlive();
      assert.ok(server.seen.some((x) => /^\/web\/KeepAlive\.aspx\?timestamp=\d+$/.test(x.url)));
      server.keepAliveExpired = true;
      await assert.rejects(s.keepAlive(), (e: AdcError) => e.kind === 'expired');
    });

    it('refreshes the session context every 13 minutes', async () => {
      const s = await session();
      await s.conn.keepAlive(Date.now() + 14 * 60_000);
      assert.ok(server.seen.some((x) => x.url === '/web/api/identities/15672471/reloadContext' && x.method === 'POST'));
    });

    it('sends arm and disarm with the body Alarm.com expects', async () => {
      const s = await session();
      await s.command('555-127', 'armAway', { bypass: true });
      await s.command('555-127', 'armNight', { bypass: false });
      await s.command('555-127', 'disarm', { bypass: true });
      const sent = server.seen.filter((x) => x.url.startsWith('/web/api/devices/partitions/'));
      assert.deepEqual(sent.map((x) => x.url), ['/web/api/devices/partitions/555-127/armAway', '/web/api/devices/partitions/555-127/armStay', '/web/api/devices/partitions/555-127/disarm']);
      const bodies = sent.map((x) => JSON.parse(x.body));
      assert.deepEqual(bodies[0], { statePollOnly: false, forceBypass: true, noEntryDelay: false, silentArming: false, nightArming: false, selectiveBypass: false, forceArm: false });
      assert.equal(bodies[1].nightArming, true);
      assert.equal(bodies[2].forceBypass, false);   // never with disarm
      for (const x of sent) assert.equal(x.headers.ajaxrequestuniquekey, 'AFG1');
    });

    it('turns Alarm.com’s refusal into a refused command', async () => {
      const s = await session();
      server.commandStatus = 422;
      await assert.rejects(s.command('555-127', 'armAway', { bypass: false }), (e: AdcError) => e.kind === 'refused' && e.message === 'Nope');
      // Sent once only.
      assert.equal(server.seen.filter((x) => x.url.startsWith('/web/api/devices/partitions/')).length, 1);
    });

    it('asks for the history since a time, page by page', async () => {
      const s = await session();
      const got = await s.history(new Date('2026-11-22T00:00:00.000Z'));
      assert.equal(got.length, 101);   // two pages
      const asked = server.seen.filter((x) => x.url.startsWith('/web/api/activity/activityDays'));
      assert.equal(asked.length, 2);
      const q = new URL(asked[0].url, 'http://x').searchParams;
      assert.equal(q.get('startTime'), '2026-11-22T00:00:00.000Z');
      assert.equal(q.get('pageSize'), '100');
      assert.equal(q.get('page'), '1');
      assert.equal(new URL(asked[1].url, 'http://x').searchParams.get('page'), '2');
      assert.equal(asked[0].headers.ajaxrequestuniquekey, 'AFG1');
    });

    it('gets the live-update token and endpoint', async () => {
      const s = await session();
      assert.deepEqual(await s.conn.wsToken(), { token: 'tok', endpoint: 'wss://ws.example:8443' });
    });

    type FakeSock = { url: string; headers: Record<string, string>; onopen: (() => void) | null; onclose: ((e: { code: number; reason?: string }) => void) | null; onmessage: ((e: { data: unknown }) => void) | null; closed: boolean };
    async function liveSession(sockets: FakeSock[]): Promise<AdcLiveSession> {
      const r = await signIn('home', 'right', 'T1', fetch, base, (url, headers) => {
        const sock: FakeSock = { url, headers, onopen: null, onclose: null, onmessage: null, closed: false };
        sockets.push(sock);
        return { ...sock, close() { sock.closed = true; }, set onopen(f: never) { sock.onopen = f; }, set onclose(f: never) { sock.onclose = f; }, set onmessage(f: never) { sock.onmessage = f; }, set onerror(_f: never) { /* unused */ } } as never;
      });
      return (r as unknown as { session: AdcLiveSession }).session;
    }
    const tick = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

    it('opens the live connection with the token and the session’s cookies, and counts it live once it stays open', async () => {
      const sockets: FakeSock[] = [];
      const s = await liveSession(sockets);
      const events: unknown[] = [];
      const states: boolean[] = [];
      const stop = s.watch((e) => events.push(e), (live) => states.push(live));
      await tick(50);
      assert.equal(sockets.length, 1);
      assert.equal(sockets[0].url, 'wss://ws.example:8443/?f=1&auth=tok');
      assert.match(sockets[0].headers.Cookie, /auth=A1/);
      assert.equal(sockets[0].headers.Origin, base);
      sockets[0].onopen!();
      assert.deepEqual(states, []);             // not yet: it must stay open a moment
      await tick(80);                            // ALARMCOM_WS_SETTLED_MS
      assert.deepEqual(states, [true]);
      assert.deepEqual(events, [{ kind: 'other' }]);   // one read to catch up
      sockets[0].onmessage!({ data: Buffer.from(JSON.stringify({ UnitId: 555, DeviceId: 1, EventType: 15, EventValue: 0, QstringForExtraData: 'openClosedStatusWord=open' })) });
      assert.deepEqual(events.at(-1), { kind: 'sensor', id: '555-1', state: 'open' });
      stop();
      s.close();
    });

    it('backs off when Alarm.com keeps refusing the live connection, then rests', async () => {
      const sockets: FakeSock[] = [];
      const s = await liveSession(sockets);
      const reasons: string[] = [];
      const stop = s.watch(() => undefined, (_live, reason) => { if (reason) reasons.push(reason); });
      const gaps: number[] = [];
      let last = Date.now();
      for (let i = 0; i < 6; i++) {
        for (let w = 0; w < 200 && sockets.length <= i; w++) await tick(5);
        assert.equal(sockets.length, i + 1, `connection ${i + 1}`);
        gaps.push(Date.now() - last);
        last = Date.now();
        sockets[i].onopen!();
        sockets[i].onclose!({ code: 1008, reason: 'rejected token' });   // turned away at once
      }
      // Each wait longer than the one before.
      for (let i = 2; i < gaps.length; i++) assert.ok(gaps[i] > gaps[i - 1], `gaps ${gaps.join(',')}`);
      assert.match(reasons.at(-1)!, /refused 6 times.*rejected token.*4 h/);
      await tick(300);
      assert.equal(sockets.length, 6);   // resting
      stop();
      s.close();
    });
  });

  describe('reading Alarm.com’s answers', () => {
    it('reads partitions and sensors from the device catalog', () => {
      const snap = parseCatalog(CATALOG);
      assert.deepEqual(snap.partitions, [{ id: '555-127', name: 'House', state: 'disarmed', pending: 'armed-away', canNight: false, sensorIds: ['555-1', '555-5'] }]);
      assert.deepEqual(snap.sensors.map((s) => [s.name, s.kind, s.state, s.bypassed, s.lowBattery]), [
        ['GARAGE DR', 'door', 'open', false, false],
        ['L Family Wndw', 'window', 'closed', false, true],
        ['MOTION', 'motion', 'active', false, false],
        ['CENTER BASEMENT', 'door', 'unknown', false, false],
        ['Glass', 'glass', 'idle', true, false],
      ]);
      assert.equal(snap.sensors.find((x) => x.name === 'CENTER BASEMENT')!.label, 'Not Reset');
    });

    it('treats an unreadable answer as empty, not a crash', () => {
      assert.deepEqual(parseCatalog(null), { partitions: [], sensors: [] });
      assert.deepEqual(parseCatalog({ included: [{ type: 'devices/sensor', attributes: {} }] }), { partitions: [], sensors: [] });
    });

    it('knows night arming when the panel offers it', () => {
      const snap = parseCatalog({ included: [{ id: 'p', type: 'devices/partition', attributes: { state: 4, desiredState: 4, extendedArmingOptions: { ArmedNight: [[3]] } } }] });
      assert.equal(snap.partitions[0].canNight, true);
      assert.equal(snap.partitions[0].state, 'armed-night');
      assert.equal(snap.partitions[0].pending, null);
    });

    it('reads sensor kinds and states', () => {
      assert.equal(sensorKind(1, 'BACK DR'), 'door');
      assert.equal(sensorKind(1, 'R Basement window'), 'window');
      assert.equal(sensorKind(89, 'x'), 'motion');
      assert.equal(sensorKind(5, 'x'), 'smoke');
      assert.equal(sensorKind(77, 'x'), 'other');
      assert.equal(sensorState(9, 'door'), 'closed');
      assert.equal(sensorState(6, 'other'), 'wet');
      assert.equal(sensorState(42, 'door'), 'unknown');
    });

    it('reads websocket events', () => {
      const ev = (EventType: number, extra = {}) => parseEvent(JSON.stringify({ UnitId: 555, DeviceId: 127, EventType, EventValue: 0, QstringForExtraData: null, ...extra }));
      assert.deepEqual(ev(10), { kind: 'partition', id: '555-127', state: 'armed-away' });
      assert.deepEqual(ev(8), { kind: 'partition', id: '555-127', state: 'disarmed' });
      assert.deepEqual(ev(9), { kind: 'partition', id: '555-127', state: 'armed-stay' });
      assert.deepEqual(ev(0), { kind: 'sensor', id: '555-127', state: 'closed' });
      assert.deepEqual(ev(100), { kind: 'sensor', id: '555-127', state: 'pulse' });
      assert.deepEqual(ev(13), { kind: 'bypass', id: '555-127', bypassed: true });
      assert.equal(ev(101), null);
      assert.deepEqual(ev(55), { kind: 'other' });
      assert.equal(parseEvent('not json'), null);
      assert.equal(parseEvent(JSON.stringify({ EventType: 1, CorrelatedId: 5 })), null);
      assert.equal(parseEvent(JSON.stringify({ Property: 1, PropertyValue: 2 })), null);
    });

    it('reads the activity history, newest last, with who did it', () => {
      const body = { data: [{ id: 'd1', type: 'activity/activity-day' }], included: [
        { id: 'M-2', type: 'activity/history-event', attributes: { eventDate: '2026-11-22T23:40:02.558Z', globalDeviceId: '555-127', deviceDescription: 'System', eventTypeName: 'ArmedStay', description: 'Armed Stay by Anna', extraData: 'ew_contact_id=1&ew=Anna+B&ew_group_id=0' } },
        { id: 'M-1', type: 'activity/history-event', attributes: { eventDate: '2026-11-22T23:34:00Z', unitId: 555, deviceId: 3, deviceDescription: 'BACK DOOR', eventTypeName: 'OpenedClosed', description: 'Opened/Closed', extraData: null } },
        { id: 'bad', type: 'activity/history-event', attributes: { eventDate: 'never' } },
        { id: 'x', type: 'devices/sensor', attributes: {} },
      ] };
      assert.deepEqual(parseHistory(body), [
        { id: 'M-1', at: '2026-11-22T23:34:00.000Z', deviceId: '555-3', deviceName: 'BACK DOOR', type: 'OpenedClosed', description: 'Opened/Closed', who: null },
        { id: 'M-2', at: '2026-11-22T23:40:02.558Z', deviceId: '555-127', deviceName: 'System', type: 'ArmedStay', description: 'Armed Stay by Anna', who: 'Anna B' },
      ]);
      assert.deepEqual(parseHistory(null), []);
    });

    it('puts the live-update token in the address as issued', () => {
      assert.equal(socketUrl('wss://w:8443', 'ab+c/d=='), 'wss://w:8443/?f=1&auth=ab+c/d==');
      assert.equal(socketUrl('wss://w:8443', 'a&b#c'), 'wss://w:8443/?f=1&auth=a%26b%23c');
    });

    it('reads hidden fields and error codes', () => {
      assert.equal(hiddenField(LOGIN_PAGE, '__VIEWSTATE'), 'vs+/=&1');
      assert.equal(hiddenField(LOGIN_PAGE, '__NOPE'), null);
      assert.equal(errorCode({ errors: [{ status: '409' }] }), 409);
      assert.equal(errorCode({ errors: [{ code: 422, status: '422' }] }), 422);
      assert.equal(errorCode({ errors: [] }), null);
      assert.equal(errorCode({ data: {} }), null);
    });

    it('sends nothing to a server that isn’t Alarm.com, except a fake one on this computer', () => {
      assert.equal(new AdcConnection().base, 'https://www.alarm.com');
      assert.equal(devBase(undefined), 'https://www.alarm.com');
      assert.equal(devBase('http://127.0.0.1:3399/x'), 'http://127.0.0.1:3399');
      assert.equal(devBase('http://evil.example'), 'https://www.alarm.com');
      assert.equal(devBase('https://localhost:1'), 'https://www.alarm.com');
      assert.equal(devBase('nonsense'), 'https://www.alarm.com');
    });
  });
});
