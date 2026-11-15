/**
 * Secrets HomeHub generates for itself, in a temp folder.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-secrets-test-'));
const DIR = path.join(TMP, 'secrets');
const KEYS = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'INTERNAL_API_KEY', 'MCP_SECRET', 'WATCHTOWER_HTTP_API_TOKEN', 'WYZE_BRIDGE_API_KEY', 'HOMEHUB_CAMERA_BRIDGE', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];

let secrets: typeof import('./secrets');
const saved: Record<string, string | undefined> = {};

describe('generated secrets', () => {
  before(async () => {
    for (const k of [...KEYS, 'HOMEHUB_SECRETS_DIR']) saved[k] = process.env[k];
    process.env.HOMEHUB_SECRETS_DIR = DIR;
    secrets = await import('./secrets');
  });

  after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(DIR, { recursive: true, force: true });
    for (const k of KEYS) delete process.env[k];
  });

  it('makes each secret once and keeps it across restarts', () => {
    const { created } = secrets.loadSecrets();
    assert.deepEqual(created, [...secrets.MANAGED_SECRETS]);
    const first = process.env.JWT_SECRET;
    assert.match(first ?? '', /^[0-9a-f]{64}$/);
    assert.notEqual(process.env.JWT_SECRET, process.env.JWT_REFRESH_SECRET);
    assert.equal(fs.statSync(path.join(DIR, 'JWT_SECRET')).mode & 0o777, 0o640);

    delete process.env.JWT_SECRET;   // a restart: nothing in the environment
    assert.deepEqual(secrets.loadSecrets().created, []);
    assert.equal(process.env.JWT_SECRET, first);
  });

  it('uses values from .env, including over a file, and ignores the change-me examples', () => {
    process.env.MCP_SECRET = 'from-env';
    process.env.INTERNAL_API_KEY = 'change-me-generate-with-openssl-rand-base64-32';
    const { created } = secrets.loadSecrets();
    assert.equal(process.env.MCP_SECRET, 'from-env');
    assert.ok(!created.includes('MCP_SECRET'));
    assert.ok(!fs.existsSync(path.join(DIR, 'MCP_SECRET')));
    assert.match(process.env.INTERNAL_API_KEY ?? '', /^[0-9a-f]{64}$/);
  });

  it('makes a push key pair once and keeps it, unless .env has one', () => {
    secrets.loadSecrets();
    const pub = process.env.VAPID_PUBLIC_KEY ?? '';
    const priv = process.env.VAPID_PRIVATE_KEY ?? '';
    assert.match(pub, /^[A-Za-z0-9_-]{87}$/, 'an uncompressed P-256 public key, base64url');
    assert.match(priv, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(fs.statSync(path.join(DIR, 'VAPID_KEYS')).mode & 0o777, 0o600);

    delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY;   // a restart
    secrets.loadSecrets();
    assert.deepEqual([process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY], [pub, priv]);

    process.env.VAPID_PUBLIC_KEY = 'env-pub'; process.env.VAPID_PRIVATE_KEY = 'env-priv';
    secrets.loadSecrets();
    assert.deepEqual([process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY], ['env-pub', 'env-priv']);

    fs.writeFileSync(path.join(DIR, 'VAPID_KEYS'), 'not json');
    delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY;
    secrets.loadSecrets();
    assert.match(process.env.VAPID_PUBLIC_KEY ?? '', /^[A-Za-z0-9_-]{87}$/, 'a broken file is replaced');
  });

  it('uses the camera key unless .env leaves the bridge out', () => {
    secrets.loadSecrets();
    const key = fs.readFileSync(path.join(DIR, 'WYZE_BRIDGE_API_KEY'), 'utf8').trim();
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(process.env.WYZE_BRIDGE_API_KEY, key, 'on by default');

    for (const off of ['0', 'off', 'false']) {
      process.env.HOMEHUB_CAMERA_BRIDGE = off;
      delete process.env.WYZE_BRIDGE_API_KEY;
      secrets.loadSecrets();
      assert.equal(process.env.WYZE_BRIDGE_API_KEY, undefined, off);
      assert.ok(fs.existsSync(path.join(DIR, 'WYZE_BRIDGE_API_KEY')), 'the key stays, for adding the bridge back');
    }
    process.env.HOMEHUB_CAMERA_BRIDGE = '1';
    secrets.loadSecrets();
    assert.equal(process.env.WYZE_BRIDGE_API_KEY, key);
  });

  it('keeps an empty file from becoming an empty secret', () => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, 'JWT_SECRET'), '\n');
    secrets.loadSecrets();
    assert.match(process.env.JWT_SECRET ?? '', /^[0-9a-f]{64}$/);
  });
});
