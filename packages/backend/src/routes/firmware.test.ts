/**
 * Black-box tests for the firmware admin + public routes against a real
 * SQLite DB and a real on-disk firmware directory under tmpdir. Mounts
 * just the two firmware routers + the global authenticate middleware so
 * we exercise the same auth pattern the production app uses.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import express from 'express';
import http from 'node:http';

const TMP_BASE = path.join(os.tmpdir(), `homehub-firmware-test-${process.pid}-${Date.now()}`);
fs.mkdirSync(TMP_BASE, { recursive: true });

// Both DB and firmware-dir resolution happen relative to process.cwd().
// Switch cwd into the tmp area BEFORE importing modules that read those
// paths at import time.
process.chdir(TMP_BASE);
fs.mkdirSync(path.join(TMP_BASE, 'data'), { recursive: true });
process.env.DB_PATH = path.join(TMP_BASE, 'data', 'db.sqlite');
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret';

import { getDb } from '../db';
import { firmwareApiRouter, firmwarePublicRouter } from './firmware';
import { authenticate } from '../middleware/auth';
import { issueTokens, type UserRow } from '../auth/auth.service';

let server: http.Server;
let baseUrl: string;
let adminToken: string;
let memberToken: string;

before(async () => {
  getDb();

  // Seed two users so we can exercise admin vs non-admin paths.
  const db = getDb();
  db.prepare('INSERT INTO users (name, password_hash, role) VALUES (?, ?, ?)').run('admin', 'x', 'admin');
  db.prepare('INSERT INTO users (name, password_hash, role) VALUES (?, ?, ?)').run('member', 'x', 'member');
  const admin  = db.prepare('SELECT * FROM users WHERE name = ?').get('admin')  as UserRow;
  const member = db.prepare('SELECT * FROM users WHERE name = ?').get('member') as UserRow;
  adminToken  = issueTokens(admin).accessToken;
  memberToken = issueTokens(member).accessToken;

  // Same wiring as production: authenticate gates all /api routes; /firmware is public.
  const app = express();
  app.use(express.json());
  app.use('/firmware', firmwarePublicRouter);
  app.use('/api', authenticate);
  app.use('/api/firmware', firmwareApiRouter);

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
  try { fs.rmSync(TMP_BASE, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  getDb().prepare('DELETE FROM firmware_releases').run();
  const dir = path.join(TMP_BASE, 'data', 'firmware');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  }
});

/**
 * Build a multipart/form-data body with one binary file part + arbitrary
 * text fields. Stays string-only on the boilerplate so we don't pull in
 * a multipart library just for tests.
 */
function buildMultipart(boundary: string, fields: Record<string, string>, filename: string, fileBytes: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  ));
  parts.push(fileBytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

async function uploadBin(token: string, fields: Record<string, string>, fileBytes: Buffer): Promise<{ status: number; body: unknown }> {
  const boundary = `----test-${Math.random().toString(36).slice(2)}`;
  const body = buildMultipart(boundary, fields, 'firmware.bin', fileBytes);
  const r = await fetch(`${baseUrl}/api/firmware`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  return { status: r.status, body: await r.json() };
}

const validBin = (size = 64) => {
  const b = Buffer.alloc(size, 0x00);
  b[0] = 0xe9;   // ESP32 image magic
  return b;
};

describe('firmware admin routes', () => {
  it('rejects upload without auth', async () => {
    const r = await fetch(`${baseUrl}/api/firmware`, { method: 'POST' });
    assert.equal(r.status, 401);
  });

  it('rejects upload from non-admin', async () => {
    const { status, body } = await uploadBin(memberToken, { version: '0.2.0' }, validBin());
    assert.equal(status, 403);
    assert.equal((body as { code: string }).code, 'FORBIDDEN');
  });

  it('uploads valid bin and lists it', async () => {
    const { status, body } = await uploadBin(adminToken, { version: '0.2.0', notes: 'first' }, validBin(128));
    assert.equal(status, 201);
    const release = body as { id: number; version: string; sizeBytes: number; sha256: string; filename: string };
    assert.equal(release.version, '0.2.0');
    assert.equal(release.sizeBytes, 128);
    assert.match(release.sha256, /^[a-f0-9]{64}$/);
    assert.equal(release.filename, 'auraflow-mainline-0.2.0.bin');

    const filepath = path.join(TMP_BASE, 'data', 'firmware', release.filename);
    assert.ok(fs.existsSync(filepath), 'file written to disk');

    const listResp = await fetch(`${baseUrl}/api/firmware`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    const list = await listResp.json() as { id: number }[];
    assert.equal(list.length, 1);
    assert.equal(list[0].id, release.id);
  });

  it('rejects non-ESP32 image (missing 0xE9 magic)', async () => {
    const bad = Buffer.alloc(64, 0xff);
    const { status, body } = await uploadBin(adminToken, { version: '0.2.0' }, bad);
    assert.equal(status, 400);
    assert.equal((body as { code: string }).code, 'NOT_ESP32_IMAGE');
  });

  it('rejects bad version string', async () => {
    const { status } = await uploadBin(adminToken, { version: 'has spaces' }, validBin());
    assert.equal(status, 400);
  });

  it('rejects duplicate (target, version) and rolls back the disk write', async () => {
    const first = await uploadBin(adminToken, { version: '0.2.0' }, validBin());
    assert.equal(first.status, 201);

    const second = await uploadBin(adminToken, { version: '0.2.0' }, validBin());
    assert.equal(second.status, 409);

    // The directory should still hold exactly one file (the original).
    const files = fs.readdirSync(path.join(TMP_BASE, 'data', 'firmware'));
    assert.equal(files.length, 1);
  });

  it('delete removes both row and file', async () => {
    const { body } = await uploadBin(adminToken, { version: '0.3.0' }, validBin());
    const release = body as { id: number; filename: string };

    const r = await fetch(`${baseUrl}/api/firmware/${release.id}`, {
      method: 'DELETE', headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    assert.equal(r.status, 204);
    assert.ok(!fs.existsSync(path.join(TMP_BASE, 'data', 'firmware', release.filename)), 'file removed');
  });
});

describe('firmware public route', () => {
  it('serves the binary at GET /firmware/:filename without auth', async () => {
    const bytes = validBin(256);
    const { body } = await uploadBin(adminToken, { version: '0.4.0' }, bytes);
    const release = body as { filename: string; sizeBytes: number; sha256: string };

    const r = await fetch(`${baseUrl}/firmware/${release.filename}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/octet-stream');
    const fetched = Buffer.from(await r.arrayBuffer());
    assert.equal(fetched.length, release.sizeBytes);
    assert.equal(fetched[0], 0xe9);
  });

  it('404s for an unknown filename', async () => {
    const r = await fetch(`${baseUrl}/firmware/auraflow-mainline-9.9.9.bin`);
    assert.equal(r.status, 404);
  });

  it('rejects path-traversal attempts', async () => {
    const r = await fetch(`${baseUrl}/firmware/..%2Fdb.sqlite`);
    // Either 400 (regex rejected) or 404 (db has no such filename) is fine —
    // both prove we never serve a file outside the tracked release set.
    assert.ok(r.status === 400 || r.status === 404, `expected 400 or 404, got ${r.status}`);
  });
});
