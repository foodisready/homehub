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
    db.exec('DELETE FROM reminders; DELETE FROM reminder_asks;');
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
  it('asks if it was done, and is done with a yes', () => {
    const told: string[] = [];
    r.setTellFamilyForTests((title) => { told.push(title); });
    const rem = r.saveReminder({ text: '食藥喇', at: '09:00', ask: true });
    db.prepare('UPDATE reminders SET last_day = NULL WHERE id = ?').run(rem.id);
    r.checkReminders(at(18, 9, 0));
    const [a] = r.pendingAnnouncements(at(18, 9, 0));
    assert.equal(a.text, '食藥喇。食咗藥未呀？');
    assert.equal(typeof a.ask, 'number');
    assert.deepEqual(r.openAsks(at(18, 9, 1)), [{ id: a.ask, lang: 'yue' }]);
    assert.equal(r.answerAsk(a.ask!, 'yes', 'voice', at(18, 9, 1)), true);
    assert.deepEqual(r.openAsks(at(18, 9, 2)), [], 'answered');
    r.checkReminders(at(18, 9, 30));
    assert.deepEqual(told, []);
    const day = r.getReminder(rem.id)!.answers[0];
    assert.equal(day.answer, 'yes');
    assert.equal(day.answeredBy, 'voice');
    assert.equal(r.answerAsk(a.ask!, 'no', 'voice'), false, 'a yes is final');
  });

  it('asks again every 10 minutes, then tells the family', () => {
    const told: string[] = [];
    r.setTellFamilyForTests((title, body) => { told.push(`${title} | ${body}`); });
    const rem = r.saveReminder({ text: 'Take your pills', at: '08:00', ask: true });
    db.prepare('UPDATE reminders SET last_day = NULL WHERE id = ?').run(rem.id);
    r.checkReminders(at(19, 8, 0));
    assert.equal(r.pendingAnnouncements(at(19, 8, 0))[0].text, 'Take your pills. Have you taken it?');
    r.clearQueueForTests();
    r.checkReminders(at(19, 8, 9));
    assert.equal(r.pendingAnnouncements(at(19, 8, 9)).length, 0, 'not yet');
    r.checkReminders(at(19, 8, 10));
    assert.equal(r.pendingAnnouncements(at(19, 8, 10)).length, 1, 'asked a second time');
    r.clearQueueForTests();
    r.checkReminders(at(19, 8, 20));
    assert.equal(r.getReminder(rem.id)!.answers[0].asks, 3);
    r.clearQueueForTests();
    r.checkReminders(at(19, 8, 30));
    assert.equal(r.pendingAnnouncements(at(19, 8, 30)).length, 0, 'not asked a fourth time');
    assert.equal(told.length, 1);
    assert.match(told[0], /^Someone didn’t say “Take your pills” was done \| The 8:00 AM reminder “Take your pills”: Someone didn’t answer, asked 3 times/);
    r.checkReminders(at(19, 9, 0));
    assert.equal(told.length, 1, 'told once');
    // Said done later, in the app: the family hears that too.
    r.answerAsk(r.getReminder(rem.id)!.answers[0].id, 'yes', 'Amy', at(19, 9, 5));
    assert.match(told[1], /^“Take your pills” is done \| Amy said it’s done/);
  });

  it('"not yet" asks again in 10 minutes and says so if it never is', () => {
    const told: string[] = [];
    r.setTellFamilyForTests((title, body) => { told.push(body); });
    const rem = r.saveReminder({ text: 'Take your pills', at: '08:00', ask: true });
    db.prepare('UPDATE reminders SET last_day = NULL WHERE id = ?').run(rem.id);
    r.checkReminders(at(20, 8, 0));
    const id = r.getReminder(rem.id)!.answers[0].id;
    r.answerAsk(id, 'no', 'voice', at(20, 8, 5));
    r.checkReminders(at(20, 8, 14));
    assert.equal(r.getReminder(rem.id)!.answers[0].asks, 1, '10 minutes from the "no"');
    r.checkReminders(at(20, 8, 15));
    r.answerAsk(id, 'no', 'voice', at(20, 8, 16));
    r.checkReminders(at(20, 8, 26));
    r.answerAsk(id, 'no', 'voice', at(20, 8, 27));
    r.checkReminders(at(20, 8, 37));
    assert.match(told[0], /said “not yet” 3 times/);
  });

  it('only asks about medicine when it is about medicine', () => {
    assert.equal(r.question('Put the bins out', 'en'), 'Have you done it?');
    assert.equal(r.question('食藥喇', 'yue'), '食咗藥未呀？');
    assert.equal(r.question('吃药了', 'zh'), '吃药了吗？');
    assert.equal(r.question('Uống thuốc', 'vi'), 'Đã uống thuốc chưa?');
    assert.equal(r.question('Tưới cây', 'vi'), 'Đã làm chưa?');
    assert.equal(r.withQuestion('Pills!', 'en'), 'Pills! Have you taken it?');
    assert.equal(r.withQuestion('食藥喇！', 'yue'), '食藥喇！食咗藥未呀？');
  });
});
