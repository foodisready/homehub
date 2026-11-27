/**
 * Black-box tests for the floor map routes.
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this file
 * stays on its temp DB even under a runner that hoists static imports.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import type Database from 'better-sqlite3';

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-floors-test-'));

// The smallest real PNG (1×1) and the first bytes of a JPEG.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6300010000050001' +
  '0d0a2db40000000049454e44ae426082', 'hex');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);

let server: http.Server;
let baseUrl: string;
let db: Database.Database;

function form(fields: Record<string, string>, image?: Buffer, filename = 'floor.png'): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  if (image) f.append('image', new Blob([new Uint8Array(image)]), filename);
  return f;
}

const call = (method: string, url: string, body?: unknown, role = 'admin', headers: Record<string, string> = {}) => fetch(`${baseUrl}/api/floors${url}`, {
  method,
  headers: { 'x-test-role': role, ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...headers },
  body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
});

async function addFloor(name = 'Main floor', image = PNG): Promise<number> {
  const res = await call('POST', '/', form({ name }, image));
  assert.equal(res.status, 201);
  return ((await res.json()) as { id: number }).id;
}

describe('floor maps', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP_BASE, 'db.sqlite');
    const { getDb } = await import('../db');
    const { floorsRouter } = await import('./floors');
    db = getDb();

    const app = express();
    app.use(express.json());
    // Stands in for the JWT check: admin unless a test says otherwise.
    app.use((req, _res, next) => {
      req.user = { userId: 1, username: 't', role: (req.headers['x-test-role'] as string) ?? 'admin' } as never;
      next();
    });
    app.use('/api/floors', floorsRouter);
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
    db.prepare('DELETE FROM floor_maps').run();
  });

  it('adds a floor from a picture, in order, and gives the picture back as it was', async () => {
    const main = await addFloor('Main floor');
    const up = await addFloor('Upstairs', JPEG);

    const floors = (await (await call('GET', '/', undefined, 'member')).json()) as { id: number; name: string; pins: unknown[] }[];
    assert.deepEqual(floors.map((f) => [f.id, f.name, f.pins.length]), [[main, 'Main floor', 0], [up, 'Upstairs', 0]]);

    const img = await call('GET', `/${main}/image`, undefined, 'member');
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
    assert.equal((await call('GET', `/${up}/image`)).headers.get('content-type'), 'image/jpeg');
  });

  it('tells a phone its picture has not changed', async () => {
    const id = await addFloor();
    const tag = (await call('GET', `/${id}/image`)).headers.get('etag')!;
    assert.equal((await call('GET', `/${id}/image`, undefined, 'admin', { 'If-None-Match': tag })).status, 304);
  });

  it('turns away a file that is not a picture, whatever it is called', async () => {
    const res = await call('POST', '/', form({ name: 'Main' }, Buffer.from('%PDF-1.7 not a picture'), 'plan.png'));
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, 'BAD_IMAGE');
    assert.equal((await call('POST', '/', form({ name: 'Main' }))).status, 400, 'no picture');
    assert.equal((await call('POST', '/', form({ name: '  ' }, PNG))).status, 400, 'no name');
  });

  it('turns away a picture over 4 MB', async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(4 * 1024 * 1024)]);
    const res = await call('POST', '/', form({ name: 'Main' }, big));
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /too large/);
  });

  it('places rooms, and keeps them when the picture is replaced', async () => {
    const id = await addFloor();
    const pins = [{ room: 'Kitchen', x: 0.62, y: 0.55 }, { room: '廚房', x: 0.1, y: 0.9 }];
    assert.equal((await call('PUT', `/${id}/pins`, { pins })).status, 200);
    assert.equal((await call('PUT', `/${id}/image`, form({}, JPEG))).status, 200);

    const [floor] = (await (await call('GET', '/')).json()) as { pins: { room: string; x: number; y: number }[] }[];
    assert.deepEqual(floor.pins, [{ room: 'Kitchen', x: 0.62, y: 0.55 }, { room: '廚房', x: 0.1, y: 0.9 }]);
    assert.equal((await call('GET', `/${id}/image`)).headers.get('content-type'), 'image/jpeg');
  });

  it('turns away a room placed off the picture or twice', async () => {
    const id = await addFloor();
    assert.equal((await call('PUT', `/${id}/pins`, { pins: [{ room: 'Kitchen', x: 1.2, y: 0.5 }] })).status, 400);
    assert.equal((await call('PUT', `/${id}/pins`, { pins: [{ room: '', x: 0.2, y: 0.5 }] })).status, 400);
    assert.equal((await call('PUT', `/${id}/pins`, { pins: [{ room: 'Den', x: 0.2, y: 0.5 }, { room: 'Den', x: 0.3, y: 0.5 }] })).status, 400);
    assert.equal((await call('PUT', `/${id}/pins`, { pins: 'Kitchen' })).status, 400);
  });

  it('renames and deletes a floor, and its rooms go with it', async () => {
    const id = await addFloor();
    await call('PUT', `/${id}/pins`, { pins: [{ room: 'Kitchen', x: 0.5, y: 0.5 }] });
    const renamed = (await (await call('PUT', `/${id}`, { name: 'Ground floor' })).json()) as { name: string };
    assert.equal(renamed.name, 'Ground floor');

    assert.equal((await call('DELETE', `/${id}`)).status, 204);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM floor_pins').get() as { n: number }).n, 0);
    assert.equal((await call('GET', `/${id}/image`)).status, 404);
  });

  it('lets family see the map but not change it', async () => {
    const id = await addFloor();
    assert.equal((await call('POST', '/', form({ name: 'Upstairs' }, PNG), 'member')).status, 403);
    assert.equal((await call('PUT', `/${id}`, { name: 'Mine' }, 'member')).status, 403);
    assert.equal((await call('PUT', `/${id}/pins`, { pins: [] }, 'member')).status, 403);
    assert.equal((await call('PUT', `/${id}/image`, form({}, PNG), 'member')).status, 403);
    assert.equal((await call('DELETE', `/${id}`, undefined, 'member')).status, 403);
    assert.equal((await call('GET', '/', undefined, 'member')).status, 200);
  });
});
