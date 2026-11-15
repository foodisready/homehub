/**
 * Spoken reminders, against a temp SQLite DB: which voice says them, when they're queued for the
 * voice bridge, and what the page is told about how it went.
 */
process.env.TZ = 'America/New_York';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-reminders-test-'));

let db: Database.Database;
let r: typeof import('./reminders');

const at = (d: number, h: number, min = 0) => new Date(2026, 10, d, h, min).getTime();
const voice = (enabled: boolean, languages: string[]) =>
  db.prepare("INSERT INTO settings (key, value) VALUES ('voice_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify({ enabled, languages }));

describe('spoken reminders', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    r = await import('./reminders');
  });
  after(() => { db.close(); fs.rmSync(TMP, { recursive: true, force: true }); });
  beforeEach(() => {
    db.exec('DELETE FROM reminders;');
    r.clearQueueForTests();
    voice(true, ['en', 'yue', 'vi']);
  });

  it('says each in the language it is written in', () => {
    assert.equal(r.voiceFor('食藥喇', 'auto', ['en', 'yue']), 'yue');
    assert.equal(r.voiceFor('吃药了', 'auto', ['en', 'yue', 'zh']), 'zh');      // simplified, with Mandarin on
    assert.equal(r.voiceFor('食藥喇', 'auto', ['en', 'yue', 'zh']), 'yue');     // traditional stays Cantonese
    assert.equal(r.voiceFor('吃药了', 'auto', ['en', 'zh']), 'zh');             // only Mandarin on
    assert.equal(r.voiceFor('Đóng cửa garage', 'auto', ['en', 'vi']), 'vi');
    assert.equal(r.voiceFor('Take your pills', 'auto', ['en']), 'en');
    assert.equal(r.voiceFor('食藥喇', 'auto', ['en']), null);                  // no Chinese voice on
    assert.equal(r.voiceFor('Đóng cửa', 'auto', ['en']), null);
    assert.equal(r.voiceFor('anything', 'vi', ['en']), null);                   // chosen but not on
    assert.equal(r.voiceFor('anything', 'yue', ['en', 'yue']), 'yue');
  });

  it("won't save one in a language that isn't on, and checks the rest", () => {
    voice(true, ['en']);
    assert.throws(() => r.saveReminder({ text: '食藥喇', at: '09:00' }), /Cantonese or Mandarin isn't on/);
    assert.throws(() => r.saveReminder({ text: 'x', language: 'vi', at: '09:00' }), /Vietnamese isn't on/);
    assert.throws(() => r.saveReminder({ text: 'Pills', at: '9am' }), /HH:MM/);
    assert.throws(() => r.saveReminder({ text: '', at: '09:00' }), /required/);
    assert.throws(() => r.saveReminder({ text: 'Pills', at: '09:00', days: [] }), /weekdays/);
    assert.throws(() => r.saveReminder({ text: 'Pills', at: '09:00', language: 'fr' }), /language must be/);
  });

  it('queues a reminder once at its time, for the bridge to say', () => {
    const rem = r.saveReminder({ text: '食藥喇', at: '09:00' });
    db.prepare('UPDATE reminders SET last_day = NULL WHERE id = ?').run(rem.id);
    assert.equal(r.checkReminders(at(16, 8, 59)), 0);
    assert.equal(r.checkReminders(at(16, 9, 0)), 1);
    assert.equal(r.checkReminders(at(16, 9, 1)), 0);
    const [a] = r.pendingAnnouncements(at(16, 9, 1));
    assert.equal(a.text, '食藥喇');
    assert.equal(a.lang, 'yue');
    assert.equal(r.getReminder(rem.id)!.lastStatus, 'waiting for the speakers');
    // The next day, again.
    assert.equal(r.checkReminders(at(17, 9, 0)), 1);
  });

  it('records which speakers said it, or why none did', () => {
    const rem = r.saveReminder({ text: 'Pills', at: '09:00' });
    const id = r.announce('Pills', 'en', rem.id);
    assert.equal(r.announcementStatus(id)!.state, 'waiting');
    assert.equal(r.announcementDone(id, { said: ['Kitchen speaker'] }), true);
    assert.equal(r.getReminder(rem.id)!.lastStatus, 'said on Kitchen speaker');
    assert.ok(r.getReminder(rem.id)!.lastSaidAt);
    assert.deepEqual(r.announcementStatus(id), { ...r.announcementStatus(id)!, state: 'said', said: ['Kitchen speaker'], error: null });
    assert.equal(r.pendingAnnouncements().length, 0);
    assert.equal(r.announcementDone(id, { said: [] }), false);   // only once

    const id2 = r.announce('Pills', 'en', rem.id);
    r.announcementDone(id2, { said: [], error: 'no speaker can say reminders' });
    assert.equal(r.getReminder(rem.id)!.lastStatus, 'not said: no speaker can say reminders');
    assert.equal(r.announcementStatus(id2)!.state, 'not said');
  });

  it('gives up when the bridge never takes it', () => {
    const rem = r.saveReminder({ text: 'Pills', at: '09:00' });
    const id = r.announce('Pills', 'en', rem.id, at(16, 9));
    assert.equal(r.pendingAnnouncements(at(16, 9, 1)).length, 1);
    assert.equal(r.pendingAnnouncements(at(16, 9, 3)).length, 0);
    assert.match(r.getReminder(rem.id)!.lastStatus!, /voice bridge didn’t answer/);
    assert.equal(r.announcementDone(id, { said: ['x'] }), false);
  });

  it("doesn't say one late after HomeHub was off, or with voice off", () => {
    const rem = r.saveReminder({ text: 'Pills', at: '09:00' });
    db.prepare('UPDATE reminders SET last_day = NULL WHERE id = ?').run(rem.id);
    assert.equal(r.checkReminders(at(16, 9, 30)), 0);
    assert.match(r.getReminder(rem.id)!.lastStatus!, /HomeHub was off/);
    voice(false, ['en']);
    assert.equal(r.checkReminders(at(17, 9, 0)), 0);
    assert.equal(r.getReminder(rem.id)!.lastStatus, 'not said: voice control is off');
  });

  it('skips days not chosen, and a reminder turned off', () => {
    // 2026-11-15 is a Sunday.
    const weekdays = r.saveReminder({ text: 'Bins out', at: '09:00', days: [1, 2, 3, 4, 5] });
    const off = r.saveReminder({ text: 'Off', at: '09:00', enabled: false });
    db.prepare('UPDATE reminders SET last_day = NULL').run();
    assert.equal(r.checkReminders(at(15, 9)), 0);
    assert.equal(r.checkReminders(at(16, 9)), 1);
    assert.equal(r.pendingAnnouncements(at(16, 9))[0].text, 'Bins out');
    assert.ok(weekdays && off);
  });

  it('a new reminder whose time passed today waits for tomorrow', () => {
    const rem = r.saveReminder({ text: 'Pills', at: '00:00' });
    assert.equal(rem.lastDay, new Date().toLocaleDateString('en-CA'));
  });
});
