/**
 * Integration test for the ingestion + engine pipeline.
 * Drives a real SQLite DB through a synthetic 70-minute flow stream
 * and asserts the resulting event timeline + alert transitions.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Force a fresh test DB before importing any module that calls getDb().
const TMP_DB = path.join(os.tmpdir(), `homehub-test-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_PATH = TMP_DB;

import { getDb } from '../db';
import { ingestReading } from './flow-store';
import type { FlowReading } from './flow-engine';

const SENSOR_KEY = 'test-mainline-01';

before(() => {
  // Trigger migrations.
  getDb();
  getDb().prepare(
    "INSERT INTO sensors (sensor_id, type, alias, config) VALUES (?, 'flow', ?, ?)"
  ).run(SENSOR_KEY, 'Test mainline', null);
});

after(() => {
  try { getDb().close(); } catch {}
  try { fs.unlinkSync(TMP_DB); } catch {}
  try { fs.unlinkSync(TMP_DB + '-wal'); } catch {}
  try { fs.unlinkSync(TMP_DB + '-shm'); } catch {}
});

function reading(rate: number, recordedAt: Date, totalM3: number | null = null): FlowReading {
  return { rate, totalM3, signalQuality: 80, recordedAt };
}

function getSensor() {
  return getDb().prepare('SELECT * FROM sensors WHERE sensor_id = ?').get(SENSOR_KEY) as {
    id: number; pending_state: 'idle'|'flowing'; pending_count: number; config: string | null;
  };
}

function activeEvent() {
  return getDb().prepare(
    "SELECT * FROM flow_events WHERE sensor_id = (SELECT id FROM sensors WHERE sensor_id = ?) AND status = 'active'"
  ).get(SENSOR_KEY) as { id: number; alert_level: 0|1|2|3; start_time: string } | undefined;
}

describe('ingestion pipeline — 70-minute synthetic stream', () => {
  it('opens, escalates L1→L2→L3, and closes correctly', () => {
    const start = new Date('2026-04-30T12:00:00Z');
    const at = (offsetMin: number) => new Date(start.getTime() + offsetMin * 60_000);

    let sensor = getSensor();

    // First flowing reading (debounce). No event yet.
    let res = ingestReading(sensor as any, reading(0.2, at(0)), 0);
    assert.equal(res.opened, false);
    assert.equal(res.eventId, null);

    // Second flowing reading — opens at level 0.
    sensor = getSensor();
    res = ingestReading(sensor as any, reading(0.2, at(0.1)), 0);
    assert.equal(res.opened, true);
    assert.equal(res.level, 0);

    // 6 minutes in — should escalate to L1 (level1AfterMin=5).
    sensor = getSensor();
    res = ingestReading(sensor as any, reading(0.2, at(6)), 0);
    assert.equal(res.level, 1);
    assert.equal(res.levelChanged, true);

    // 31 minutes in — L2 (warnAfterMin=30).
    sensor = getSensor();
    res = ingestReading(sensor as any, reading(0.2, at(31)), 0);
    assert.equal(res.level, 2);
    assert.equal(res.levelChanged, true);

    // 61 minutes in — L3 (criticalAfterMin=60).
    sensor = getSensor();
    res = ingestReading(sensor as any, reading(0.2, at(61)), 0);
    assert.equal(res.level, 3);
    assert.equal(res.levelChanged, true);

    // Now the event should be in the DB.
    const ev = activeEvent();
    assert.ok(ev);
    assert.equal(ev!.alert_level, 3);

    // 3 idle readings close it.
    sensor = getSensor();
    res = ingestReading(sensor as any, reading(0.0, at(62)), 0);
    assert.equal(res.closed, false);
    sensor = getSensor();
    res = ingestReading(sensor as any, reading(0.0, at(63)), 0);
    assert.equal(res.closed, false);
    sensor = getSensor();
    res = ingestReading(sensor as any, reading(0.0, at(64)), 0);
    assert.equal(res.closed, true);

    // No active event remains.
    assert.equal(activeEvent(), undefined);

    // Reading rows persisted.
    const readingCount = (getDb().prepare(
      'SELECT COUNT(*) AS n FROM flow_readings WHERE sensor_id = (SELECT id FROM sensors WHERE sensor_id = ?)'
    ).get(SENSOR_KEY) as { n: number }).n;
    assert.equal(readingCount, 8);
  });

  it('signal-quality rejection does not open phantom events', () => {
    // Pre-condition: no active event from prior test.
    assert.equal(activeEvent(), undefined);

    // Reset pending state.
    getDb().prepare("UPDATE sensors SET pending_state = 'idle', pending_count = 0 WHERE sensor_id = ?")
      .run(SENSOR_KEY);

    const sensor = getSensor();
    const r: FlowReading = {
      rate: 2.0, totalM3: null, signalQuality: 30,
      recordedAt: new Date('2026-04-30T14:00:00Z'),
    };
    const res = ingestReading(sensor as any, r, 0);
    assert.equal(res.decision.rejectedSignal, true);
    assert.equal(res.opened, false);
    // pending_state should be untouched
    assert.equal(getSensor().pending_state, 'idle');
  });
});
