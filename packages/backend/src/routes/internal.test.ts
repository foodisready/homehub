/**
 * Black-box tests for /internal/sensors/flow/readings — focused on the
 * meterReachable path. Older firmware (no field) is treated as
 * meterReachable=true; explicit false skips the readings INSERT and
 * leak engine but still refreshes diagnostics.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import express from 'express';
import http from 'node:http';

const TMP_DB = path.join(os.tmpdir(), `homehub-internal-test-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_PATH = TMP_DB;
process.env.INTERNAL_API_KEY = 'test-internal-key';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret';

import { getDb } from '../db';
import { internalRouter } from './internal';
import { getDriver } from '../drivers/registry';

let server: http.Server;
let baseUrl: string;
let sensorId: number;

before(async () => {
  getDb();

  const db = getDb();
  db.prepare("INSERT INTO sensors (sensor_id, type, alias) VALUES (?, ?, ?)")
    .run('auraflow-mainline-01', 'flow', 'Main line');
  const sensor = db.prepare("SELECT id FROM sensors WHERE sensor_id = ?").get('auraflow-mainline-01') as { id: number };
  sensorId = sensor.id;

  const app = express();
  app.use(express.json());
  app.use('/internal', internalRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  try { getDb().close(); } catch {}
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + ext); } catch {}
  }
});

beforeEach(() => {
  // Clean per-test state but keep the seeded sensor.
  getDb().prepare('DELETE FROM flow_readings').run();
  getDb().prepare('DELETE FROM flow_events').run();
  getDb().prepare(`
    UPDATE sensors
       SET last_seen_at = NULL,
           last_rssi = NULL,
           last_uptime_sec = NULL,
           last_signal_quality = NULL,
           firmware_version = NULL,
           last_ip = NULL,
           pending_state = 'idle',
           pending_count = 0
  `).run();
});

const HEADERS = { 'Content-Type': 'application/json', 'X-Internal-Key': 'test-internal-key' };

async function postReading(body: unknown) {
  return fetch(`${baseUrl}/internal/sensors/flow/readings`, {
    method:  'POST',
    headers: HEADERS,
    body:    JSON.stringify(body),
  });
}

function readSensor() {
  return getDb().prepare('SELECT * FROM sensors WHERE id = ?').get(sensorId) as {
    last_seen_at: string | null;
    last_rssi: number | null;
    firmware_version: string | null;
    last_ip: string | null;
  };
}

function readingCount() {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM flow_readings').get() as { n: number }).n;
}

describe('POST /internal/sensors/flow/readings — meterReachable handling', () => {
  // Runs first to stay under the per-sensor rate limit (10/sec) — the
  // phantom-event test below burns through most of the bucket.
  it('responds with the same poll-cadence shape so firmware can adapt', async () => {
    const r = await postReading({
      sensorId: 'auraflow-mainline-01',
      rateM3h:  0,
      meterReachable: false,
    });
    const body = await r.json() as Record<string, number>;
    assert.equal(typeof body.pollIntervalMs,        'number');
    assert.equal(typeof body.flowingPollIntervalMs, 'number');
    assert.equal(typeof body.idlePollIntervalMs,    'number');
  });

  it('treats a missing meterReachable field as true (back-compat)', async () => {
    const r = await postReading({
      sensorId: 'auraflow-mainline-01',
      rateM3h:  0.42,
      rssi:     -55,
      firmwareVersion: '0.1.0-c',
    });
    assert.equal(r.status, 200);
    assert.equal(readingCount(), 1, 'reading was inserted');

    const s = readSensor();
    assert.ok(s.last_seen_at, 'last_seen_at refreshed');
    assert.equal(s.last_rssi, -55);
    assert.equal(s.firmware_version, '0.1.0-c');
  });

  it('treats meterReachable: true the same as omitted', async () => {
    const r = await postReading({
      sensorId: 'auraflow-mainline-01',
      rateM3h:  0.42,
      meterReachable: true,
    });
    assert.equal(r.status, 200);
    assert.equal(readingCount(), 1);
  });

  it('skips flow_readings INSERT when meterReachable is false but still refreshes diagnostics', async () => {
    const r = await postReading({
      sensorId: 'auraflow-mainline-01',
      rateM3h:  0,
      meterReachable: false,
      rssi:     -60,
      firmwareVersion: '0.1.0-c',
    });
    assert.equal(r.status, 200);
    assert.equal(readingCount(), 0, 'no reading row');

    const s = readSensor();
    assert.ok(s.last_seen_at, 'last_seen_at still refreshed on heartbeat');
    assert.equal(s.last_rssi, -60);
    assert.equal(s.firmware_version, '0.1.0-c');
    assert.ok(s.last_ip, 'last_ip captured even on diagnostic heartbeat');
  });

  it('does not open a phantom flow event on diagnostic heartbeat', async () => {
    // First post a real flow reading to confirm an event WOULD open here.
    await postReading({ sensorId: 'auraflow-mainline-01', rateM3h: 0.5 });
    await postReading({ sensorId: 'auraflow-mainline-01', rateM3h: 0.5 });
    const eventsBefore = (getDb().prepare('SELECT COUNT(*) AS n FROM flow_events').get() as { n: number }).n;

    // Now several heartbeats: no new events should be created.
    for (let i = 0; i < 5; i++) {
      await postReading({ sensorId: 'auraflow-mainline-01', rateM3h: 0, meterReachable: false });
    }
    const eventsAfter = (getDb().prepare('SELECT COUNT(*) AS n FROM flow_events').get() as { n: number }).n;
    assert.equal(eventsAfter, eventsBefore, 'heartbeat path did not open or close events');
  });

});

describe('/internal/voice', () => {
  const key = { 'X-Internal-Key': 'test-internal-key', 'Content-Type': 'application/json' };
  const calls: { ip: string; state: boolean }[] = [];

  const say = async (text: unknown) => {
    const res = await fetch(`${baseUrl}/internal/voice/command`, {
      method: 'POST', headers: key, body: JSON.stringify({ text }),
    });
    return { status: res.status, body: await res.json() as any };
  };

  before(() => {
    getDriver('kasa').setPower = async (ip: string, state: boolean) => { calls.push({ ip, state }); };
    const add = getDb().prepare('INSERT INTO devices (alias, ip, nicknames) VALUES (?, ?, ?)');
    add.run('My office lamp', '10.9.0.1', '["desk light"]');
    add.run('Main Valve', '10.9.0.2', '[]');
  });

  beforeEach(() => { calls.length = 0; });

  it('turning a thermostat off is asked aloud, and done on a yes', async () => {
    getDriver('honeywell').setPower = async (ip: string, state: boolean) => { calls.push({ ip, state }); };
    getDb().prepare("INSERT INTO devices (alias, ip, driver_type, driver_config) VALUES ('Upstairs Thermostat', 'honeywell:7', 'honeywell', '{\"kind\":\"thermostat\",\"deviceId\":7}')").run();
    try {
      // The bridge's quick first hearing: it sends retry, not ask, but listens for a question.
      const res = await fetch(`${baseUrl}/internal/voice/command`, {
        method: 'POST', headers: key, body: JSON.stringify({ text: 'turn off upstairs thermostat', retry: true, questions: true }),
      });
      const body = await res.json() as any;
      assert.equal(body.handled, true, 'understood: asked now, not heard again first');
      assert.equal(body.say, 'Should I turn off Upstairs Thermostat?');
      assert.equal(typeof body.confirmId, 'string');
      assert.deepEqual(calls, []);
      const yes = await fetch(`${baseUrl}/internal/voice/confirm/${body.confirmId}`, { method: 'POST', headers: key, body: JSON.stringify({ answer: 'yes' }) });
      const done = await yes.json() as any;
      assert.equal(done.handled, true);
      assert.deepEqual(calls, [{ ip: 'honeywell:7', state: false }]);
      // A bridge that can't ask is told to use the card.
      const old = await say('turn off upstairs thermostat');
      assert.match(old.body.response, /needs a yes/);
      assert.equal(calls.length, 1);
    } finally {
      getDb().prepare("DELETE FROM devices WHERE alias = 'Upstairs Thermostat'").run();
    }
  });

  it('runs a command the rules understand, including trailing punctuation', async () => {
    const { body } = await say('Turn on my office lamp.');
    assert.equal(body.handled, true);
    assert.equal(body.response, 'Turned on My office lamp.');
    assert.deepEqual(calls, [{ ip: '10.9.0.1', state: true }]);
  });

  it('accepts a command whose first word was cut off', async () => {
    const { body } = await say('off my office lamp.');
    assert.equal(body.response, 'Turned off My office lamp.');
    assert.deepEqual(calls, [{ ip: '10.9.0.1', state: false }]);
  });

  it('accepts a comma after a cut-off first word', async () => {
    assert.equal((await say('Off, My office lamp.')).body.response, 'Turned off My office lamp.');
    assert.equal((await say('On , my office lamp')).body.response, 'Turned on My office lamp.');
    assert.equal((await say('Office lamp')).body.handled, false);   // a name starting with "off" stays a name
  });

  it('accepts a comma after the whole verb, as speech recognition writes it', async () => {
    // From the Pi's log: "Turn off, Office light." wasn't understood.
    assert.equal((await say('Turn off, Office light.')).body.response, 'Turned off My office lamp.');
    assert.equal((await say('Switch on, my office lamp')).body.response, 'Turned on My office lamp.');
  });

  it('accepts a spoken possessive', async () => {
    getDb().prepare('INSERT INTO devices (alias, ip) VALUES (?, ?)').run('Brenden bed lamp', '10.9.0.3');
    const { body } = await say("Turn on Brenden's bed lamp.");
    assert.equal(body.response, 'Turned on Brenden bed lamp.');
  });

  it('does nothing for wording the rules cannot read', async () => {
    const { body } = await say('Turn on my office lens.');
    assert.equal(body.handled, false);
    assert.deepEqual(calls, []);

    const missed = getDb().prepare('SELECT text FROM voice_commands WHERE understood = 0 ORDER BY id DESC').get();
    assert.deepEqual(missed, { text: 'Turn on my office lens.' });
  });

  it('records a miss only when the bridge will not try again', async () => {
    const count = () => (getDb().prepare('SELECT COUNT(*) AS n FROM voice_commands').get() as { n: number }).n;
    const before = count();
    const res = await fetch(`${baseUrl}/internal/voice/command`, {
      method: 'POST', headers: key, body: JSON.stringify({ text: 'Turn on my office lands.', retry: true }),
    });
    assert.equal(((await res.json()) as any).handled, false);
    assert.equal(count(), before, 'a first try that missed is not recorded');

    const hit = await fetch(`${baseUrl}/internal/voice/command`, {
      method: 'POST', headers: key, body: JSON.stringify({ text: 'Turn on my office lamp.', retry: true }),
    });
    assert.equal(((await hit.json()) as any).handled, true);
    assert.equal(count(), before + 1, 'a first try that worked is recorded');
    assert.deepEqual(calls, [{ ip: '10.9.0.1', state: true }]);
  });

  it('refuses a protected device', async () => {
    const { body } = await say('turn off the main valve');
    assert.match(body.response, /protected/);
    assert.deepEqual(calls, []);
  });

  it('rejects empty text', async () => {
    assert.equal((await say('  ')).status, 400);
    assert.equal((await say(5)).status, 400);
  });

  it('needs the internal key', async () => {
    const res = await fetch(`${baseUrl}/internal/voice/device-names`);
    assert.equal(res.status, 401);
  });

  it('lists names and nicknames', async () => {
    getDb().prepare("INSERT OR IGNORE INTO scenes (name, nicknames) VALUES ('Good night', '[\"晚安\"]')").run();
    const res = await fetch(`${baseUrl}/internal/voice/device-names`, { headers: key });
    const { names, scenes, groups } = await res.json() as { names: string[]; scenes: string[]; groups: string[][] };
    for (const name of ['My office lamp', 'desk light', 'Main Valve']) assert.ok(names.includes(name));
    // Each device's names together, so the bridge knows two nicknames are the same light.
    assert.ok(groups.some((g) => g[0] === 'My office lamp' && g.includes('desk light')));
    assert.ok(groups.every((g) => g.length > 1));
    // Scenes are listed apart too, so a light's name heard alone is never run as a scene.
    assert.deepEqual(scenes, ['Good night', '晚安']);
    for (const scene of scenes) assert.ok(names.includes(scene));
  });
  it('keeps the bridge\'s check-in for the Health page', async () => {
    const post = (body: unknown, headers: Record<string, string> = key) =>
      fetch(`${baseUrl}/internal/voice/status`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await post({ speakers: [] }, { 'Content-Type': 'application/json' })).status, 401);
    assert.equal((await post({ speakers: 'tablet' })).status, 400);
    assert.equal((await post({ version: '0.1', speakers: [{ name: 'Tablet', address: '10.9.0.20', connected: true }] })).status, 200);
    const { lastBridgeReport } = await import('../system/voice-bridge');
    // A bridge from before v0.1.85 doesn't say whether a speaker can announce.
    assert.deepEqual(lastBridgeReport()?.speakers, [{ name: 'Tablet', address: '10.9.0.20', connected: true, announce: null }]);
    await post({ version: '0.1.85', speakers: [{ name: 'Tablet', address: '10.9.0.20', connected: true, announce: true }] });
    assert.equal(lastBridgeReport()?.speakers[0].announce, true);
  });

  it('hands the bridge reminders to say, and keeps how it went', async () => {
    const r = await import('../family/reminders');
    r.clearQueueForTests();
    const id = r.announce('食藥喇', 'yue');
    const config = await (await fetch(`${baseUrl}/internal/voice/config`, { headers: key })).json() as { announcements: { id: string; text: string; lang: string }[]; version: string };
    assert.deepEqual(config.announcements, [{ id, text: '食藥喇', lang: 'yue' }]);
    const done = (body: unknown) => fetch(`${baseUrl}/internal/voice/announcements/${id}`, { method: 'POST', headers: key, body: JSON.stringify(body) });
    assert.equal((await done({ said: ['Tablet'] })).status, 200);
    assert.equal(r.announcementStatus(id)?.state, 'said');
    assert.equal((await done({ said: ['Tablet'] })).status, 404, 'only once');
    const after = await (await fetch(`${baseUrl}/internal/voice/config`, { headers: key })).json() as { announcements: unknown[]; version: string };
    assert.deepEqual(after.announcements, []);
    // A reminder isn't a settings change: the bridge mustn't restart for it.
    assert.equal(after.version, config.version);
  });

  it("lists a check-in's question with its kind, and takes the answer to it", async () => {
    const r = await import('../family/reminders');
    r.clearQueueForTests();
    const db = getDb();
    const checkin = Number(db.prepare("INSERT INTO checkins (name, last_day, last_result) VALUES ('亞娘', '2026-11-19', 'asking')").run().lastInsertRowid);
    const ask = Number(db.prepare("INSERT INTO checkin_asks (checkin_id, day, lang, first_at, last_at) VALUES (?, '2026-11-19', 'yue', ?, ?)")
      .run(checkin, new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
    const config = await (await fetch(`${baseUrl}/internal/voice/config`, { headers: key })).json() as { asking: unknown[] };
    assert.deepEqual(config.asking, [{ id: ask, lang: 'yue', kind: 'checkin' }]);
    const answer = (body: unknown) => fetch(`${baseUrl}/internal/voice/asks/${ask}`, { method: 'POST', headers: key, body: JSON.stringify(body) });
    assert.equal((await answer({ answer: 'yes' })).status, 404, "without its kind, it's a reminder's, and there's no such reminder question");
    assert.equal((await answer({ answer: 'yes', kind: 'checkin' })).status, 200);
    assert.equal((db.prepare('SELECT answer FROM checkin_asks WHERE id = ?').get(ask) as { answer: string }).answer, 'yes');
    assert.equal((await answer({ answer: 'yes', kind: 'checkin' })).status, 404, 'answered already');
    db.prepare('DELETE FROM checkins WHERE id = ?').run(checkin);
  });

  it('takes a call for help from a speaker, at its address and at the one older bridges used', async () => {
    const sos = await import('../family/sos');
    const pushed: string[] = [];
    sos.setSendersForTests({ push: (title) => { pushed.push(title); }, email: async () => 0, texts: async () => 0, announce: () => {} });
    try {
      for (const p of ['/internal/voice/sos', '/internal/voice/family/sos']) {
        getDb().exec('DELETE FROM sos_alerts');
        const res = await fetch(`${baseUrl}${p}`, { method: 'POST', headers: key, body: JSON.stringify({ action: 'raise', where: 'Kitchen', lang: 'en', heard: 'I need help' }) });
        assert.equal(res.status, 200, p);
        assert.equal(((await res.json()) as { state: string }).state, 'raised', p);
        const cancel = await fetch(`${baseUrl}${p}`, { method: 'POST', headers: key, body: JSON.stringify({ action: 'cancel' }) });
        assert.equal(((await cancel.json()) as { state: string }).state, 'cancelled', p);
      }
      assert.equal(pushed.length >= 2, true, 'the family was told each time');
    } finally {
      sos.setSendersForTests(null);
      getDb().exec('DELETE FROM sos_alerts');
    }
  });

  it('answers every address the voice bridge calls', () => {
    // The bridge's client, next to this package in the repository. A path HomeHub doesn't answer
    // fails quietly on the speaker: that's how calls for help by voice failed for a week.
    const client = path.join(__dirname, '../../../voice-bridge/homehub_voice/homehub.py');
    if (!fs.existsSync(client)) return;   // built on its own, without the bridge's source
    const called = [...fs.readFileSync(client, 'utf8').matchAll(/self\._call\(f?'(\/[^'{]*)/g)].map((m) => m[1].replace(/\/$/, ''));
    assert.ok(called.length >= 8, `found ${called.length} addresses`);
    const routes = (internalRouter as unknown as { stack: { route?: { path: string | string[] } }[] }).stack
      .flatMap((l) => (l.route ? [l.route.path].flat() : []))
      .filter((r) => r.startsWith('/voice/'))
      .map((r) => r.slice('/voice'.length).replace(/\/:[^/]+$/, ''));
    for (const c of called) assert.ok(routes.includes(c), `the bridge calls /internal/voice${c}, which HomeHub doesn't answer`);
  });

  it('gives the bridge its settings, and a new version when they change', async () => {
    const vb = await import('../system/voice-bridge');
    const config = async () => (await fetch(`${baseUrl}/internal/voice/config`, { headers: key })).json() as Promise<{ enabled: boolean; languages: string[]; version: string }>;
    const off = await config();
    assert.deepEqual([off.enabled, off.languages], [false, ['en']], 'off, in English, until turned on');
    vb.setVoiceSettings({ enabled: true, languages: ['yue'] });
    const on = await config();
    assert.deepEqual([on.enabled, on.languages], [true, ['en', 'yue']], 'English is always included');
    assert.notEqual(on.version, off.version);
    vb.setVoiceSettings({ enabled: true, languages: ['vi', 'yue'] });
    assert.deepEqual((await config()).languages, ['en', 'yue', 'vi'], 'Vietnamese too');
    vb.setVoiceSettings({ enabled: true, languages: ['zh', 'yue'] });
    assert.deepEqual((await config()).languages, ['en', 'yue', 'zh'], 'and Mandarin');
    assert.throws(() => vb.setVoiceSettings({ enabled: true, languages: ['es'] }), /languages/);
    assert.throws(() => vb.setVoiceSettings({ enabled: 'yes', languages: [] }), /enabled/);
    vb.setVoiceSettings({ enabled: false, languages: ['en'] });
  });

  it('tells the bridge when the names change, and when to restart', async () => {
    const vb = await import('../system/voice-bridge');
    vb.resetBridgeReport();
    const checkIn = async () => (await fetch(`${baseUrl}/internal/voice/status`, {
      method: 'POST', headers: key, body: JSON.stringify({ speakers: [] }),
    })).json() as Promise<{ namesVersion: string; restart: boolean }>;
    const names = async () => (await fetch(`${baseUrl}/internal/voice/device-names`, { headers: key })).json() as Promise<{ names: string[]; version: string }>;

    const first = await checkIn();
    assert.equal(first.restart, false);
    assert.equal(first.namesVersion, (await names()).version, 'the same version as the names');
    assert.equal((await checkIn()).namesVersion, first.namesVersion, 'unchanged');

    getDb().prepare("UPDATE devices SET nicknames = ? WHERE alias = 'My office lamp'").run('["desk light","寫字樓燈"]');
    const changed = await checkIn();
    assert.notEqual(changed.namesVersion, first.namesVersion, 'a new nickname changes it');
    assert.ok((await names()).names.includes('寫字樓燈'));
    const config = await (await fetch(`${baseUrl}/internal/voice/config`, { headers: key })).json() as { namesVersion: string };
    assert.equal(config.namesVersion, changed.namesVersion, 'the 10-second settings check says so too, so a new nickname works straight away');

    vb.requestBridgeRestart();
    assert.equal(vb.bridgeRestartState(), 'asked');
    assert.equal((await checkIn()).restart, true);
    assert.equal(vb.bridgeRestartState(), 'restarting');
    assert.equal((await checkIn()).restart, false, 'asked once only');
  });
});

describe('/internal/devices/:id/execute — a Turn ON schedule\'s "Turn off after"', () => {
  const calls: { ip: string; state: boolean }[] = [];
  let id = 0;
  const run = (body: unknown) => fetch(`${baseUrl}/internal/devices/${id}/execute`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  const row = () => getDb().prepare('SELECT timer_off_at, timer_label, override_until FROM devices WHERE id = ?').get(id) as
    { timer_off_at: string | null; timer_label: string | null; override_until: string | null };
  const minutesLeft = () => (Date.parse(row().timer_off_at!.replace(' ', 'T') + 'Z') - Date.now()) / 60_000;

  before(() => {
    getDriver('kasa').setPower = async (ip: string, state: boolean) => { calls.push({ ip, state }); };
    id = Number(getDb().prepare('INSERT INTO devices (alias, ip) VALUES (?, ?)').run('Porch light', '10.9.1.1').lastInsertRowid);
  });

  beforeEach(() => {
    calls.length = 0;
    getDb().prepare('UPDATE devices SET timer_off_at = NULL, timer_label = NULL, override_state = NULL, override_until = NULL WHERE id = ?').run(id);
  });

  it('turns the device on and sets its timer, named after the schedule', async () => {
    const res = await run({ state: true, label: 'Porch at sunset', stayOnMinutes: 180 });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [{ ip: '10.9.1.1', state: true }]);
    assert.equal(row().timer_label, 'Porch at sunset');
    assert.ok(Math.abs(minutesLeft() - 180) < 1, `about 180 minutes left, got ${minutesLeft()}`);
    assert.equal(row().override_until, null, 'other schedules for the device still run');

    const { pendingAutoOff } = await import('../devices/auto-off');
    const { noteState } = await import('../kasa/device.cache');
    noteState(id, true);
    const off = pendingAutoOff().get(id);
    assert.equal(off?.cause, 'schedule');
    assert.equal(off?.detail, 'Porch at sunset');
  });

  it('turns it off when the time is up, recorded as the schedule', async () => {
    await run({ state: true, label: 'Porch at sunset', stayOnMinutes: 30 });
    getDb().prepare("UPDATE devices SET timer_off_at = datetime('now', '-1 minute') WHERE id = ?").run(id);   // as if 30 minutes passed
    calls.length = 0;
    const { sweepPowerTimers } = await import('../devices/power');
    await sweepPowerTimers();
    assert.deepEqual(calls, [{ ip: '10.9.1.1', state: false }]);
    assert.equal(row().timer_off_at, null);
    const event = getDb().prepare("SELECT state, source, detail FROM device_events WHERE device_id = ? ORDER BY id DESC LIMIT 1").get(id);
    assert.deepEqual(event, { state: 0, source: 'schedule', detail: 'Porch at sunset' });
  });

  it('sets no timer without one, for a Turn OFF, or for nonsense', async () => {
    await run({ state: true, label: 'On at 6' });
    assert.equal(row().timer_off_at, null);
    for (const stayOnMinutes of [0, -5, 1.5, 100_000, '60']) {
      await run({ state: true, label: 'On at 6', stayOnMinutes });
      assert.equal(row().timer_off_at, null, String(stayOnMinutes));
    }
    await run({ state: false, label: 'Off at 11', stayOnMinutes: 60 });
    assert.equal(row().timer_off_at, null);
  });

  it('a Turn OFF schedule clears a timer left over', async () => {
    await run({ state: true, label: 'Porch at sunset', stayOnMinutes: 180 });
    await run({ state: false, label: 'Off at 11' });
    assert.equal(row().timer_off_at, null);
  });

  it('switching by hand cancels it, so it can\'t turn the device off later', async () => {
    await run({ state: true, label: 'Porch at sunset', stayOnMinutes: 180 });
    const { cancelPowerTimer } = await import('../devices/power');
    cancelPowerTimer(id);   // what the dashboard, Chat and voice do on every switch
    assert.equal(row().timer_off_at, null);
  });
});
