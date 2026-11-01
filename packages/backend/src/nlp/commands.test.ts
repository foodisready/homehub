/**
 * Runs chat commands against a real SQLite DB with a stubbed driver.
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

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-commands-test-'));

let db: Database.Database;
let commands: typeof import('./commands');

const calls: { ip: string; state: boolean }[] = [];
let failing = false;

describe('chat commands', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP_BASE, 'db.sqlite');
    const { getDb } = await import('../db');
    const { getDriver } = await import('../drivers/registry');
    commands = await import('./commands');
    db = getDb();

    getDriver('kasa').setPower = async (ip: string, state: boolean) => {
      if (failing) throw new Error('unreachable');
      calls.push({ ip, state });
    };

    const add = db.prepare('INSERT INTO devices (alias, ip) VALUES (?, ?)');
    ['My office lamp', 'Long Lamp', 'Media long lamp', 'Main Valve', 'Kitchen lights']
      .forEach((alias, i) => add.run(alias, `10.0.0.${i + 1}`));
  });

  after(() => {
    db.close();
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  });

  beforeEach(() => {
    db.prepare('UPDATE devices SET override_state = NULL, override_until = NULL, timer_off_at = NULL').run();
    calls.length = 0;
    failing = false;
  });

  describe('parsePowerCommand', () => {
    const parses: [string, { name: string; state: boolean; minutes?: number }][] = [
      ['turn on my office lamp',                { name: 'my office lamp', state: true }],
      ['Turn off the kitchen lights.',          { name: 'the kitchen lights', state: false }],
      ['switch the long lamp on',               { name: 'the long lamp', state: true }],
      ['please turn off office lamp',           { name: 'office lamp', state: false }],
      ['Could you turn on the lamp please?',    { name: 'the lamp', state: true }],
      ['hey homehub, turn on the lamp',         { name: 'the lamp', state: true }],
      ['turn on my office lamp for an hour',    { name: 'my office lamp', state: true, minutes: 60 }],
      ['turn on my office lamp and leave it on for an hour', { name: 'my office lamp', state: true, minutes: 60 }],
      ['turn on the lamp and keep it on for 45 minutes',     { name: 'the lamp', state: true, minutes: 45 }],
      ['turn the lamp on for 90 min',           { name: 'the lamp', state: true, minutes: 90 }],
      ['keep the lamp on for two hours',        { name: 'the lamp', state: true, minutes: 120 }],
      ['leave the lamp on for half an hour',    { name: 'the lamp', state: true, minutes: 30 }],
    ];

    for (const [text, expected] of parses) {
      it(`reads "${text}"`, () => {
        assert.deepEqual(commands.parsePowerCommand(text), expected);
      });
    }

    const passedToModel = [
      'what is on right now?',
      'is my office lamp on',
      'turn on the lamp at 7pm',
      'turn off the lamp for an hour',
      'turn on the lamp for a while',
      'turn on the lamp for 3 days',
      'keep the lamp on',
      'keep the lamp off for an hour',
      'turn on',
    ];

    for (const text of passedToModel) {
      it(`leaves "${text}" for the model`, async () => {
        const parsed = commands.parsePowerCommand(text);
        if (parsed) {
          assert.equal(await commands.runPowerCommand(text), null);
        }
      });
    }
  });

  describe('parseDuration', () => {
    const durations: [string, number | null][] = [
      ['an hour', 60],
      ['1 hour', 60],
      ['1h', 60],
      ['2 hrs', 120],
      ['half an hour', 30],
      ['an hour and a half', 90],
      ['one and a half hours', 90],
      ['1.5 hours', 90],
      ['2 hours and 30 minutes', 150],
      ['forty five minutes', 45],
      ['10 mins', 10],
      ['30m', 30],
      ['a while', null],
      ['ten seconds', null],
    ];

    for (const [text, minutes] of durations) {
      it(`reads "${text}"`, () => {
        assert.equal(commands.parseDuration(text), minutes);
      });
    }
  });

  it('formats durations for replies', () => {
    assert.equal(commands.formatDuration(1), '1 minute');
    assert.equal(commands.formatDuration(45), '45 minutes');
    assert.equal(commands.formatDuration(60), '1 hour');
    assert.equal(commands.formatDuration(150), '2 hours 30 minutes');
  });

  describe('runPowerCommand', () => {
    it('turns a device on with a timer and no model', async () => {
      const result = await commands.runPowerCommand('turn on my office lamp and leave it on for an hour');

      assert.equal(result?.response, 'Turned on My office lamp for 1 hour.');
      assert.deepEqual(calls, [{ ip: '10.0.0.1', state: true }]);
      const row = db.prepare("SELECT timer_off_at FROM devices WHERE alias = 'My office lamp'").get() as any;
      assert.ok(row.timer_off_at);
    });

    it('asks which device when a name is unclear, and switches nothing', async () => {
      const result = await commands.runPowerCommand('turn on the lamp');

      assert.match(result!.response, /Which one/);
      assert.match(result!.response, /My office lamp/);
      assert.match(result!.response, /Media long lamp/);
      assert.deepEqual(calls, []);
    });

    it('leaves an unknown name for the model', async () => {
      assert.equal(await commands.runPowerCommand('turn off the garage door'), null);
      assert.deepEqual(calls, []);
    });

    it('does not read "it" as a device', async () => {
      assert.equal(await commands.runPowerCommand('turn it off'), null);
      assert.deepEqual(calls, []);
    });

    it('never switches the water valve', async () => {
      for (const text of ['turn off main valve', 'turn on the valve for an hour', 'turn off main']) {
        const result = await commands.runPowerCommand(text);
        assert.match(result!.response, /won't switch it/);
      }
      assert.deepEqual(calls, []);
    });

    it('reports an unreachable device and stores no timer', async () => {
      failing = true;

      const result = await commands.runPowerCommand('turn on the kitchen lights for 10 minutes');

      assert.equal(result?.response, "I couldn't reach Kitchen lights.");
      const row = db.prepare("SELECT timer_off_at FROM devices WHERE alias = 'Kitchen lights'").get() as any;
      assert.equal(row.timer_off_at, null);
    });
  });
});
