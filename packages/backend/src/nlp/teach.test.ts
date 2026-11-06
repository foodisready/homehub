/**
 * Teaching HomeHub missed commands, against a temp SQLite DB.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-teach-test-'));

let db: Database.Database;
let teachMod: typeof import('./teach');
let commands: typeof import('./commands');
let log: typeof import('./command-log');
const calls: { ip: string; state: boolean }[] = [];

const voiceMiss = (text: string) => {
  log.recordVoiceCommand(text, false);
  return (db.prepare('SELECT id FROM voice_commands ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
};
const id = (alias: string) => (db.prepare('SELECT id FROM devices WHERE alias = ?').get(alias) as { id: number }).id;
const nicknames = (alias: string) =>
  JSON.parse((db.prepare('SELECT nicknames n FROM devices WHERE alias = ?').get(alias) as { n: string | null }).n ?? '[]');

describe('teaching missed commands', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    teachMod = await import('./teach');
    commands = await import('./commands');
    log = await import('./command-log');
    (await import('../drivers/registry')).getDriver('kasa').setPower = async (ip: string, state: boolean) => { calls.push({ ip, state }); };
  });

  after(() => {
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.pragma('foreign_keys = OFF');
    for (const t of ['devices', 'scenes', 'scene_actions', 'voice_commands', 'chat_commands']) db.prepare(`DELETE FROM ${t}`).run();
    db.pragma('foreign_keys = ON');
    const add = db.prepare('INSERT INTO devices (alias, ip, room) VALUES (?, ?, ?)');
    add.run('Brenden bed lamp', '10.0.0.1', "Brenden's room");
    add.run('Desk', '10.0.0.2', "Brenden's room");
    add.run('My office lamp', '10.0.0.3', 'Office');
    add.run('Main Valve', '10.0.0.4', null);
    calls.length = 0;
  });

  it('lists misses from voice and Chat with the words to teach, once per wording', () => {
    voiceMiss("Turn on Brenden's thing.");
    voiceMiss("turn on brenden's thing");
    log.recordCommand('lights for reading', 'model');
    log.recordCommand('turn on the office lamp', 'rules');

    const misses = teachMod.listMisses().map((m) => [m.source, m.phrase, m.kind]).sort();
    assert.deepEqual(misses, [
      ['chat', 'lights for reading', 'scene'],
      ['voice', "brenden's thing", 'device'],
    ]);
  });

  it('teaches a phrase for one device, and the command then works', async () => {
    const miss = voiceMiss('Turn on the reading light.');
    const result = teachMod.teach({ source: 'voice', id: miss, phrase: 'reading light', deviceIds: [id('Desk')] });

    assert.deepEqual(result, { phrase: 'reading light', devices: ['Desk'] });
    assert.deepEqual(nicknames('Desk'), ['reading light']);
    assert.equal(teachMod.listMisses().length, 0, 'gone from the list');

    const reply = await commands.runPowerCommand('turn on the reading light');
    assert.equal(reply?.response, 'Turned on Desk.');
    assert.deepEqual(calls, [{ ip: '10.0.0.2', state: true }]);
  });

  it('teaches a phrase for several devices as a group', async () => {
    const miss = voiceMiss('Turn on bedtime lights.');
    teachMod.teach({ source: 'voice', id: miss, phrase: 'bedtime lights', deviceIds: [id('Brenden bed lamp'), id('My office lamp')] });

    await commands.runPowerCommand('turn on bedtime lights');
    assert.deepEqual(calls.map((c) => c.ip).sort(), ['10.0.0.1', '10.0.0.3']);
  });

  it('teaches another name for a scene', async () => {
    const scene = Number(db.prepare("INSERT INTO scenes (name) VALUES ('Goodnight')").run().lastInsertRowid);
    db.prepare('INSERT INTO scene_actions (scene_id, device_id, state) VALUES (?, ?, 0)').run(scene, id('My office lamp'));
    const miss = voiceMiss('Lights out.');

    assert.deepEqual(teachMod.teach({ source: 'voice', id: miss, phrase: 'lights out', sceneId: scene }), { phrase: 'lights out', scene: 'Goodnight' });
    assert.equal((await commands.runPowerCommand('lights out'))?.response, 'Ran Goodnight.');
  });

  it("refuses another device's name, and saves nothing", () => {
    const miss = voiceMiss('Turn on my office lamp please.');
    assert.throws(() => teachMod.teach({ source: 'voice', id: miss, phrase: 'my office lamp', deviceIds: [id('Desk')] }), /already called that/);
    assert.deepEqual(nicknames('Desk'), []);
    assert.equal(teachMod.listMisses().length, 1, 'still listed');
  });

  it('refuses words HomeHub would still read as something else, and rolls back', () => {
    // A room's name means everything in the room, so teaching it for one device wouldn't take.
    const miss = voiceMiss("Turn on Brenden's room.");
    assert.throws(() => teachMod.teach({ source: 'voice', id: miss, phrase: "Brenden's room", deviceIds: [id('Desk')] }), /still read/);
    assert.deepEqual(nicknames('Desk'), [], 'rolled back');
  });

  it('checks its input', () => {
    const miss = voiceMiss('Turn on the thing.');
    assert.throws(() => teachMod.teach({ source: 'voice', id: miss, phrase: '  ', deviceIds: [id('Desk')] }), /Enter the words/);
    assert.throws(() => teachMod.teach({ source: 'voice', id: miss, phrase: 'thing', deviceIds: [] }), /at least one device/);
    assert.throws(() => teachMod.teach({ source: 'voice', id: miss, phrase: 'thing', sceneId: 999 }), /Choose a scene/);
    assert.throws(() => teachMod.teach({ source: 'voice', id: 12345, phrase: 'thing', deviceIds: [id('Desk')] }), /no longer in the list/);
  });

  describe('Cantonese', () => {
    for (const [text, phrase, kind] of [
      ['開主人房燈', '主人房燈', 'device'],
      ['唔該熄主人房燈啦。', '主人房燈', 'device'],
      ['打開客廳燈', '客廳燈', 'device'],
      ['关主人房灯。', '主人房灯', 'device'],
      ['晚安', '晚安', 'scene'],
      ['晚安呀', '晚安', 'scene'],
    ] as const) {
      it(`suggests "${phrase}" from "${text}"`, () => {
        assert.deepEqual(teachMod.suggestPhrase(text), { phrase, kind });
      });
    }

    it('teaches a Cantonese name, which voice then switches', async () => {
      const miss = voiceMiss('開主人房燈');
      assert.deepEqual(teachMod.listMisses()[0], { source: 'voice', id: miss, text: '開主人房燈', createdAt: teachMod.listMisses()[0].createdAt, phrase: '主人房燈', kind: 'device' });
      const r = teachMod.teach({ source: 'voice', id: miss, phrase: '主人房燈', deviceIds: [id('Brenden bed lamp'), id('Desk')] });
      assert.deepEqual(r.devices, ['Brenden bed lamp', 'Desk']);
      assert.deepEqual(nicknames('Desk'), ['主人房燈']);
      assert.deepEqual(teachMod.listMisses(), []);
      await commands.runPowerCommand('turn on 主人房燈');
      assert.equal(calls.length, 2);
    });

    it('lists a miss once, with or without its full stop', () => {
      voiceMiss('開主人房燈');
      voiceMiss('開主人房燈。');
      assert.equal(teachMod.listMisses().length, 1);
    });
  });

  it('dismisses a miss', () => {
    const miss = voiceMiss('What is the weather.');
    teachMod.dismissMiss('voice', miss);
    assert.deepEqual(teachMod.listMisses(), []);
  });
});
