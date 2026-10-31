/**
 * Runs findDeviceByName against a real SQLite DB.
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this file
 * stays on its temp DB even under a runner that hoists static imports.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-find-device-test-'));

let db: Database.Database;
let find: typeof import('./find-device').findDeviceByName;

const foundAlias = (name: string) => {
  const match = find(name);
  return 'device' in match ? match.device.alias : null;
};

describe('findDeviceByName', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP_BASE, 'db.sqlite');
    const { getDb } = await import('../db');
    ({ findDeviceByName: find } = await import('./find-device'));
    db = getDb();
    const add = db.prepare('INSERT INTO devices (alias, ip) VALUES (?, ?)');
    ['My office lamp', 'Long Lamp', 'Media long lamp', 'Main Valve', 'Kitchen lights']
      .forEach((alias, i) => add.run(alias, `10.0.0.${i + 1}`));
  });

  after(() => {
    db.close();
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  });

  it('matches the full name in any case', () => {
    assert.equal(foundAlias('MY OFFICE LAMP'), 'My office lamp');
  });

  it('ignores a leading my or the on either side', () => {
    assert.equal(foundAlias('office lamp'), 'My office lamp');
    assert.equal(foundAlias('the kitchen lights'), 'Kitchen lights');
    assert.equal(foundAlias('my main valve'), 'Main Valve');
  });

  it('treats underscores and hyphens as spaces', () => {
    assert.equal(foundAlias('office_lamp'), 'My office lamp');
    assert.equal(foundAlias('kitchen-lights'), 'Kitchen lights');
  });

  it('accepts a partial name that fits one device', () => {
    assert.equal(foundAlias('office'), 'My office lamp');
  });

  it('prefers an exact match over a longer name containing it', () => {
    assert.equal(foundAlias('long lamp'), 'Long Lamp');
  });

  it('refuses to guess when a name fits several devices', () => {
    const match = find('lamp');
    assert.ok('error' in match);
    assert.match(match.error, /"My office lamp"/);
    assert.match(match.error, /"Media long lamp"/);
  });

  it('reports an unknown name', () => {
    const match = find('garage door');
    assert.ok('error' in match);
    assert.match(match.error, /not found/);
  });

  it('rejects an empty name instead of matching everything', () => {
    assert.ok('error' in find('   '));
    assert.ok('error' in find('my '));
  });
});
