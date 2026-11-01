/**
 * Black-box tests for the device routes that apply a moved address.
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this file
 * stays on its temp DB even under a runner that hoists static imports.
 * Discovery itself isn't called here because it broadcasts on the real network.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import type Database from 'better-sqlite3';

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-devices-test-'));
const MAC      = '74FECE3576FD';

let server: http.Server;
let baseUrl: string;
let db: Database.Database;

const send = (method: string, url: string, body: unknown) => fetch(`${baseUrl}/api/devices${url}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body:    JSON.stringify(body),
});

const row = (id: number) => db.prepare('SELECT ip, mac FROM devices WHERE id = ?').get(id);

function register(alias: string, ip: string, mac: string | null = null): number {
  return Number(db.prepare('INSERT INTO devices (alias, ip, mac) VALUES (?, ?, ?)').run(alias, ip, mac).lastInsertRowid);
}

describe('device address updates', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP_BASE, 'db.sqlite');
    const { getDb } = await import('../db');
    const { devicesRouter } = await import('./devices');
    db = getDb();

    const app = express();
    app.use(express.json());
    app.use('/api/devices', devicesRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.prepare('DELETE FROM devices').run();
  });

  it('stores nicknames without blanks or repeats, and returns them', async () => {
    const id = register('Brenden desk', '10.0.0.1');

    const res = await send('PATCH', `/${id}`, { nicknames: [' desk lamp', '', 'desk lamp', 'study'] });

    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as any).nicknames, ['desk lamp', 'study']);
  });

  it('rejects nicknames that are not a list of names', async () => {
    const id = register('Lamp', '10.0.0.1');

    assert.equal((await send('PATCH', `/${id}`, { nicknames: 'desk lamp' })).status, 400);
    assert.equal((await send('PATCH', `/${id}`, { nicknames: [1] })).status, 400);
  });

  it('turns protection on and off', async () => {
    const id = register('Heater', '10.0.0.1');

    assert.equal(((await (await send('PATCH', `/${id}`, { isProtected: true })).json()) as any).isProtected, true);
    assert.equal(((await (await send('PATCH', `/${id}`, { alias: 'Space heater' })).json()) as any).isProtected, true);
    assert.equal(((await (await send('PATCH', `/${id}`, { isProtected: false })).json()) as any).isProtected, false);
  });

  it('always reports a valve as protected', async () => {
    const id = register('Main Valve', '10.0.0.1');

    assert.equal(((await (await send('PATCH', `/${id}`, { isProtected: false })).json()) as any).isProtected, true);
  });

  it('reports a failed timer and stores nothing', async () => {
    const id = register('Lamp', '10.0.0.1');
    const { getDriver } = await import('../drivers/registry');
    const driver = getDriver('kasa');
    const original = driver.setPower;
    driver.setPower = async () => { throw new Error('unreachable'); };

    try {
      const res = await send('POST', `/${id}/override`, { state: true, durationMinutes: 60 });
      assert.equal(res.status, 503);
    } finally {
      driver.setPower = original;
    }

    const stored = db.prepare('SELECT override_until, timer_off_at FROM devices WHERE id = ?').get(id) as any;
    assert.equal(stored.override_until, null);
    assert.equal(stored.timer_off_at, null);
  });

  it('applies a move and stores the MAC', async () => {
    const id = register('vinyl lamp', '192.168.86.138');

    const res = await send('PATCH', `/${id}`, { ip: '192.168.86.41', mac: MAC });

    assert.equal(res.status, 200);
    assert.deepEqual(row(id), { ip: '192.168.86.41', mac: MAC });
  });

  it('keeps the MAC when the IP is edited by hand', async () => {
    const id = register('vinyl lamp', '192.168.86.138', MAC);

    await send('PATCH', `/${id}`, { ip: '192.168.86.41' });

    assert.deepEqual(row(id), { ip: '192.168.86.41', mac: MAC });
  });

  it('returns 409 when another device holds the address, and changes nothing', async () => {
    const id = register('vinyl lamp', '192.168.86.138');
    register('mushroom lamp', '192.168.86.41');

    const res = await send('PATCH', `/${id}`, { ip: '192.168.86.41', mac: MAC });

    assert.equal(res.status, 409);
    assert.deepEqual(row(id), { ip: '192.168.86.138', mac: null });
  });

  it('stores the MAC of a newly registered device', async () => {
    const res = await send('POST', '', { alias: 'new lamp', ip: '192.168.86.77', mac: MAC });

    assert.equal(res.status, 201);
    const { id } = await res.json() as { id: number };
    assert.deepEqual(row(id), { ip: '192.168.86.77', mac: MAC });
  });
});
