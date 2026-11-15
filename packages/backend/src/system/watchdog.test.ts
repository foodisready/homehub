/**
 * The outside watchdog, against a temp SQLite DB: the address it accepts, the visit it makes, and
 * what the Health page says about it.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-watchdog-test-'));

let db: Database.Database;
let w: typeof import('./watchdog');
let health: typeof import('./health');

const MIN = 60_000;
const answer = (status: number): typeof fetch => (async () => new Response('OK', { status })) as typeof fetch;

describe('outside watchdog', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    w = await import('./watchdog');
    health = await import('./health');
  });
  after(() => { db.close(); fs.rmSync(TMP, { recursive: true, force: true }); });
  beforeEach(() => { w.setWatchdogUrl(null); w.resetWatchdogForTests(); });

  it('takes a web address, and nothing else', () => {
    w.setWatchdogUrl('  https://hc-ping.com/1b2c3d4e-0000-4000-8000-000000000000 ');
    assert.equal(w.watchdogUrl(), 'https://hc-ping.com/1b2c3d4e-0000-4000-8000-000000000000');
    assert.throws(() => w.setWatchdogUrl('hc-ping.com/abc'), /isn’t a web address/);
    assert.throws(() => w.setWatchdogUrl('ftp://example.com/x'), /https:\/\//);
    assert.throws(() => w.setWatchdogUrl(`https://example.com/${'a'.repeat(500)}`), /too long/);
    assert.throws(() => w.setWatchdogUrl(42), /text/);
    w.setWatchdogUrl('');
    assert.equal(w.watchdogUrl(), null, 'empty removes it');
  });

  it('visits the address, saying only that it is HomeHub', async () => {
    w.setWatchdogUrl('https://hc-ping.com/abc');
    let seen: { url: string; ua: string | null } | null = null;
    const r = await w.visit((async (url: string, init?: RequestInit) => {
      seen = { url, ua: new Headers(init?.headers).get('user-agent') };
      return new Response('OK');
    }) as typeof fetch);
    assert.deepEqual(r, { ok: true, error: null });
    assert.deepEqual(seen, { url: 'https://hc-ping.com/abc', ua: 'HomeHub' });
    assert.equal(w.watchdogStatus().lastOk, true);
  });

  it('reports a failed visit in words', async () => {
    w.setWatchdogUrl('https://hc-ping.com/abc');
    assert.match((await w.visit(answer(404))).error ?? '', /404: check the address/);
    const down = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    assert.match((await w.visit(down)).error ?? '', /Couldn’t reach the watchdog \(fetch failed\)/);
  });

  it('tells the Health page whether it is set up and working', async () => {
    assert.equal(health.watchdog(Date.now())[0].level, 'info', 'not set up');

    w.setWatchdogUrl('https://hc-ping.com/abc');
    const t0 = Date.now();
    await w.visit(answer(200), t0);
    assert.equal(health.watchdog(t0 + MIN)[0].level, 'ok');

    await w.visit(answer(500), t0 + 5 * MIN);
    assert.equal(health.watchdog(t0 + 10 * MIN)[0].level, 'ok', 'one miss is not a problem yet');
    await w.visit(answer(500), t0 + 10 * MIN);
    const item = health.watchdog(t0 + 25 * MIN)[0];
    assert.equal(item.level, 'warn');
    assert.match(item.detail, /for 20 minutes/);

    await w.visit(answer(200), t0 + 26 * MIN);
    assert.equal(health.watchdog(t0 + 27 * MIN)[0].level, 'ok', 'recovers');
  });
});
