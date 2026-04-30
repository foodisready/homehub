/**
 * Integration tests for the auto-shutoff coordinator. Uses a real SQLite
 * DB and stub invoker/notifier so we can exercise the state machine
 * without touching real device drivers.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const TMP_DB = path.join(os.tmpdir(), `homehub-shutoff-test-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_PATH = TMP_DB;

import { getDb } from '../db';
import { maybeFireShutoff, verifyShutoff } from './shutoff';
import type { ShutoffInvoker, ShutoffNotifier } from './shutoff';

const SENSOR_KEY = 'shutoff-test-01';
let SENSOR_ID = 0;
const SHUTOFF_DEVICE_ID = 999;

interface InvokerLog { calls: number[]; }
interface NotifierLog { failures: number[]; successes: number[]; }

function makeInvoker(opts: { throwOnCall?: boolean } = {}): ShutoffInvoker & InvokerLog {
  const log: InvokerLog = { calls: [] };
  return {
    calls: log.calls,
    async closeValve(deviceId: number) {
      log.calls.push(deviceId);
      if (opts.throwOnCall) throw new Error('valve unreachable');
    },
  };
}

function makeNotifier(): ShutoffNotifier & NotifierLog {
  const log: NotifierLog = { failures: [], successes: [] };
  return {
    failures:  log.failures,
    successes: log.successes,
    notifyFailure(eventId) { log.failures.push(eventId); },
    notifySuccess(eventId) { log.successes.push(eventId); },
  };
}

before(() => {
  getDb();
  const r = getDb().prepare(
    "INSERT INTO sensors (sensor_id, type, alias, config) VALUES (?, 'flow', ?, ?)"
  ).run(SENSOR_KEY, 'Shutoff test', JSON.stringify({ shutoffDeviceId: SHUTOFF_DEVICE_ID }));
  SENSOR_ID = Number(r.lastInsertRowid);
});

after(() => {
  try { getDb().close(); } catch {}
  try { fs.unlinkSync(TMP_DB); } catch {}
  try { fs.unlinkSync(TMP_DB + '-wal'); } catch {}
  try { fs.unlinkSync(TMP_DB + '-shm'); } catch {}
});

function makeEvent(level: 0|1|2|3, peakRate = 1.5): number {
  const r = getDb().prepare(
    "INSERT INTO flow_events (sensor_id, peak_rate, alert_level, status) VALUES (?, ?, ?, 'active')"
  ).run(SENSOR_ID, peakRate, level);
  return Number(r.lastInsertRowid);
}

function getEvent(id: number) {
  return getDb().prepare('SELECT * FROM flow_events WHERE id = ?').get(id) as {
    shutoff_status: string;
    shutoff_fired_at: string | null;
    shutoff_rate_at_fire: number | null;
    shutoff_completed_at: string | null;
  };
}

function insertReading(rate: number, when?: Date): void {
  getDb().prepare(
    'INSERT INTO flow_readings (sensor_id, rate_m3h, recorded_at) VALUES (?, ?, ?)'
  ).run(SENSOR_ID, rate,
    (when ?? new Date()).toISOString().replace('T', ' ').replace('Z', ''),
  );
}

describe('maybeFireShutoff — gating', () => {
  it('does not fire below L3', async () => {
    const invoker  = makeInvoker();
    const notifier = makeNotifier();
    const eventId  = makeEvent(2);

    await maybeFireShutoff(eventId, invoker, notifier, { verifyAfterMs: 1_000_000 });

    assert.equal(invoker.calls.length, 0);
    assert.equal(getEvent(eventId).shutoff_status, 'not_fired');
  });

  it('does not fire if shutoffDeviceId is missing', async () => {
    // Wipe shutoff config.
    getDb().prepare('UPDATE sensors SET config = NULL WHERE id = ?').run(SENSOR_ID);
    const invoker  = makeInvoker();
    const notifier = makeNotifier();
    const eventId  = makeEvent(3);

    await maybeFireShutoff(eventId, invoker, notifier, { verifyAfterMs: 1_000_000 });

    assert.equal(invoker.calls.length, 0);
    assert.equal(getEvent(eventId).shutoff_status, 'not_fired');

    // restore for subsequent tests
    getDb().prepare('UPDATE sensors SET config = ? WHERE id = ?')
      .run(JSON.stringify({ shutoffDeviceId: SHUTOFF_DEVICE_ID }), SENSOR_ID);
  });
});

describe('maybeFireShutoff — firing', () => {
  it('calls invoker once and marks fired', async () => {
    const invoker  = makeInvoker();
    const notifier = makeNotifier();
    const eventId  = makeEvent(3, 2.0);

    await maybeFireShutoff(eventId, invoker, notifier, { verifyAfterMs: 1_000_000 });

    assert.deepEqual(invoker.calls, [SHUTOFF_DEVICE_ID]);
    const ev = getEvent(eventId);
    assert.equal(ev.shutoff_status, 'fired');
    assert.equal(ev.shutoff_rate_at_fire, 2.0);
    assert.ok(ev.shutoff_fired_at);
  });

  it('is idempotent — second call does not re-fire', async () => {
    const invoker  = makeInvoker();
    const notifier = makeNotifier();
    const eventId  = makeEvent(3);

    await maybeFireShutoff(eventId, invoker, notifier, { verifyAfterMs: 1_000_000 });
    await maybeFireShutoff(eventId, invoker, notifier, { verifyAfterMs: 1_000_000 });

    assert.equal(invoker.calls.length, 1);
  });

  it('marks failed + notifies when invoker throws', async () => {
    const invoker  = makeInvoker({ throwOnCall: true });
    const notifier = makeNotifier();
    const eventId  = makeEvent(3);

    await maybeFireShutoff(eventId, invoker, notifier, { verifyAfterMs: 1_000_000 });

    assert.equal(getEvent(eventId).shutoff_status, 'failed');
    assert.deepEqual(notifier.failures, [eventId]);
  });
});

describe('verifyShutoff', () => {
  it('marks verified + notifies success when rate drops ≥80%', async () => {
    const invoker  = makeInvoker();
    const notifier = makeNotifier();
    const eventId  = makeEvent(3, 2.0);

    await maybeFireShutoff(eventId, invoker, notifier, { verifyAfterMs: 1_000_000 });

    // Insert a reading at 0.1 m³/h = 95% drop from peak 2.0
    insertReading(0.1, new Date(Date.now() + 1000));

    const status = verifyShutoff(eventId, notifier, 'Shutoff test', SENSOR_ID);
    assert.equal(status, 'verified');
    assert.equal(getEvent(eventId).shutoff_status, 'verified');
    assert.deepEqual(notifier.successes, [eventId]);
    assert.deepEqual(notifier.failures, []);
  });

  it('marks failed + notifies failure when no rate drop', async () => {
    const invoker  = makeInvoker();
    const notifier = makeNotifier();
    const eventId  = makeEvent(3, 2.0);

    await maybeFireShutoff(eventId, invoker, notifier, { verifyAfterMs: 1_000_000 });

    // Insert a reading still flowing — no meaningful drop.
    insertReading(1.9, new Date(Date.now() + 1000));

    const status = verifyShutoff(eventId, notifier, 'Shutoff test', SENSOR_ID);
    assert.equal(status, 'failed');
    assert.equal(getEvent(eventId).shutoff_status, 'failed');
    assert.deepEqual(notifier.failures, [eventId]);
  });

  it('marks failed when no reading at all has arrived', async () => {
    const invoker  = makeInvoker();
    const notifier = makeNotifier();
    const eventId  = makeEvent(3, 1.0);

    await maybeFireShutoff(eventId, invoker, notifier, { verifyAfterMs: 1_000_000 });
    // No reading inserted.

    const status = verifyShutoff(eventId, notifier, 'Shutoff test', SENSOR_ID);
    assert.equal(status, 'failed');
  });

  it('is idempotent on a verified event', async () => {
    const invoker  = makeInvoker();
    const notifier = makeNotifier();
    const eventId  = makeEvent(3, 1.0);

    await maybeFireShutoff(eventId, invoker, notifier, { verifyAfterMs: 1_000_000 });
    insertReading(0.05, new Date(Date.now() + 1000));
    verifyShutoff(eventId, notifier, 'Shutoff test', SENSOR_ID);

    // Re-verify: should be a no-op since status is 'verified'.
    const second = verifyShutoff(eventId, notifier, 'Shutoff test', SENSOR_ID);
    assert.equal(second, 'verified');
    assert.equal(notifier.successes.length, 1);
  });
});
