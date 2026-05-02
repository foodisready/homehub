/**
 * Integration tests against a real SQLite DB. Verifies dispatch persistence,
 * snooze suppression, and ack idempotency.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const TMP_DB = path.join(os.tmpdir(), `homehub-router-test-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_PATH = TMP_DB;
// Disable VAPID so the push provider is a no-op (init() returns silently with a warn).
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

import { getDb } from '../db';
import { notify } from './router';
import { ackByToken } from '../routes/notifications-ack';

const SENSOR_KEY = 'router-test-01';
let SENSOR_ID = 0;
let EVENT_ID  = 0;

before(() => {
  getDb();   // run migrations
  const r = getDb().prepare(
    "INSERT INTO sensors (sensor_id, type, alias) VALUES (?, 'flow', ?)"
  ).run(SENSOR_KEY, 'Router test sensor');
  SENSOR_ID = Number(r.lastInsertRowid);

  const e = getDb().prepare(
    "INSERT INTO flow_events (sensor_id, peak_rate, alert_level, status) VALUES (?, ?, 0, 'active')"
  ).run(SENSOR_ID, 0.2);
  EVENT_ID = Number(e.lastInsertRowid);
});

after(() => {
  try { getDb().close(); } catch {}
  try { fs.unlinkSync(TMP_DB); } catch {}
  try { fs.unlinkSync(TMP_DB + '-wal'); } catch {}
  try { fs.unlinkSync(TMP_DB + '-shm'); } catch {}
});

function dispatchesForEvent(eventId: number) {
  return getDb().prepare(
    'SELECT channel, level, ack_token, acked_at FROM notification_dispatches WHERE event_id = ? ORDER BY id'
  ).all(eventId) as { channel: string; level: number; ack_token: string; acked_at: string | null }[];
}

describe('notify() — persistence and matrix', () => {
  it('L1 writes one push dispatch row', () => {
    notify({
      level: 1, eventId: EVENT_ID, sensorRowId: SENSOR_ID,
      sensorKey: SENSOR_KEY, sensorAlias: 'Router test sensor',
      rateM3h: 0.2, snoozedUntil: null,
    });
    const rows = dispatchesForEvent(EVENT_ID);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].channel, 'push');
    assert.equal(rows[0].level, 1);
    assert.ok(rows[0].ack_token.length >= 8);
  });

  it('L2 adds push + email dispatches', () => {
    notify({
      level: 2, eventId: EVENT_ID, sensorRowId: SENSOR_ID,
      sensorKey: SENSOR_KEY, sensorAlias: 'Router test sensor',
      rateM3h: 0.2, snoozedUntil: null,
    });
    const rows = dispatchesForEvent(EVENT_ID);
    const newL2 = rows.filter((r) => r.level === 2);
    assert.deepEqual(newL2.map((r) => r.channel).sort(), ['email', 'push']);
  });

  it('L3 adds push + email + sms', () => {
    notify({
      level: 3, eventId: EVENT_ID, sensorRowId: SENSOR_ID,
      sensorKey: SENSOR_KEY, sensorAlias: 'Router test sensor',
      rateM3h: 2.0, snoozedUntil: null,
    });
    const rows = dispatchesForEvent(EVENT_ID);
    const newL3 = rows.filter((r) => r.level === 3);
    assert.deepEqual(newL3.map((r) => r.channel).sort(), ['email', 'push', 'sms']);
  });
});

describe('notify() — snooze suppression', () => {
  it('L2 fires no dispatches when snoozed in the future', () => {
    const e = getDb().prepare(
      "INSERT INTO flow_events (sensor_id, peak_rate, alert_level, status) VALUES (?, ?, 0, 'active')"
    ).run(SENSOR_ID, 0.2);
    const eventId = Number(e.lastInsertRowid);

    const future = new Date(Date.now() + 60 * 60_000).toISOString().replace('T', ' ').replace('Z', '');
    notify({
      level: 2, eventId, sensorRowId: SENSOR_ID,
      sensorKey: SENSOR_KEY, sensorAlias: 'Router test sensor',
      rateM3h: 0.2, snoozedUntil: future,
    });
    assert.equal(dispatchesForEvent(eventId).length, 0);
  });

  it('L3 still fires even when snoozed', () => {
    const e = getDb().prepare(
      "INSERT INTO flow_events (sensor_id, peak_rate, alert_level, status) VALUES (?, ?, 0, 'active')"
    ).run(SENSOR_ID, 2.0);
    const eventId = Number(e.lastInsertRowid);

    const future = new Date(Date.now() + 60 * 60_000).toISOString().replace('T', ' ').replace('Z', '');
    notify({
      level: 3, eventId, sensorRowId: SENSOR_ID,
      sensorKey: SENSOR_KEY, sensorAlias: 'Router test sensor',
      rateM3h: 2.0, snoozedUntil: future,
    });
    assert.equal(dispatchesForEvent(eventId).length, 3);
  });

  it('expired snooze does not suppress', () => {
    const e = getDb().prepare(
      "INSERT INTO flow_events (sensor_id, peak_rate, alert_level, status) VALUES (?, ?, 0, 'active')"
    ).run(SENSOR_ID, 0.2);
    const eventId = Number(e.lastInsertRowid);

    const past = new Date(Date.now() - 60 * 60_000).toISOString().replace('T', ' ').replace('Z', '');
    notify({
      level: 2, eventId, sensorRowId: SENSOR_ID,
      sensorKey: SENSOR_KEY, sensorAlias: 'Router test sensor',
      rateM3h: 0.2, snoozedUntil: past,
    });
    assert.equal(dispatchesForEvent(eventId).length, 2);
  });
});

describe('ackByToken — single-use', () => {
  it('first call acks; replay returns "replayed"', () => {
    const e = getDb().prepare(
      "INSERT INTO flow_events (sensor_id, peak_rate, alert_level, status) VALUES (?, ?, 0, 'active')"
    ).run(SENSOR_ID, 0.2);
    const eventId = Number(e.lastInsertRowid);

    notify({
      level: 1, eventId, sensorRowId: SENSOR_ID,
      sensorKey: SENSOR_KEY, sensorAlias: 'Router test sensor',
      rateM3h: 0.2, snoozedUntil: null,
    });
    const [d] = dispatchesForEvent(eventId);
    assert.ok(d);

    const first = ackByToken(d.ack_token);
    assert.equal(first.kind, 'ok');

    const replay = ackByToken(d.ack_token);
    assert.equal(replay.kind, 'replayed');
  });

  it('rejects too-short tokens as invalid', () => {
    assert.equal(ackByToken('').kind, 'invalid');
    assert.equal(ackByToken('abc').kind, 'invalid');
  });

  it('returns not_found for unknown token', () => {
    assert.equal(ackByToken('00000000-0000-0000-0000-000000000000').kind, 'not_found');
  });
});
