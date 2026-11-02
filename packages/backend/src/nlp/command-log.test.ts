/**
 * Runs the chat command log against a real SQLite DB.
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

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-command-log-test-'));

let db: Database.Database;
let log: typeof import('./command-log');

describe('chat command log', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP_BASE, 'db.sqlite');
    const { getDb } = await import('../db');
    log = await import('./command-log');
    db = getDb();
  });

  after(() => {
    db.close();
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.prepare('DELETE FROM chat_commands').run();
    db.prepare('DELETE FROM voice_commands').run();
  });

  it('counts voice commands apart from Chat and lists what was misheard, newest first', () => {
    log.recordVoiceCommand('turn on lamp', true);
    log.recordVoiceCommand('i love my lamp', false);
    log.recordVoiceCommand('office lamp', false);

    const stats = log.getCommandStats();

    assert.equal(stats.total, 0);
    assert.equal(stats.voice.total, 3);
    assert.equal(stats.voice.understood, 1);
    assert.equal(stats.voice.missed, 2);
    assert.deepEqual(stats.voice.recentMissed.map((r) => r.text), ['office lamp', 'i love my lamp']);
  });

  it('reports no voice commands on an empty log', () => {
    const { voice } = log.getCommandStats();
    assert.deepEqual(voice, { total: 0, understood: 0, missed: 0, recentMissed: [] });
  });

  it('counts each handler and lists what the model received, newest first', () => {
    log.recordCommand('turn on lamp', 'rules');
    log.recordCommand('lights out', 'model');
    log.recordCommand('what is on', 'model');

    const stats = log.getCommandStats();

    assert.equal(stats.total, 3);
    assert.equal(stats.rules, 1);
    assert.equal(stats.model, 2);
    assert.deepEqual(stats.recentModel.map((r) => r.text), ['what is on', 'lights out']);
  });

  it('keeps only the latest 1,000 commands', () => {
    for (let i = 0; i < 1005; i++) log.recordCommand(`command ${i}`, 'rules');

    assert.equal(log.getCommandStats().total, 1000);
    const oldest = db.prepare('SELECT text FROM chat_commands ORDER BY id LIMIT 1').get() as { text: string };
    assert.equal(oldest.text, 'command 5');
  });

  it('shortens a very long message', () => {
    log.recordCommand('x'.repeat(500), 'model');

    assert.equal(log.getCommandStats().recentModel[0].text.length, 200);
  });
});
