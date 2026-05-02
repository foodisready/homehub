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
