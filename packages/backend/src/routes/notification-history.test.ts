/**
 * Black-box tests for the notification history route. Seeds a small fixture
 * of dispatches against a real SQLite DB and asserts join + filter behavior
 * via HTTP.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import express from 'express';
import http from 'node:http';

const TMP_DB = path.join(os.tmpdir(), `homehub-notif-history-test-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_PATH = TMP_DB;
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret';

import { getDb } from '../db';
import { notificationHistoryRouter } from './notification-history';
import { authenticate } from '../middleware/auth';
import { issueTokens, type UserRow } from '../auth/auth.service';

let server: http.Server;
let baseUrl: string;
let token: string;
let sensorRowId: number;
let eventRowId: number;
let userRowId: number;

before(async () => {
  getDb();

  const db = getDb();
  db.prepare('INSERT INTO users (name, password_hash, role) VALUES (?, ?, ?)').run('jeff', 'x', 'admin');
  const user = db.prepare('SELECT * FROM users WHERE name = ?').get('jeff') as UserRow;
  userRowId = user.id;
  token = issueTokens(user).accessToken;

  // Seed sensor + a single event so the join has something to anchor on.
  db.prepare("INSERT INTO sensors (sensor_id, type, alias) VALUES (?, ?, ?)")
    .run('auraflow-mainline-01', 'flow', 'Main line');
  const sensor = db.prepare("SELECT id FROM sensors WHERE sensor_id = ?").get('auraflow-mainline-01') as { id: number };
  sensorRowId = sensor.id;

  db.prepare("INSERT INTO flow_events (sensor_id, alert_level, status) VALUES (?, ?, ?)")
    .run(sensorRowId, 2, 'closed');
  const event = db.prepare("SELECT id FROM flow_events ORDER BY id DESC LIMIT 1").get() as { id: number };
  eventRowId = event.id;

  // Seed three dispatches at different times + channels + levels.
  // sent_at past timestamps so we can filter by `since`.
  const insertDisp = db.prepare(`
    INSERT INTO notification_dispatches (event_id, user_id, channel, level, sent_at, ack_token)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertDisp.run(eventRowId, userRowId, 'push',  1, '2026-04-01 10:00:00', 'tok-push-l1');
  insertDisp.run(eventRowId, userRowId, 'email', 2, '2026-04-01 10:30:00', 'tok-email-l2');
  insertDisp.run(eventRowId, userRowId, 'sms',   3, '2026-04-01 11:00:00', 'tok-sms-l3');

  const app = express();
  app.use(express.json());
  app.use('/api', authenticate);
  app.use('/api/notifications/history', notificationHistoryRouter);

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

beforeEach(() => { /* no per-test mutation; we read from the seeded fixture */ });

const auth = () => ({ 'Authorization': `Bearer ${token}` });

describe('GET /api/notifications/history', () => {
  it('rejects unauthenticated', async () => {
    const r = await fetch(`${baseUrl}/api/notifications/history`);
    assert.equal(r.status, 401);
  });

  it('returns all dispatches sorted newest first', async () => {
    const r = await fetch(`${baseUrl}/api/notifications/history`, { headers: auth() });
    assert.equal(r.status, 200);
    const list = await r.json() as Array<{ channel: string; level: number; sentAt: string; sensorAlias: string; userName: string }>;
    assert.equal(list.length, 3);
    assert.deepEqual(list.map((d) => d.channel), ['sms', 'email', 'push']);
    assert.deepEqual(list.map((d) => d.level),   [3, 2, 1]);
    assert.equal(list[0].sensorAlias, 'Main line');
    assert.equal(list[0].userName,    'jeff');
  });

  it('filters by channel', async () => {
    const r = await fetch(`${baseUrl}/api/notifications/history?channel=email`, { headers: auth() });
    const list = await r.json() as Array<{ channel: string; level: number }>;
    assert.equal(list.length, 1);
    assert.equal(list[0].channel, 'email');
    assert.equal(list[0].level,   2);
  });

  it('filters by level', async () => {
    const r = await fetch(`${baseUrl}/api/notifications/history?level=3`, { headers: auth() });
    const list = await r.json() as Array<{ channel: string }>;
    assert.equal(list.length, 1);
    assert.equal(list[0].channel, 'sms');
  });

  it('filters by since (excludes earlier)', async () => {
    const r = await fetch(`${baseUrl}/api/notifications/history?since=2026-04-01T10:45:00Z`, { headers: auth() });
    const list = await r.json() as Array<{ channel: string }>;
    assert.equal(list.length, 1);
    assert.equal(list[0].channel, 'sms');
  });

  it('filters by sensorId', async () => {
    const r = await fetch(`${baseUrl}/api/notifications/history?sensorId=${sensorRowId}`, { headers: auth() });
    const list = await r.json() as unknown[];
    assert.equal(list.length, 3);

    const otherSensor = await fetch(`${baseUrl}/api/notifications/history?sensorId=99999`, { headers: auth() });
    assert.equal((await otherSensor.json() as unknown[]).length, 0);
  });

  it('rejects invalid channel', async () => {
    const r = await fetch(`${baseUrl}/api/notifications/history?channel=fax`, { headers: auth() });
    assert.equal(r.status, 400);
  });

  it('clamps limit', async () => {
    const r = await fetch(`${baseUrl}/api/notifications/history?limit=2`, { headers: auth() });
    const list = await r.json() as unknown[];
    assert.equal(list.length, 2);
  });
});
