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
      ['turn of office lights',                 { name: 'office lights', state: false }],
      ['switch the lamp of',                    { name: 'the lamp', state: false }],
      ['turn office lights off',                { name: 'office lights', state: false }],
      // The voice bridge sends Vietnamese nicknames as they're written.
      ['turn on đèn bếp for 10 minutes',        { name: 'đèn bếp', state: true, minutes: 10 }],
      ['turn off cửa ga-ra',                    { name: 'cửa ga-ra', state: false }],
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

    describe('scenes', () => {
      let sceneId: number;
      const addAction = (alias: string, state: number) => db.prepare(
        'INSERT INTO scene_actions (scene_id, device_id, state) SELECT ?, id, ? FROM devices WHERE alias = ?',
      ).run(sceneId, state, alias);

      beforeEach(() => {
        db.prepare('DELETE FROM scenes').run();
        sceneId = Number(db.prepare("INSERT INTO scenes (name) VALUES ('Goodnight')").run().lastInsertRowid);
        addAction('My office lamp', 0);
        addAction('Media long lamp', 1);
      });
      after(() => { db.prepare('DELETE FROM scenes').run(); });

      for (const text of [
        'run goodnight', 'goodnight', 'good night', 'Goodnight.', 'start the goodnight scene',
        'activate scene goodnight', 'turn on goodnight',
      ]) {
        it(`runs a scene from "${text}"`, async () => {
          const result = await commands.runPowerCommand(text);

          assert.equal(result?.response, 'Ran Goodnight.');
          assert.deepEqual(new Set(calls.map((call) => `${call.ip}=${call.state}`)),
            new Set(['10.0.0.1=false', '10.0.0.3=true']));
        });
      }

      it('needs the whole scene name', async () => {
        assert.equal(await commands.runPowerCommand('run good'), null);
        assert.deepEqual(calls, []);
      });

      it('does not turn "turn off" into running a scene', async () => {
        assert.equal(await commands.runPowerCommand('turn off goodnight'), null);
        assert.deepEqual(calls, []);
      });

      it('skips a protected device', async () => {
        addAction('Main Valve', 0);
        const result = await commands.runPowerCommand('run goodnight');

        assert.equal(calls.length, 2);
        assert.equal(result?.response, 'Ran part of Goodnight. Main Valve is protected, so I left it alone.');
      });

      it('reports a device it could not reach', async () => {
        failing = true;
        const result = await commands.runPowerCommand('run goodnight');
        assert.match(result!.response, /^Ran part of Goodnight\. I couldn't reach/);
      });

      it('says when a scene has no devices', async () => {
        db.prepare('DELETE FROM scene_actions').run();
        const result = await commands.runPowerCommand('run goodnight');
        assert.equal(result?.response, 'Goodnight has no devices in it.');
      });
    });

    describe('rooms', () => {
      beforeEach(() => {
        db.prepare("UPDATE devices SET room = 'Living room' WHERE alias IN ('My office lamp', 'Media long lamp', 'Main Valve')").run();
      });
      after(() => { db.prepare('UPDATE devices SET room = NULL').run(); });

      it('switches everything in a room except protected devices', async () => {
        const result = await commands.runPowerCommand('turn off the living room');

        assert.equal(calls.length, 2);
        assert.match(result!.response, /Main Valve is protected/);
      });

      it('lists room names for speech recognition', async () => {
        const { listDeviceNames } = await import('./find-device');
        assert.ok(listDeviceNames().includes('Living room'));
      });

      it('prefers a device with that exact name', async () => {
        db.prepare("UPDATE devices SET room = 'Kitchen lights' WHERE alias = 'Long Lamp'").run();
        await commands.runPowerCommand('turn off the kitchen lights');
        assert.deepEqual(calls, [{ ip: '10.0.0.5', state: false }]);
      });
    });

    describe("a room's lights", () => {
      beforeEach(() => {
        db.prepare("UPDATE devices SET room = 'Brenden''s room' WHERE alias IN ('My office lamp', 'Media long lamp', 'Main Valve')").run();
      });
      after(() => { db.prepare('UPDATE devices SET room = NULL').run(); });
      const switched = () => calls.map((c) => `${c.ip}=${c.state}`).sort();

      for (const text of ["turn on brenden's lights", "turn on Brenden's light", "turn on brenden's room lamps", 'turn on the brenden room lights']) {
        it(`switches the lamps in the room for "${text}"`, async () => {
          const result = await commands.runPowerCommand(text);
          assert.deepEqual(switched(), ['10.0.0.1=true', '10.0.0.3=true'], 'the valve, not a light, stays out');
          assert.match(result!.response, /^Turned on /);
        });
      }

      it('lets a name that fits one device win', async () => {
        db.prepare("UPDATE devices SET room = 'Office' WHERE alias IN ('My office lamp', 'Media long lamp')").run();
        await commands.runPowerCommand('turn off my office light');
        assert.deepEqual(switched(), ['10.0.0.1=false'], 'My office lamp only, not every lamp in the Office');
      });

      it('includes lights not named lamp or light, but not fans or protected devices', async () => {
        db.prepare("UPDATE devices SET room = 'Brenden''s room', alias = 'Ceiling' WHERE alias = 'Long Lamp'").run();
        db.prepare("UPDATE devices SET room = 'Brenden''s room', alias = 'Brenden fan' WHERE alias = 'Kitchen lights'").run();
        try {
          await commands.runPowerCommand("turn on brenden's lights");
          assert.deepEqual(switched(), ['10.0.0.1=true', '10.0.0.2=true', '10.0.0.3=true']);
        } finally {
          db.prepare("UPDATE devices SET alias = 'Long Lamp', room = NULL WHERE alias = 'Ceiling'").run();
          db.prepare("UPDATE devices SET alias = 'Kitchen lights', room = NULL WHERE alias = 'Brenden fan'").run();
        }
      });

      it('finds nothing when the room has only protected devices', async () => {
        db.prepare("UPDATE devices SET room = 'Garage' WHERE alias = 'Main Valve'").run();
        assert.equal(await commands.runPowerCommand('turn on the garage lights'), null);
        assert.deepEqual(calls, []);
      });

      it("doesn't take a room for a name without lights or lamps", async () => {
        assert.equal(await commands.runPowerCommand("turn on brenden's"), null);
        assert.deepEqual(calls, []);
      });
    });

    describe('devices sharing a nickname', () => {
      const setNicknames = (alias: string, nicknames: string[]) =>
        db.prepare('UPDATE devices SET nicknames = ? WHERE alias = ?').run(JSON.stringify(nicknames), alias);

      beforeEach(() => {
        setNicknames('My office lamp', ['upstairs lights']);
        setNicknames('Media long lamp', ['upstairs lights']);
      });
      after(() => {
        db.prepare("UPDATE devices SET nicknames = NULL WHERE alias IN ('My office lamp', 'Media long lamp', 'Main Valve')").run();
      });

      it('switches all of them', async () => {
        const result = await commands.runPowerCommand('turn off the upstairs lights');

        assert.equal(result?.actions.length, 2);
        assert.match(result!.response, /^Turned off .+ and .+\.$/);
        assert.equal(calls.length, 2);
        assert.ok(calls.every((call) => call.state === false));
      });

      it('accepts the singular form of the nickname', async () => {
        await commands.runPowerCommand('turn on upstairs light');
        assert.equal(calls.length, 2);
      });

      it('applies a timer to each device', async () => {
        const result = await commands.runPowerCommand('turn on the upstairs lights for an hour');
        assert.match(result!.response, /for 1 hour\.$/);
        const rows = db.prepare("SELECT timer_off_at FROM devices WHERE nicknames LIKE '%upstairs%'").all() as any[];
        assert.ok(rows.every((row) => row.timer_off_at));
      });

      it('still asks when only part of the nickname is given', async () => {
        const result = await commands.runPowerCommand('turn on the lamp');
        assert.match(result!.response, /Which one/);
        assert.deepEqual(calls, []);
      });

      it('never switches a protected device in the group', async () => {
        setNicknames('Main Valve', ['upstairs lights']);
        const result = await commands.runPowerCommand('turn off the upstairs lights');

        assert.equal(calls.length, 2);
        assert.match(result!.response, /Main Valve is protected/);
        setNicknames('Main Valve', []);
      });

      it('reports the device it could not reach', async () => {
        failing = true;
        const result = await commands.runPowerCommand('turn off the upstairs lights');
        assert.match(result!.response, /I couldn't reach/);
      });

      it('asks rather than grouping when the name is also a real device name', async () => {
        setNicknames('Media long lamp', ['my office lamp']);
        setNicknames('Long Lamp', ['my office lamp']);
        const result = await commands.runPowerCommand('turn off my office lamp');

        assert.match(result!.response, /Which one/);
        assert.deepEqual(calls, []);
        setNicknames('Long Lamp', []);
      });

      it('does not treat a single nickname as a group', async () => {
        setNicknames('Media long lamp', []);
        const result = await commands.runPowerCommand('turn off upstairs lights');
        assert.equal(result?.response, 'Turned off My office lamp.');
      });
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
