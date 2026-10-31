/**
 * Runs reconcileDiscovered against a real SQLite DB.
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this file
 * stays on its temp DB even under a runner that hoists static imports.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { DiscoveredDevice } from './DeviceDriver';

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-reconcile-test-'));
const MAC      = '74FECE3576FD';

let db: Database.Database;
let reconcile: typeof import('./reconcile').reconcileDiscovered;

function register(alias: string, ip: string, mac: string | null = null, driverType = 'kasa'): number {
  return Number(db.prepare('INSERT INTO devices (alias, ip, mac, driver_type) VALUES (?, ?, ?, ?)')
    .run(alias, ip, mac, driverType).lastInsertRowid);
}

const scanned = (alias: string, ip: string, mac?: string): DiscoveredDevice =>
  ({ alias, ip, mac, model: 'EP10(US)', hasEmeter: false, driverType: 'kasa' });

const storedMac = (id: number) =>
  (db.prepare('SELECT mac FROM devices WHERE id = ?').get(id) as { mac: string | null }).mac;

describe('reconcileDiscovered', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP_BASE, 'db.sqlite');
    const { getDb } = await import('../db');
    ({ reconcileDiscovered: reconcile } = await import('./reconcile'));
    db = getDb();
  });

  after(() => {
    db.close();
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.prepare('DELETE FROM devices').run();
  });

  it('reports a move when a known MAC answers at a new IP, even if renamed', () => {
    const id = register('Reading lamp', '192.168.86.10', MAC);

    const [result] = reconcile([scanned('vinyl lamp', '192.168.86.41', MAC)]);

    assert.deepEqual(result.moved, { deviceId: id, alias: 'Reading lamp', previousIp: '192.168.86.10' });
  });

  it('does not change the stored IP until the move is confirmed', () => {
    const id = register('vinyl lamp', '192.168.86.10', MAC);

    reconcile([scanned('vinyl lamp', '192.168.86.41', MAC)]);

    assert.deepEqual(db.prepare('SELECT ip FROM devices WHERE id = ?').get(id), { ip: '192.168.86.10' });
  });

  it('reports nothing for a known MAC at its stored IP', () => {
    register('vinyl lamp', '192.168.86.41', MAC);

    const [result] = reconcile([scanned('vinyl lamp', '192.168.86.41', MAC)]);

    assert.equal(result.moved, undefined);
  });

  it('links the MAC of an older device found at its stored IP', () => {
    const id = register('vinyl lamp', '192.168.86.41');

    const [result] = reconcile([scanned('vinyl lamp', '192.168.86.41', MAC)]);

    assert.equal(result.moved, undefined);
    assert.equal(storedMac(id), MAC);
  });

  it('offers a move by name for an older device, without linking the MAC yet', () => {
    const id = register('vinyl lamp', '192.168.86.138');

    const [result] = reconcile([scanned('vinyl lamp', '192.168.86.41', MAC)]);

    assert.deepEqual(result.moved, { deviceId: id, alias: 'vinyl lamp', previousIp: '192.168.86.138' });
    assert.equal(storedMac(id), null);
  });

  it('does not match by name when the registered device has a different MAC', () => {
    register('vinyl lamp', '192.168.86.10', 'AAAAAAAAAAAA');

    const [result] = reconcile([scanned('vinyl lamp', '192.168.86.41', MAC)]);

    assert.equal(result.moved, undefined);
  });

  it('treats an unknown device as new', () => {
    const [result] = reconcile([scanned('new lamp', '192.168.86.77', MAC)]);

    assert.equal(result.moved, undefined);
  });

  it('leaves devices without a MAC alone', () => {
    const id = register('Foyer', '192.168.86.200', null, 'shelly');
    const device = { ...scanned('Foyer', '192.168.86.99'), driverType: 'shelly' };

    const [result] = reconcile([device]);

    assert.equal(result.moved, undefined);
    assert.equal(storedMac(id), null);
  });

  it('matches a MAC only within the same driver', () => {
    register('vinyl lamp', '192.168.86.10', MAC, 'shelly');

    const [result] = reconcile([scanned('other', '192.168.86.41', MAC)]);

    assert.equal(result.moved, undefined);
  });
});
