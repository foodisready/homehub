/**
 * Lights switched at the wall: a timer ends when the light is turned off by
 * hand, and a light HomeHub has on but drawing no power is flagged. Against a
 * temp SQLite DB with stubbed drivers. Modules load in before(), after DB_PATH is set.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-no-power-test-'));
let db: Database.Database;
let cache: typeof import('./device.cache');
let power = true;
let watts: number | null = 0;

describe('lights switched at the wall', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    const { getDriver } = await import('../drivers/registry');
    for (const type of ['shelly', 'kasa']) {
      (getDriver(type) as any).getPower = async () => power;
      (getDriver(type) as any).getEnergy = async () => (watts === null ? null : { wattage: watts, voltage: 124, current: null });
    }
    cache = await import('./device.cache');
    db.prepare("INSERT INTO devices (alias, ip, driver_type, has_emeter) VALUES ('Kitchen ceiling', '10.0.0.201', 'shelly', 1)").run();
    db.prepare("INSERT INTO devices (alias, ip, driver_type, has_emeter) VALUES ('Coffee maker', '10.0.0.50', 'kasa', 1)").run();
    db.prepare("INSERT INTO devices (alias, ip, driver_type, has_emeter) VALUES ('Desk lamp', '10.0.0.51', 'kasa', 1)").run();
    // What they draw when on, from their meters.
    const reading = db.prepare('INSERT INTO energy_readings (device_id, wattage) VALUES (?, ?)');
    for (let i = 0; i < 5; i++) {
      reading.run(id('Kitchen ceiling'), 120);
      reading.run(id('Coffee maker'), 900);
    }
  });

  after(() => {
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    cache.resetNoPower();
    power = true;
    watts = 0;
    db.prepare('UPDATE devices SET timer_off_at = NULL, timer_label = NULL, override_state = NULL, override_until = NULL').run();
  });

  const id = (alias: string) => (db.prepare('SELECT id FROM devices WHERE alias = ?').get(alias) as { id: number }).id;
  const timer = (alias: string) => (db.prepare('SELECT timer_off_at FROM devices WHERE id = ?').get(id(alias)) as { timer_off_at: string | null }).timer_off_at;

  describe('a timer', () => {
    it('ends when the light is turned off at the wall', async () => {
      const light = id('Kitchen ceiling');
      watts = 120;
      cache.noteState(light, true);
      db.prepare("UPDATE devices SET timer_off_at = datetime('now', '+20 minutes') WHERE id = ?").run(light);
      await cache.pollDeviceNow(light);
      assert.ok(timer('Kitchen ceiling'), 'still on: the timer stays');

      power = false;
      await cache.pollDeviceNow(light);
      assert.equal(timer('Kitchen ceiling'), null, 'off at the wall: the timer is done');
    });

    it('is left alone when nothing changed', async () => {
      const light = id('Desk lamp');
      cache.noteState(light, true);
      db.prepare("UPDATE devices SET timer_off_at = datetime('now', '+20 minutes') WHERE id = ?").run(light);
      await cache.pollDeviceNow(light);
      await cache.pollDeviceNow(light);
      assert.ok(timer('Desk lamp'));
    });
  });

  describe('on, but no power', () => {
    const now = Date.parse('2026-11-18T14:47:00Z');
    const usual = (w: number | null) => () => w;
    const ceiling = () => ({ id: id('Kitchen ceiling'), alias: 'Kitchen ceiling', driverType: 'shelly' });

    it('waits a while, since a light just switched on reads 0 W for a moment', () => {
      assert.equal(cache.noPowerNow(ceiling(), true, 0, now, usual(120)), false);
      assert.equal(cache.noPowerNow(ceiling(), true, 0, now + 30_000, usual(120)), false);
      assert.equal(cache.noPowerNow(ceiling(), true, 0, now + cache.NO_POWER_AFTER_MS, usual(120)), true);
    });

    it('clears as soon as it draws power, or is off', () => {
      cache.noPowerNow(ceiling(), true, 0, now, usual(120));
      assert.equal(cache.noPowerNow(ceiling(), true, 0, now + 60_000, usual(120)), true);
      assert.equal(cache.noPowerNow(ceiling(), true, 118, now + 90_000, usual(120)), false);
      assert.equal(cache.noPowerNow(ceiling(), true, 0, now + 120_000, usual(120)), false, 'starts waiting again');
      assert.equal(cache.noPowerNow(ceiling(), false, 0, now + 300_000, usual(120)), false);
    });

    it('is only for lights: an appliance idling at 0 W is normal', () => {
      const coffee = { id: id('Coffee maker'), alias: 'Coffee maker', driverType: 'kasa' };
      cache.noPowerNow(coffee, true, 0, now, usual(900));
      assert.equal(cache.noPowerNow(coffee, true, 0, now + 60_000, usual(900)), false);
      assert.equal(cache.isLightLike('Kitchen ceiling', 'shelly'), true, 'a wall-switch relay is a light circuit');
      assert.equal(cache.isLightLike('Desk lamp', 'kasa'), true);
      assert.equal(cache.isLightLike('Plug 2', 'kasa', ['porch lights']), true, 'by a nickname too');
      assert.equal(cache.isLightLike('Fan', 'kasa'), false);
    });

    it('needs to know what the light normally draws', () => {
      cache.noPowerNow(ceiling(), true, 0, now, usual(null));
      assert.equal(cache.noPowerNow(ceiling(), true, 0, now + 60_000, usual(null)), false, 'never measured');
      cache.noPowerNow(ceiling(), true, 0, now, usual(2));
      assert.equal(cache.noPowerNow(ceiling(), true, 0, now + 60_000, usual(2)), false, 'too small to tell');
    });

    it('shows on the device after a check, and clears when the light draws again', async () => {
      const light = id('Kitchen ceiling');
      cache.noteState(light, true);
      // This morning's kitchen: the Shelly's relay on, 0 W, for over a minute.
      cache.noPowerNow({ id: light, alias: 'Kitchen ceiling', driverType: 'shelly' }, true, 0, Date.now() - 60_000);
      await cache.pollDeviceNow(light);
      assert.equal(cache.getCachedState(light)?.noPower, true);

      watts = 120;
      await cache.pollDeviceNow(light);
      assert.equal(!!cache.getCachedState(light)?.noPower, false);
    });

    it('starts again when HomeHub switches the light', async () => {
      const light = id('Kitchen ceiling');
      cache.noPowerNow({ id: light, alias: 'Kitchen ceiling', driverType: 'shelly' }, true, 0, Date.now() - 60_000);
      cache.noteState(light, true);
      await cache.pollDeviceNow(light);
      assert.equal(!!cache.getCachedState(light)?.noPower, false, 'just switched: give it a moment');
    });
  });
});
