/**
 * Pure-logic tests for evaluateStale + integration tests for
 * checkAllSensors against a real SQLite DB.
 *
 * VAPID keys are not configured in tests, so the push notifier inside
 * sendPushToAll is a no-op (logged warn). We assert state-machine
 * transitions in the DB, not push delivery.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const TMP_DB = path.join(os.tmpdir(), `homehub-stale-test-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_PATH = TMP_DB;
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

import { getDb } from '../db';
import { evaluateStale, checkAllSensors } from './stale-check';

before(() => { getDb(); });

after(() => {
  try { getDb().close(); } catch {}
  try { fs.unlinkSync(TMP_DB); } catch {}
  try { fs.unlinkSync(TMP_DB + '-wal'); } catch {}
  try { fs.unlinkSync(TMP_DB + '-shm'); } catch {}
});

beforeEach(() => {
  getDb().prepare('DELETE FROM sensors').run();
});

function insertSensor(opts: {
  alias?:     string;
  lastSeenAt?: string | null;
  staleSince?: string | null;
  configJson?: string | null;
} = {}): number {
  const r = getDb().prepare(`
    INSERT INTO sensors (sensor_id, type, alias, config, last_seen_at, stale_since)
    VALUES (?, 'flow', ?, ?, ?, ?)
  `).run(
    `s-${Date.now()}-${Math.random()}`,
    opts.alias       ?? 'Test sensor',
    opts.configJson  ?? null,
    opts.lastSeenAt  ?? null,
    opts.staleSince  ?? null,
  );
  return Number(r.lastInsertRowid);
}

function getSensor(id: number) {
  return getDb().prepare('SELECT * FROM sensors WHERE id = ?').get(id) as {
    stale_since: string | null;
    last_seen_at: string | null;
  };
}

function isoUtc(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

describe('evaluateStale (pure)', () => {
  it('null last_seen_at is NOT stale (unprovisioned, not failed)', () => {
    const r = evaluateStale(
      { id: 1, alias: 'x', config: null, last_seen_at: null, stale_since: null },
      Date.now(),
    );
    assert.equal(r.isStale, false);
    assert.equal(r.ageMs, null);
  });

  it('reading 1 minute ago is fresh (under 3-min default threshold)', () => {
    const now = Date.now();
    const r = evaluateStale(
      { id: 1, alias: 'x', config: null, last_seen_at: isoUtc(new Date(now - 60_000)), stale_since: null },
      now,
    );
    assert.equal(r.isStale, false);
  });

  it('reading 5 minutes ago is stale (over 3-min default)', () => {
    const now = Date.now();
    const r = evaluateStale(
      { id: 1, alias: 'x', config: null, last_seen_at: isoUtc(new Date(now - 5 * 60_000)), stale_since: null },
      now,
    );
    assert.equal(r.isStale, true);
  });

  it('honors per-sensor idlePollIntervalMs (5x multiplier, capped 3-30 min)', () => {
    const now = Date.now();
    // idlePollIntervalMs=120000 → 5x = 600000 ms = 10 min threshold
    const cfg = JSON.stringify({ idlePollIntervalMs: 120_000 });
    // 6 min stale by default threshold, but config says 10 min → still fresh
    const r = evaluateStale(
      { id: 1, alias: 'x', config: cfg, last_seen_at: isoUtc(new Date(now - 6 * 60_000)), stale_since: null },
      now,
    );
    assert.equal(r.isStale, false);
    assert.equal(r.thresholdMs, 600_000);
  });

  it('threshold is floored at 3 min even with tiny idle interval', () => {
    // idlePollIntervalMs=10000 → 5x = 50s, but floor is 3 min
    const cfg = JSON.stringify({ idlePollIntervalMs: 10_000 });
    const now = Date.now();
    const r = evaluateStale(
      { id: 1, alias: 'x', config: cfg, last_seen_at: isoUtc(new Date(now - 60_000)), stale_since: null },
      now,
    );
    assert.equal(r.thresholdMs, 3 * 60_000);
    assert.equal(r.isStale, false);
  });
});

describe('checkAllSensors — DB transitions', () => {
  it('marks fresh→stale and writes stale_since', () => {
    const now    = Date.now();
    const id     = insertSensor({ lastSeenAt: isoUtc(new Date(now - 10 * 60_000)) });
    const newCnt = checkAllSensors(now);
    assert.equal(newCnt, 1);
    assert.ok(getSensor(id).stale_since);
  });

  it('does not re-mark a sensor that is already stale', () => {
    const now      = Date.now();
    const stale1d  = isoUtc(new Date(now - 24 * 3600_000));
    const id       = insertSensor({
      lastSeenAt: isoUtc(new Date(now - 10 * 60_000)),
      staleSince: stale1d,
    });
    const newCnt = checkAllSensors(now);
    assert.equal(newCnt, 0);
    assert.equal(getSensor(id).stale_since, stale1d);   // unchanged
  });

  it('clears stale_since when last_seen_at moves forward (recovery)', () => {
    const now = Date.now();
    const id  = insertSensor({
      lastSeenAt: isoUtc(new Date(now - 30_000)),     // recent
      staleSince: isoUtc(new Date(now - 10 * 60_000)), // had been stale
    });
    checkAllSensors(now);
    assert.equal(getSensor(id).stale_since, null);
  });

  it('skips sensors that have never reported', () => {
    const id     = insertSensor({ lastSeenAt: null });
    const newCnt = checkAllSensors(Date.now());
    assert.equal(newCnt, 0);
    assert.equal(getSensor(id).stale_since, null);
  });

  it('handles multiple sensors with mixed states in one pass', () => {
    const now = Date.now();
    const fresh = insertSensor({ alias: 'fresh', lastSeenAt: isoUtc(new Date(now - 60_000)) });
    const stale = insertSensor({ alias: 'stale', lastSeenAt: isoUtc(new Date(now - 10 * 60_000)) });
    const recovered = insertSensor({
      alias: 'recovered',
      lastSeenAt: isoUtc(new Date(now - 30_000)),
      staleSince: isoUtc(new Date(now - 30 * 60_000)),
    });

    const newCnt = checkAllSensors(now);
    assert.equal(newCnt, 1);   // only `stale` transitioned
    assert.equal(getSensor(fresh).stale_since, null);
    assert.ok(getSensor(stale).stale_since);
    assert.equal(getSensor(recovered).stale_since, null);
  });
});
