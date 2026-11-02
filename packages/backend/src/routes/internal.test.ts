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
    const res = await fetch(`${baseUrl}/internal/voice/device-names`, { headers: key });
    const { names } = await res.json() as { names: string[] };
    for (const name of ['My office lamp', 'desk light', 'Main Valve']) assert.ok(names.includes(name));
  });
});
