/**
 * SOS, against a temp SQLite DB with the ways of telling replaced: what goes out on each round,
 * who's called in turn, someone being on it, cancelling, and buttons.
 */
process.env.TZ = 'America/New_York';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-sos-test-'));

let db: Database.Database;
let sos: typeof import('./sos');

const MIN = 60_000;
const T0 = new Date(2026, 10, 15, 3, 12).getTime();

interface Sent { push: string[]; email: string[]; texts: string[]; calls: string[]; said: { text: string; lang: string }[] }
let sent: Sent;
let numbers: string[];

describe('SOS', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    sos = await import('./sos');
  });
  after(() => { sos.setSendersForTests(null); db.close(); fs.rmSync(TMP, { recursive: true, force: true }); });
  beforeEach(() => {
    db.exec("DELETE FROM sos_alerts; DELETE FROM sos_buttons; DELETE FROM checkins; DELETE FROM settings WHERE key IN ('sos_settings', 'voice_settings');");
    sent = { push: [], email: [], texts: [], calls: [], said: [] };
    numbers = [];
    sos.setSendersForTests({
      push: (title, body) => { sent.push.push(`${title} | ${body}`); },
      email: async (subject) => { sent.email.push(subject); return 2; },
      texts: async (text) => { sent.texts.push(text); return 2; },
      call: async (to) => { sent.calls.push(to); return true; },
      callNumbers: () => numbers,
      announce: (text, lang) => { sent.said.push({ text, lang }); },
    });
  });

  it('tells everyone at once, saying how and when', async () => {
    sos.saveSosSettings({ who: 'Mum' });
    const r = sos.raise({ via: 'voice', place: 'Kitchen speaker', lang: 'yue', heard: '救命' }, T0);
    assert.equal(r.state, 'raised');
    await r.done;
    assert.deepEqual(sent.push, ['SOS: Mum asked for help | By voice on Kitchen speaker at 3:12 AM. Open HomeHub and tap “I’m on it”.']);
    assert.deepEqual(sent.email, ['SOS: Mum asked for help']);
    assert.equal(sent.texts.length, 1);
    assert.match(sent.texts[0], /Mum asked for help by voice on Kitchen speaker at 3:12 AM/);
    assert.deepEqual(sent.calls, [], 'no calls unless chosen');
    const a = sos.getAlert(r.alert.id)!;
    assert.deepEqual(a.told, { phones: 0, emails: 2, texts: 2, calls: 0 });
    assert.equal(a.rounds, 1);
  });

  it('asks again every 5 minutes, calling one number each time, until someone is on it', async () => {
    numbers = ['+15550001', '+15550002'];
    await sos.raise({ via: 'button', place: 'Bedside' }, T0).done;
    await sos.tick(T0 + 4 * MIN);
    assert.equal(sent.push.length, 1, 'not yet');
    await sos.tick(T0 + 5 * MIN);
    await sos.tick(T0 + 10 * MIN);
    assert.equal(sent.push.length, 3);
    assert.match(sent.push[2], /still no answer, 10 min/);
    assert.deepEqual(sent.calls, ['+15550001', '+15550002', '+15550001'], 'in turn');
    assert.equal(sent.email.length, 1, 'email and texts only the first time');
    assert.equal(sent.texts.length, 1);

    const id = sos.openAlert(T0 + 11 * MIN)!.id;
    sos.acknowledge(id, 'David', T0 + 11 * MIN);
    assert.match(sent.push.at(-1)!, /^David is on it/);
    await sos.tick(T0 + 20 * MIN);
    assert.equal(sent.calls.length, 3, 'no more calls once someone is on it');
  });

  it('tells the person who is coming, in their language', async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('voice_settings', ?)").run(JSON.stringify({ enabled: true, languages: ['en', 'vi'] }));
    const voice = sos.raise({ via: 'voice', lang: 'yue' }, T0);
    sos.acknowledge(voice.alert.id, 'David', T0 + MIN);
    assert.deepEqual(sent.said, [{ text: 'David已經知道，就嚟幫你。', lang: 'yue' }], 'the language it was asked in');

    await sos.cancel(voice.alert.id, 'Mum', T0 + 2 * MIN);
    const button = sos.raise({ via: 'button', place: 'Bedside' }, T0 + 3 * MIN);
    sos.acknowledge(button.alert.id, 'Amy', T0 + 4 * MIN);
    assert.deepEqual(sent.said[1], { text: 'Amy đã biết rồi, đang đến giúp.', lang: 'vi' }, 'a button: the home’s other language');
  });

  it('gives up after the last round and says so', async () => {
    await sos.raise({ via: 'app', place: 'Mum' }, T0).done;
    for (let m = 5; m <= 30; m += 5) await sos.tick(T0 + m * MIN);
    assert.equal(sos.openAlert(T0 + 31 * MIN), null);
    assert.match(sent.push.at(-1)!, /^Nobody said they’re on/);
    assert.equal(sent.push.filter((p) => p.startsWith('SOS')).length, sos.ROUNDS);
  });

  it('a second call while one is going is the same one', async () => {
    const first = sos.raise({ via: 'voice', place: 'Kitchen speaker' }, T0);
    await first.done;
    const second = sos.raise({ via: 'button', place: 'Bedside' }, T0 + 2 * MIN);
    assert.equal(second.state, 'already');
    assert.equal(second.alert.id, first.alert.id);
    assert.match(sent.push.at(-1)!, /asked for help again \| With the Bedside button/);
    assert.equal(sent.email.length, 1);
  });

  it('cancelling tells everyone who was told, the same ways', async () => {
    const r = sos.raise({ via: 'voice' }, T0);
    await r.done;
    const a = await sos.cancel(r.alert.id, 'Someone', T0 + MIN);
    assert.ok(a.cancelledAt);
    assert.match(sent.push.at(-1)!, /^Cancelled: Someone is OK/);
    assert.equal(sent.email.length, 2);
    assert.equal(sent.texts.length, 2);
    assert.equal(sos.openAlert(T0 + 2 * MIN), null);
    await sos.tick(T0 + 10 * MIN);
    assert.equal(sent.push.filter((p) => p.startsWith('SOS')).length, 1, 'no more rounds');
    assert.throws(() => sos.acknowledge(r.alert.id, 'David'), /already said they’re OK/);
  });

  it('is for the check-in’s person unless a name is set', () => {
    assert.equal(sos.personName(), 'Someone');
    db.prepare("INSERT INTO checkins (name) VALUES ('Grandma')").run();
    assert.equal(sos.personName(), 'Grandma');
    sos.saveSosSettings({ who: '  Mum ' });
    assert.equal(sos.personName(), 'Mum');
    assert.throws(() => sos.saveSosSettings({ who: 'x'.repeat(41) }), /too long/);
    assert.throws(() => sos.saveSosSettings({ calls: 'yes' }), /true or false/);
  });

  it('a button calls for help, and a double press cancels', async () => {
    const b = sos.addButton(' Bedside ');
    assert.equal(b.name, 'Bedside');
    assert.match(b.token, /^[0-9a-f]{32}$/);
    assert.equal(await sos.buttonPressed('nope', 'help', T0), false);
    assert.equal(await sos.buttonPressed(b.token, 'help', T0), true);
    assert.match(sent.push[0], /With the Bedside button at 3:12 AM/);
    await sos.buttonPressed(b.token, 'cancel', T0 + MIN);
    assert.equal(sos.openAlert(T0 + 2 * MIN), null);
    assert.ok(sos.listButtons()[0].lastUsedAt);
    assert.throws(() => sos.addButton(''), /name/);
  });

  it('the test says it is a test, and calls only the first number', async () => {
    numbers = ['+15550001', '+15550002'];
    const told = await sos.testSos('David');
    assert.match(sent.push[0], /^Test: SOS from HomeHub/);
    assert.deepEqual(sent.calls, ['+15550001']);
    assert.deepEqual(told, { phones: 0, emails: 2, texts: 2, calls: 1 });
    assert.equal(sos.recentAlerts().length, 0, 'not recorded as a call for help');
  });
});
