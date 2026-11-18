/**
 * "Did you mean…?": a model's reading becomes a question, a yes switches and teaches the words.
 * Against a temp SQLite DB, with stubbed drivers.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { Understanding } from './understand';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-confirm-test-'));

let db: Database.Database;
let c: typeof import('./confirm');
let commands: typeof import('./commands');
let native: typeof import('./native-commands');
const calls: { ip: string; state: boolean }[] = [];

const form = (over: Partial<Understanding>): Understanding =>
  ({ action: 'on', devices: [], scene: null, minutes: null, lang: 'en', ...over });
const nicknames = (alias: string) =>
  JSON.parse((db.prepare('SELECT nicknames n FROM devices WHERE alias = ?').get(alias) as { n: string | null }).n ?? '[]');
const asked = (text: string, u: Understanding) => {
  const r = c.propose(text, u);
  assert.equal(r?.kind, 'ask', `expected a question for ${text}`);
  return (r as { proposal: import('./confirm').Proposal }).proposal;
};

describe('Did you mean…?', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    c = await import('./confirm');
    commands = await import('./commands');
    native = await import('./native-commands');
    const { getDriver } = await import('../drivers/registry');
    for (const kind of ['kasa', 'shelly', 'meross', 'wyze']) {
      getDriver(kind).setPower = async (ip: string, state: boolean) => { calls.push({ ip, state }); };
    }
  });

  after(() => {
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.pragma('foreign_keys = OFF');
    for (const t of ['devices', 'scenes', 'scene_actions']) db.prepare(`DELETE FROM ${t}`).run();
    db.pragma('foreign_keys = ON');
    const add = db.prepare('INSERT INTO devices (alias, ip, room, driver_type, nicknames, is_protected) VALUES (?, ?, ?, ?, ?, ?)');
    add.run('Living room lamps', '10.0.0.1', 'Living room', 'kasa', '["living room lights"]', 0);
    add.run('Living room statue', '10.0.0.2', 'Living room', 'kasa', '["living room lights"]', 0);
    add.run('My office lamp', '10.0.0.3', 'Office', 'kasa', '["文房燈"]', 0);
    add.run('Garage Left', '10.0.0.4', 'Garage', 'meross', '[]', 0);
    add.run('Foyer camera', '10.0.0.5', 'Foyer', 'wyze', '[]', 0);
    add.run('Heater', '10.0.0.6', 'Office', 'kasa', '[]', 1);
    calls.length = 0;
  });

  describe('the question', () => {
    it('takes on or off from the rules\' reading of the verb, not the model', () => {
      // qwen2.5:7b read "tắt" (off) as on; the rules are exact about the verb.
      const p = asked('Tắt hết đèn phòng khách', form({ action: 'on', devices: ['Living room lamps', 'Living room statue'], lang: 'zh' }));
      assert.equal(p.state, false);
      assert.equal(p.lang, 'vi');
      assert.equal(c.askText(p), 'Có phải bạn muốn tắt Living room lamps và Living room statue không?');
      assert.equal(p.phrase, 'hết đèn phòng khách');
    });

    it('reads "turn of" as off, and keeps the misspelt name to learn', () => {
      const p = asked('turn of uffice lighs', form({ action: 'on', devices: ['My office lamp'] }));
      assert.equal(p.state, false);
      assert.equal(c.askText(p), 'Should I turn off My office lamp?');
      assert.equal(p.phrase, 'uffice lighs');
    });

    it('uses the model\'s on or off when the rules can\'t read a verb', () => {
      const p = asked('office lamp please', form({ action: 'on', devices: ['My office lamp'] }));
      assert.equal(p.state, true);
      assert.equal(p.phrase, null);
    });

    it('asks in Cantonese and Mandarin, with a time when one was said', () => {
      const yue = asked('開民房燈十分鐘', form({ devices: ['My office lamp'], minutes: 10, lang: 'yue' }));
      // Named as it's said in that language: its Chinese nickname, not My office lamp.
      assert.equal(c.askText(yue), '係咪要開文房燈10分鐘？');
      const zh = asked('关民房灯', form({ action: 'off', devices: ['My office lamp'], lang: 'zh' }));
      assert.equal(c.askText(zh), '要关掉文房燈吗？');
      assert.equal(zh.phrase, '民房灯');
    });

    it('asks in Vietnamese with the Vietnamese name most like what was said', () => {
      // Heard on Ava: "BẬT ĐÈN VUA" asked "Bật King's lamp?".
      db.prepare('INSERT INTO devices (alias, ip, room, driver_type, nicknames, is_protected) VALUES (?, ?, ?, ?, ?, ?)')
        .run("King's lamp", '10.0.0.7', 'Master bedroom', 'kasa', '["国王的灯","王帝灯","đèn ngủ","đèn của nhà vua"]', 0);
      const p = asked('BẬT ĐÈN VUA', form({ devices: ["King's lamp"], lang: 'vi' }));
      assert.equal(c.askText(p), 'Có phải bạn muốn bật đèn của nhà vua không?');
      assert.deepEqual(p.aliases, ["King's lamp"], 'still switched by its own name');
      // In Cantonese, the Chinese nickname that shares the most characters with what was said.
      assert.equal(c.askText(asked('開皇帝燈', form({ devices: ["King's lamp"], lang: 'yue' }))), '係咪要開王帝灯？');
      assert.equal(c.askText(asked('开皇帝灯', form({ devices: ["King's lamp"], lang: 'yue' }))), '要打开王帝灯吗？', 'simplified 开 reads as Mandarin');
      // In English, and in a language it has no nickname in, its own name.
      assert.equal(c.askText(asked('turn on the king lamp', form({ devices: ["King's lamp"] }))), "Should I turn on King's lamp?");
      assert.equal(c.askText(asked('bật đèn văn phòng', form({ devices: ['My office lamp'], lang: 'vi' }))), 'Có phải bạn muốn bật My office lamp không?');
    });

    it('names a device with no nicknames, or unreadable ones, by its own name', () => {
      assert.equal(c.nameIn({ alias: 'Porch', nicknames: null }, 'vi', 'bật đèn'), 'Porch');
      assert.equal(c.nameIn({ alias: 'Porch', nicknames: 'not json' }, 'yue', '開燈'), 'Porch');
      assert.equal(c.nameIn({ alias: 'Porch', nicknames: '["porch light"]' }, 'vi', 'bật đèn'), 'Porch', 'an English nickname isn\'t Vietnamese');
    });

    it('only ever closes a garage door, and asks to close it when that was said', () => {
      // The model read "đóng" (close) as open; the rules know better.
      const p = asked('Đóng cửa ga-ra', form({ action: 'open', devices: ['Garage Left'], lang: 'vi' }));
      assert.deepEqual([p.state, p.door], [false, true]);
      assert.equal(c.askText(p), 'Có phải bạn muốn đóng Garage Left không?');
      const open = c.propose('Mở cửa ga-ra', form({ action: 'open', devices: ['Garage Left'], lang: 'vi' }));
      assert.deepEqual(open, { kind: 'refuse', why: 'door-open', lang: 'vi' });
      assert.match(c.refusedText(open as never), /không mở cửa ga-ra/);
      // "On" for a door is open too.
      assert.equal(c.propose('garage thing on', form({ action: 'on', devices: ['Garage Left'] }))?.kind, 'refuse');
    });

    it('never pauses a camera this way', () => {
      const r = c.propose('turn off the foyer cam', form({ action: 'off', devices: ['Foyer camera'] }));
      assert.deepEqual(r, { kind: 'refuse', why: 'camera-pause', lang: 'en' });
    });

    it('asks nothing for a question, a scene, nothing named, or a door mixed with lights', () => {
      assert.equal(c.propose('what time is it', form({ action: 'question' })), null);
      assert.equal(c.propose('lights', form({ action: 'unclear' })), null);
      assert.equal(c.propose('turn on stuff', form({ action: 'on', devices: [] })), null);
      assert.equal(c.propose('close everything', form({ action: 'close', devices: ['Garage Left', 'My office lamp'] })), null);
      assert.equal(c.propose('anything', null), null);
    });
  });

  describe('words worth remembering', () => {
    it('keeps specific names and leaves out generic ones, run-ons and one character', () => {
      assert.equal(c.learnable('đèn phòng ăn'), 'đèn phòng ăn');
      assert.equal(c.learnable('the uffice lighs'), 'uffice lighs');
      assert.equal(c.learnable('民房灯'), '民房灯');
      for (const generic of ['lights', 'the lights', 'đèn', 'hết đèn', '燈', '灯', 'it', 'all']) assert.equal(c.learnable(generic), null, generic);
      assert.equal(c.learnable('office light. turn off office light'), null);
      assert.equal(c.learnable('lamp and fan'), null);
      assert.equal(c.learnable('燈仔'), null);
      assert.equal(c.learnable('ab'), null);
      assert.equal(c.learnable(''), null);
      assert.equal(c.learnable('x'.repeat(61)), null);
    });
  });

  describe('the answer', () => {
    it('reads yes and no in each language, and anything else as a new command', () => {
      for (const yes of ['yes', 'Yes!', 'ok', 'yep', 'có', 'co', 'Vâng ạ', 'đúng rồi', '係', '係呀', '好', '是', '对', '對', '嗯']) assert.equal(c.answerKind(yes), 'yes', yes);
      for (const no of ['no', 'No.', 'nope', 'cancel', 'không', 'khong', 'sai', '唔係', '唔好', '不是', '不要', '取消']) assert.equal(c.answerKind(no), 'no', no);
      for (const other of ['turn on the kitchen', 'yes turn on the porch', 'bật đèn bếp', '開燈', '']) assert.equal(c.answerKind(other), null, other);
    });

    it('a yes switches, saves the words as a nickname, and the rules then act on them alone', async () => {
      const p = asked('Bật đèn phòng khách', form({ devices: ['Living room lamps', 'Living room statue'], lang: 'vi' }));
      const done = await c.confirm(p);
      assert.deepEqual(calls.map((x) => x.ip).sort(), ['10.0.0.1', '10.0.0.2']);
      assert.ok(calls.every((x) => x.state));
      assert.equal(done.learned, 'đèn phòng khách');
      assert.match(done.response, /^Đã bật Living room lamps và Living room statue\. Lần sau tôi sẽ hiểu "đèn phòng khách"\.$/);
      assert.deepEqual(nicknames('Living room lamps'), ['living room lights', 'đèn phòng khách']);

      calls.length = 0;
      const again = await native.runNativeCommand('tắt đèn phòng khách');
      assert.equal(again?.response, 'Đã tắt đèn phòng khách.');
      assert.deepEqual(calls.map((x) => x.state), [false, false]);
    });

    it('says nothing about remembering words the devices already had', async () => {
      const p = asked('着文房燈', form({ devices: ['My office lamp'], lang: 'yue' }));
      const done = await c.confirm(p);
      assert.equal(done.learned, null);
      assert.equal(done.response, '開咗文房燈。');
    });

    it('doesn\'t learn words that would then mean other devices too', async () => {
      // "living room" is the room: the rules would read it as both lamps, never only the statue.
      const p = asked('turn on living room', form({ devices: ['Living room statue'] }));
      const done = await c.confirm(p);
      assert.equal(done.learned, null);
      assert.deepEqual(nicknames('Living room statue'), ['living room lights']);
      assert.deepEqual(calls, [{ ip: '10.0.0.2', state: true }]);
    });

    it('closes a door and says so', async () => {
      const p = asked('close the garaj', form({ action: 'close', devices: ['Garage Left'] }));
      const done = await c.confirm(p);
      assert.deepEqual(calls, [{ ip: '10.0.0.4', state: false }]);
      assert.match(done.response, /^Closing Garage Left\./);
      assert.equal(done.learned, 'garaj');
    });

    it('leaves a protected device alone even after a yes, and learns nothing then', async () => {
      const p = asked('turn on the warmer', form({ devices: ['Heater'] }));
      const done = await c.confirm(p);
      assert.deepEqual(calls, []);
      assert.equal(done.learned, null);
      assert.match(done.response, /protected/);
    });

    it('a no changes nothing, in the language asked', () => {
      const p = asked('tắt đèn phòng ăn', form({ action: 'off', devices: ['My office lamp'], lang: 'vi' }));
      assert.equal(c.declined(p), 'Được, tôi không thay đổi gì.');
      assert.deepEqual(calls, []);
    });
  });

  it('typed Cantonese 着 switches on through the rules, like the voice bridge', async () => {
    const r = await native.runNativeCommand('着文房燈');
    assert.equal(r?.response, '開咗文房燈。');
    assert.deepEqual(calls, [{ ip: '10.0.0.3', state: true }]);
    assert.equal(commands.isGarageDoor({ driver_type: 'meross' }), true);
  });
});

describe('the waiting question', () => {
  it('waits two minutes for its answer, and is taken by the first one', async () => {
    const c = await import('./confirm');
    const p = { deviceIds: [1], aliases: ['Lamp'], state: true, minutes: null, door: false, lang: 'en' as const, phrase: null, text: 'lamp on' };
    c.setPending('user:1', p, 1_000);
    assert.equal(c.takePending('user:2', 1_000), null, 'someone else');
    assert.deepEqual(c.takePending('user:1', 1_000 + c.PENDING_MS - 1), p);
    assert.equal(c.takePending('user:1', 1_000), null, 'already answered');
    c.setPending('user:1', p, 1_000);
    assert.equal(c.takePending('user:1', 1_000 + c.PENDING_MS), null, 'too late');
  });
});
