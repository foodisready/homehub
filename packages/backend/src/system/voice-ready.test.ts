/**
 * Whether voice is back after a start, for the app's "Voice is starting" banner.
 * Against a temp SQLite DB. Modules load in before(), after DB_PATH is set.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-voice-ready-test-'));

let db: Database.Database;
let ready: typeof import('./voice-ready');
let bridge: typeof import('./voice-bridge');

const T0 = Date.parse('2026-11-17T20:22:00Z');
const report = (connected: boolean, state: 'starting' | 'running' = 'running', at = T0) => {
  const r = bridge.recordBridgeReport({
    state, id: 'b1', kind: 'docker', version: '0.1.0',
    speakers: connected ? [{ name: 'Android Voice Assistant', address: '192.168.86.20', connected: true }] : [],
  }, at)!;
  ready.noteBridgeReport(r, at);
};

describe('voice ready after a start', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    bridge = await import('./voice-bridge');
    ready = await import('./voice-ready');
  });

  after(() => {
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.prepare("DELETE FROM settings WHERE key IN ('voice_speaker_connected_at', 'role')").run();
    bridge.forgetBridge();
    bridge.setVoiceSettings({ enabled: true, languages: ['en', 'vi'] });
    ready.resetVoiceReady(T0);
  });

  it('says nothing in a home where no speaker has ever connected', () => {
    report(false, 'running', T0 + 30_000);
    assert.equal(ready.voiceReady(T0 + 60_000).state, 'off');
  });

  it('says nothing when voice is off', () => {
    report(true, 'running', T0 - 1);   // a speaker connected once
    ready.resetVoiceReady(T0);
    bridge.setVoiceSettings({ enabled: false, languages: ['en'] });
    assert.equal(ready.voiceReady(T0 + 10_000).state, 'off');
  });

  it('is starting until a speaker connects, then ready, as after an update', () => {
    report(true, 'running', T0 - 60_000);   // before the update
    ready.resetVoiceReady(T0);               // the update restarts HomeHub
    const before = ready.voiceReady(T0 + 5_000);
    assert.deepEqual({ state: before.state, loading: before.loading }, { state: 'starting', loading: true }, 'the bridge hasn\'t checked in yet');
    report(false, 'starting', T0 + 20_000);
    assert.equal(ready.voiceReady(T0 + 25_000).loading, true, 'loading its speech models');
    report(false, 'running', T0 + 45_000);
    assert.deepEqual(
      (({ state, loading }) => ({ state, loading }))(ready.voiceReady(T0 + 50_000)),
      { state: 'starting', loading: false }, 'models loaded, looking for the speaker');
    report(true, 'running', T0 + 61_000);
    const r = ready.voiceReady(T0 + 62_000);
    assert.equal(r.state, 'ready');
    assert.equal(r.readyAt, new Date(T0 + 61_000).toISOString());
    assert.equal(r.startedAt, new Date(T0).toISOString());
  });

  it('says a speaker is missing after three minutes without one', () => {
    report(true, 'running', T0 - 60_000);
    ready.resetVoiceReady(T0);
    report(false, 'running', T0 + 45_000);
    assert.equal(ready.voiceReady(T0 + ready.MISSING_AFTER_MS - 1).state, 'starting');
    assert.equal(ready.voiceReady(T0 + ready.MISSING_AFTER_MS).state, 'missing');
    // It comes back: ready, and the app says so.
    report(true, 'running', T0 + 6 * 60_000);
    assert.equal(ready.voiceReady(T0 + 6 * 60_000).state, 'ready');
  });

  it('stays ready when a speaker drops later: that\'s the Health page\'s to say', () => {
    report(true, 'running', T0 - 60_000);
    ready.resetVoiceReady(T0);
    report(true, 'running', T0 + 50_000);
    report(false, 'running', T0 + 10 * 60_000);
    assert.equal(ready.voiceReady(T0 + 11 * 60_000).state, 'ready');
  });
});
