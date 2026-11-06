/**
 * "Which devices are on?" answered from HomeHub's own states, against a temp
 * DB and set states. Modules load in before(), after DB_PATH is set.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-status-test-'));

let db: Database.Database;
let status: typeof import('./status');

describe('what is on', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    status = await import('./status');
    const cache = (await import('../kasa/device.cache')).getAllCachedStates();
    const add = (alias: string, state: boolean | 'offline', extra: { room?: string; driver?: string; nicknames?: string[] } = {}) => {
      const id = Number(db.prepare('INSERT INTO devices (alias, ip, room, driver_type, nicknames) VALUES (?, ?, ?, ?, ?)')
        .run(alias, `10.0.0.${Math.random()}`, extra.room ?? null, extra.driver ?? 'kasa', JSON.stringify(extra.nicknames ?? [])).lastInsertRowid);
      cache.set(id, { state: state === true, online: state !== 'offline', wattage: null, lastPolled: new Date() } as never);
    };
    add("Brenden's left bedside lamp", true, { room: "Brenden's room" });
    add("Brenden's right bedside lamp", true, { room: "Brenden's room" });
    add("Ethan's bedside lamp", false, { room: "Ethan's room" });
    add("Ethan's desk lamp", false, { room: "Ethan's room" });
    add('Kitchen lights', false, { nicknames: ['廚房燈'] });
    add('Air purifier', true);
    add('Hallway lamp', 'offline');
    add('Front Door', true, { driver: 'wyze' });   // a camera
  });

  after(() => {
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  const ask = (q: string) => status.answerStatusQuestion(q)?.response ?? null;

  it('lists exactly the devices that are on', () => {
    const answer = "On now: Air purifier, Brenden's left bedside lamp and Brenden's right bedside lamp. Offline, so not known: Hallway lamp.";
    for (const q of ['Which devices are on right now?', "What's on?", 'what is on', 'Is anything on?', 'Which devices are currently on?']) {
      assert.equal(ask(q), answer, q);
    }
    assert.doesNotMatch(ask('Which devices are on?')!, /Ethan|Front Door/);
  });

  it('lists lights only, leaving out a purifier', () => {
    assert.equal(ask('Which lights are on?'), "On now: Brenden's left bedside lamp and Brenden's right bedside lamp. Offline, so not known: Hallway lamp.");
    assert.match(ask('Are any lights on?')!, /^On now: Brenden/);
  });

  it('lists what is off', () => {
    assert.equal(ask('What lights are off?'), "Off now: Ethan's bedside lamp, Ethan's desk lamp and Kitchen lights. Offline, so not known: Hallway lamp.");
  });

  it('answers about one device or a room', () => {
    assert.equal(ask('Is the kitchen light on?'), 'Kitchen lights is off.');
    assert.equal(ask("Is Ethan's desk lamp on?"), "Ethan's desk lamp is off.");
    assert.equal(ask('Is the hallway lamp on?'), 'Hallway lamp is offline, so its state isn\'t known.');
    assert.equal(ask("Are Brenden's room lights on?"), "On: Brenden's left bedside lamp and Brenden's right bedside lamp.");
  });

  it('leaves other messages alone', () => {
    for (const q of ['Turn on the kitchen lights', 'Is it going to rain?', 'What is the energy use today?', 'Is the zebra lamp on?', 'Which devices use the most energy?']) {
      assert.equal(status.answerStatusQuestion(q), null, q);
    }
  });

  it('shows the list it used, like the model would', () => {
    const r = status.answerStatusQuestion("What's on?")!;
    assert.equal(r.actions[0].tool, 'list_devices');
  });
});
