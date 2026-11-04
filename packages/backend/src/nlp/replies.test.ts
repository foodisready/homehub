/**
 * Voice and Chat replies, against a temp SQLite DB.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-replies-test-'));

let db: Database.Database;
let replies: typeof import('./replies');
let commands: typeof import('./commands');

describe('voice replies', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    replies = await import('./replies');
    commands = await import('./commands');
    const { getDriver } = await import('../drivers/registry');
    for (const type of ['kasa', 'wyze']) getDriver(type).setPower = async () => undefined;
  });

  after(() => {
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.pragma('foreign_keys = OFF');
    for (const t of ['devices', 'scenes', 'scene_actions', 'settings', 'sensors']) db.prepare(`DELETE FROM ${t}`).run();
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO devices (alias, ip, room) VALUES ('office lamp', '10.0.0.3', 'Office')").run();
    db.prepare("INSERT INTO devices (alias, ip, room, driver_type) VALUES ('Front cam', '10.0.0.5', NULL, 'wyze')").run();
  });

  it('says what it always said until an admin chooses otherwise', async () => {
    assert.equal((await commands.runPowerCommand('turn on office lamp'))!.response, 'Turned on office lamp.');
    assert.equal((await commands.runPowerCommand('turn on office lamp for 20 minutes'))!.response, 'Turned on office lamp for 20 minutes.');
    assert.equal(replies.reply('not_understood', {}), "Sorry, I didn't understand that.");
  });

  it('uses a chosen line, filled in and capitalised', async () => {
    replies.saveReplyChoices({ on: { builtIn: [], custom: ["{device} is on. You're welcome."] } });
    assert.equal((await commands.runPowerCommand('turn on office lamp'))!.response, "Office lamp is on. You're welcome.");
    // Moments left alone keep the plain line.
    assert.equal((await commands.runPowerCommand('turn off office lamp'))!.response, 'Turned off office lamp.');
  });

  it('picks among the chosen lines at random', () => {
    replies.saveReplyChoices({ off: { builtIn: ['off-plain', 'off-funny-2'], custom: [] } });
    assert.equal(replies.reply('off', { device: 'Desk' }, { random: () => 0 }), 'Turned off Desk.');
    assert.equal(replies.reply('off', { device: 'Desk' }, { random: () => 0.99 }), 'Desk is off. It needed its beauty sleep.');
  });

  it('keeps protected devices plain, whatever was chosen', async () => {
    replies.saveReplyChoices({ on: { builtIn: ['on-funny-2'], custom: [] } });
    assert.equal((await commands.runPowerCommand('turn on front cam'))!.response, 'Turned on Front cam.');
  });

  it('refuses a reply that would hide what changed', () => {
    assert.throws(() => replies.saveReplyChoices({ on: { builtIn: [], custom: ['Done!'] } }), /Include \{device\}/);
    assert.throws(() => replies.saveReplyChoices({ scene: { builtIn: [], custom: ['{device} done'] } }), /\{device\} isn't available/);
    assert.throws(() => replies.saveReplyChoices({ on: { builtIn: ['off-plain'], custom: [] } }), /Unknown reply/);
    assert.throws(() => replies.saveReplyChoices({ on: { builtIn: [], custom: ['{device} ' + 'x'.repeat(200)] } }), /under 160/);
    assert.equal(replies.getReplyChoices().on.builtIn[0], 'on-plain', 'nothing was saved');
  });

  it('lets "didn\'t understand" be anything, and drops repeats', () => {
    const saved = replies.saveReplyChoices({ not_understood: { builtIn: [], custom: ['Huh?', ' Huh? '] } });
    assert.deepEqual(saved.not_understood.custom, ['Huh?']);
    assert.equal(replies.reply('not_understood', {}), 'Huh?');
  });

  it('falls back to the plain line when nothing is chosen', () => {
    replies.saveReplyChoices({ scene: { builtIn: [], custom: [] } });
    assert.equal(replies.reply('scene', { scene: 'Goodnight' }), 'Ran Goodnight.');
  });
});
