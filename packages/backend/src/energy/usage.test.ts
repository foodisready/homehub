/**
 * Energy estimates, against a temp SQLite DB: time on rebuilt from Activity, only while HomeHub
 * ran and the device was online; measured energy; daily summaries; what each device draws;
 * heating and cooling from running hours; prices; and a month against the same days of the last.
 * Times are local, built with new Date(y, m, d, h), so the tests pass in any time zone.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-energy-test-'));

let db: Database.Database;
let u: typeof import('./usage');

const at = (m: number, d: number, h = 0, min = 0) => new Date(2026, m, d, h, min).getTime();
const iso = (t: number) => new Date(t).toISOString();
const sqlTime = (t: number) => iso(t).slice(0, 19).replace('T', ' ');
let next = 100;
const device = (alias: string, extra: Record<string, unknown> = {}) => {
  const id = next++;
  const row = { driver_type: 'kasa', has_emeter: 0, nicknames: null, driver_config: null, watts: null, ...extra };
  db.prepare('INSERT INTO devices (id, alias, ip, driver_type, has_emeter, nicknames, driver_config, watts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, alias, `192.0.2.${id}`, row.driver_type, row.has_emeter, row.nicknames, row.driver_config, row.watts);
  return id;
};
const event = (id: number, kind: 'power' | 'online', state: 0 | 1, t: number) =>
  db.prepare("INSERT INTO device_events (device_id, device_alias, kind, state, source, at) VALUES (?, 'x', ?, ?, 'app', ?)").run(id, kind, state, iso(t));
const reading = (id: number, watts: number, t: number) =>
  db.prepare('INSERT INTO energy_readings (device_id, wattage, recorded_at) VALUES (?, ?, ?)').run(id, watts, sqlTime(t));

describe('energy estimates', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    u = await import('./usage');
  });
  after(() => { u.stopEnergy(); db.close(); fs.rmSync(TMP, { recursive: true, force: true }); });
  beforeEach(() => {
    db.exec("DELETE FROM device_events; DELETE FROM energy_readings; DELETE FROM device_energy_days; DELETE FROM homehub_uptime; DELETE FROM thermostat_runs; DELETE FROM thermostats; DELETE FROM devices; DELETE FROM settings WHERE key = 'energy_prices';");
  });

  it('counts time on only while it was on, online, and HomeHub was running', () => {
    const lamp = device('Hall lamp');
    event(lamp, 'power', 1, at(10, 2, 8));
    event(lamp, 'online', 0, at(10, 2, 9));        // offline 9–10: unknown
    event(lamp, 'online', 1, at(10, 2, 10));
    event(lamp, 'power', 0, at(10, 2, 12));
    const s = u.deviceSeconds(lamp, at(10, 2), at(10, 3));
    assert.equal(s.on, 3 * 3600, '8–9 and 10–12');
    assert.equal(s.known, 15 * 3600, 'from its first change at 8, but the hour offline');
    // HomeHub off from 10:30 to 11:00: that half hour isn't counted either.
    db.prepare('INSERT INTO homehub_uptime (started_at, last_seen) VALUES (?, ?), (?, ?)')
      .run(iso(at(10, 1)), iso(at(10, 2, 10, 28)), iso(at(10, 2, 11)), iso(at(10, 3)));
    assert.equal(u.deviceSeconds(lamp, at(10, 2), at(10, 3)).on, 3 * 3600 - 30.5 * 60, 'running until 10:28 + 90 s grace, back at 11');
  });

  it('knows nothing about a device before its first change', () => {
    const lamp = device('Desk lamp');
    event(lamp, 'power', 1, at(10, 2, 20));
    assert.deepEqual(u.deviceSeconds(lamp, at(10, 2), at(10, 3)), { on: 4 * 3600, known: 4 * 3600 });
  });

  it('adds up measured energy, a gap in readings not counted as the last value', () => {
    const plug = device('Kitchen counter lights', { has_emeter: 1, driver_type: 'shelly' });
    for (let t = at(10, 2, 8); t < at(10, 2, 9); t += 30_000) reading(plug, 27.3, t);   // an hour at 27.3 W
    reading(plug, 27.3, at(10, 2, 9));                                                   // then nothing for hours
    reading(plug, 0, at(10, 2, 15));
    const wh = u.measuredWh(plug, at(10, 2), at(10, 3))!;
    assert.ok(Math.abs(wh - (27.3 + 27.3 * 75 / 3600)) < 0.2, `about 27.3 Wh, not 6 h of it: ${wh}`);
    assert.equal(u.measuredWh(plug, at(10, 5), at(10, 6)), null);
  });

  it('works out a finished day that isn’t summarised yet, the same as a kept one', () => {
    const lamp = device('Hall lamp');
    event(lamp, 'power', 1, at(10, 5, 6));
    event(lamp, 'power', 0, at(10, 5, 9));
    const now = at(10, 6, 0, 5);                       // five minutes after midnight: nothing summarised yet
    const before = u.monthUsage('2026-11', now).devices[0].onHours;
    u.rollUp(now);
    assert.deepEqual([before, u.monthUsage('2026-11', now).devices[0].onHours], [3, 3]);
  });

  it('keeps finished days, not today, and redoes the last two', () => {
    const lamp = device('Hall lamp');
    event(lamp, 'power', 1, at(10, 1, 18));
    event(lamp, 'power', 0, at(10, 1, 22));
    event(lamp, 'power', 1, at(10, 3, 7));
    const now = at(10, 4, 12);
    assert.equal(u.rollUp(now), 3, '1, 2 and 3 November; not the 4th');
    const days = db.prepare('SELECT day, on_seconds FROM device_energy_days WHERE device_id = ? ORDER BY day').all(lamp);
    assert.deepEqual(days, [
      { day: '2026-11-01', on_seconds: 4 * 3600 }, { day: '2026-11-02', on_seconds: 0 }, { day: '2026-11-03', on_seconds: 17 * 3600 },
    ]);
    assert.equal(u.rollUp(now), 2, 'again: only the last two finished days');
  });

  it('knows what a device draws: set, measured, typical for its name, or not known', () => {
    const row = (id: number) => db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as never;
    assert.deepEqual(u.wattsFor(row(device('My office lamp'))), { watts: 9, method: 'typical', label: 'an LED lamp', rough: false });
    assert.equal(u.wattsFor(row(device('Woman bedside lamp'))).watts, 9, 'a name ending in "lamp", other words unknown');
    assert.equal(u.wattsFor(row(device("Ethan's bed side lamp"))).watts, 9);
    assert.equal(u.wattsFor(row(device('Living room statue', { nicknames: '["living room lights"]' }))).watts, 9, 'its nickname says');
    assert.deepEqual(u.wattsFor(row(device('Bedroom heater'))), { watts: 1500, method: 'typical', label: 'a space heater', rough: true });
    assert.equal(u.wattsFor(row(device('Woman statue'))).method, 'none', 'nothing says what it is');
    assert.equal(u.wattsFor(row(device('Kitchen lights', { driver_type: 'shelly' }))).method, 'none', 'a wall circuit: a person says');
    assert.deepEqual(u.wattsFor(row(device('Porch', { driver_type: 'shelly', watts: 40 }))), { watts: 40, method: 'set', label: null, rough: false });
    const plug = device('Counter', { has_emeter: 1, driver_type: 'shelly' });
    for (const w of [0, 27.1, 27.3, 27.4, 0]) reading(plug, w, Date.now() - 3_600_000);
    assert.deepEqual(u.wattsFor(row(plug)), { watts: 27.3, method: 'measured', label: null, rough: false });
  });

  it('leaves out cameras, garage doors, valves and thermostats', () => {
    const r = (alias: string, extra: Record<string, unknown> = {}) => u.excludedReason(db.prepare('SELECT * FROM devices WHERE id = ?').get(device(alias, extra)) as never);
    assert.equal(r('Yoda Cam', { driver_type: 'wyze' }), 'camera');
    assert.equal(r('Garage Left', { driver_type: 'meross' }), 'garage door');
    assert.equal(r('Main Valve', { driver_type: 'tuya' }), 'valve');
    assert.equal(r('Hall thermostat', { driver_type: 'matter', driver_config: '{"kind":"thermostat"}' }), 'thermostat');
    assert.equal(r('Hall lamp'), null);
  });

  it('turns heating and cooling hours into energy by the system', () => {
    assert.deepEqual(u.perHour('heating', { heat: 'gas', heatSize: null, cool: null, coolSize: null }), { kwh: 0.5, therms: 0.6 });
    assert.ok(Math.abs(u.perHour('heating', { heat: 'heat_pump', heatSize: 3, cool: null, coolSize: null })!.kwh - 3.517) < 0.01);
    assert.ok(Math.abs(u.perHour('cooling', { heat: null, heatSize: null, cool: 'ac', coolSize: 3 })!.kwh - 3.273) < 0.01);
    assert.equal(u.perHour('heating', { heat: null, heatSize: null, cool: 'ac', coolSize: 3 }), null);
    assert.throws(() => u.saveHvacSystem(1, { heat: 'coal' }), /heat must be/);
  });

  it('sums a month, counts what it can, and says what it can’t', () => {
    const lamp = device('Hall lamp');
    const statue = device('Woman statue');
    const t = device('Hall thermostat', { driver_type: 'matter', driver_config: '{"kind":"thermostat"}' });
    // Away from the clock change on 1 November.
    event(lamp, 'power', 1, at(10, 5, 0));
    event(lamp, 'power', 0, at(10, 5, 10));            // 10 h × 9 W = 0.09 kWh
    event(statue, 'power', 1, at(10, 5, 0));
    event(statue, 'power', 0, at(10, 5, 5));           // 5 h, no wattage
    db.prepare("INSERT INTO thermostat_runs (device_id, kind, started_at, ended_at) VALUES (?, 'heating', ?, ?)").run(t, iso(at(10, 6, 6)), iso(at(10, 6, 8)));
    const now = at(10, 7, 12);
    let m = u.monthUsage('2026-11', now);
    assert.equal(m.totals.kwh, 0.09);
    assert.equal(m.totals.cost, null, 'no price yet');
    assert.equal(m.totals.notCounted, 2, 'the statue, and heating with no system');
    assert.deepEqual(m.hvac.map((h) => [h.kind, h.hours, h.kwh]), [['heating', 2, null]]);
    assert.deepEqual(m.excluded, [], 'the thermostat is under heating and cooling, not left out');

    u.saveHvacSystem(t, { heat: 'gas', heatSize: 80_000 });
    u.savePrices({ electricity: 0.3, gas: 1.5 });
    m = u.monthUsage('2026-11', now);
    assert.deepEqual(m.hvac.map((h) => [h.hours, h.kwh, h.therms, h.cost]), [[2, 1, 1.6, 2.7]], '2 h: 1 kWh of fan, 1.6 therms');
    assert.equal(m.totals.kwh, 1.09);
    assert.equal(m.totals.cost, Math.round((1.09 * 0.3 + 1.6 * 1.5) * 100) / 100);
    u.savePrices({ electricity: 0.3, gas: null });
    m = u.monthUsage('2026-11', now);
    assert.deepEqual([m.totals.electricityCost, m.totals.gasCost, m.totals.cost], [0.33, null, null], 'no gas price: electricity still told');
    assert.equal(m.totals.notCounted, 1, 'only the statue now');
    assert.equal(m.devices[0].alias, 'Hall lamp', 'biggest first');
  });

  it('zones on one unit: their running time counts once, at the unit’s size', () => {
    const cfg = { driver_type: 'honeywell', driver_config: '{"kind":"thermostat"}' };
    const kitchen = device('Kitchen Thermostat', cfg);
    const bedroom = device('M. Bedroom Thermostat', cfg);
    const upstairs = device('2nd Floor Thermostat', cfg);
    const run = (id: number, kind: string, from: number, to: number) =>
      db.prepare('INSERT INTO thermostat_runs (device_id, kind, started_at, ended_at) VALUES (?, ?, ?, ?)').run(id, kind, iso(from), iso(to));
    // Kitchen heats 6:00–8:00 and bedroom 7:00–9:00: the unit ran 6:00–9:00, 3 h, not 4.
    run(kitchen, 'heating', at(10, 6, 6), at(10, 6, 8));
    run(bedroom, 'heating', at(10, 6, 7), at(10, 6, 9));
    // Bedroom alone later: 1 h more.
    run(bedroom, 'heating', at(10, 6, 12), at(10, 6, 13));
    run(upstairs, 'heating', at(10, 6, 6), at(10, 6, 8));
    u.saveHvacSystem(kitchen, { heat: 'gas', heatSize: 100_000 });
    u.saveHvacSystem(upstairs, { heat: 'gas', heatSize: 60_000 });
    const shared = u.saveHvacSystem(bedroom, { sharesWith: kitchen, heat: 'electric', heatSize: 5 });
    assert.deepEqual(shared, { heat: 'gas', heatSize: 100_000, cool: null, coolSize: null, sharesWith: { id: kitchen, alias: 'Kitchen Thermostat' } },
      'it reads as the unit’s system; what else was sent is ignored');

    const now = at(10, 7, 12);
    const m = u.monthUsage('2026-11', now);
    assert.deepEqual(m.hvac.map((h) => [h.alias, h.hours, h.therms]), [
      ['2nd Floor Thermostat', 2, 1.2],
      ['Kitchen Thermostat + M. Bedroom Thermostat', 4, 4],
    ]);

    // Sharing the bedroom's: that's the kitchen's unit, never a chain. And not itself.
    assert.equal(u.saveHvacSystem(upstairs, { sharesWith: bedroom }).sharesWith?.id, kitchen);
    assert.throws(() => u.saveHvacSystem(kitchen, { sharesWith: bedroom }), /can’t share its own system/);
    // Upstairs gets its own unit back.
    assert.equal(u.saveHvacSystem(upstairs, { heat: 'gas', heatSize: 60_000 }).sharesWith, null);

    // The unit's thermostat deleted: the others are on their own again.
    db.prepare('DELETE FROM devices WHERE id = ?').run(kitchen);
    assert.equal(u.hvacSystem(bedroom).sharesWith, null);
    assert.equal(u.monthUsage('2026-11', now).hvac.find((h) => h.alias === 'M. Bedroom Thermostat')?.hours, 3);
  });

  it('compares a month so far with the same days of the last, only with history for all of them', () => {
    const lamp = device('Hall lamp');
    event(lamp, 'power', 1, at(10, 3, 0));              // history starts 3 November
    event(lamp, 'power', 0, at(10, 3, 2));
    let m = u.monthUsage('2026-11', at(10, 10, 12));
    assert.equal(m.previousSameDays, null, 'October has no history: no comparison with nothing');
    assert.equal(Date.parse(m.recordedFrom!), at(10, 3), 'November is counted from the 3rd');
    // Same lamp, a month later: December so far against November's first 7.5 days.
    event(lamp, 'power', 1, at(11, 2, 0));
    event(lamp, 'power', 0, at(11, 2, 4));
    m = u.monthUsage('2026-12', at(11, 8, 12));
    assert.equal(m.previousSameDays, null, 'November itself was only recorded from the 3rd');
    m = u.monthUsage('2027-01', at(12 + 0, 5, 12));
    assert.equal(m.previousSameDays?.month, '2026-12');
    assert.equal(m.previousSameDays?.previous.kwh, Math.round(4 * 9 / 1000 * 100) / 100, 'December’s first 4.5 days: the 4 h on the 2nd');
    assert.equal(m.previousSameDays?.devices, 1);
  });

  it('leaves a device out of the comparison if HomeHub didn’t record it through both spans', () => {
    // The household's case: a thermostat with a year of history, lamps only since this month.
    const old = device('Old lamp');
    const fresh = device('New lamp');
    event(old, 'power', 1, at(9, 1, 0));
    event(old, 'power', 0, at(9, 1, 1));
    event(old, 'power', 1, at(10, 5, 0));
    event(old, 'power', 0, at(10, 5, 1));
    event(fresh, 'power', 1, at(10, 5, 0));               // first seen in November
    event(fresh, 'power', 0, at(10, 5, 10));
    const m = u.monthUsage('2026-11', at(10, 10, 12));
    assert.equal(m.previousSameDays?.devices, 1, 'only the old lamp');
    assert.equal(m.previousSameDays?.current.kwh, 0.01, 'its hour in November, not the new lamp’s ten');
    assert.equal(m.totals.kwh, 0.1, 'the month itself counts both');
  });

  it('checks prices and wattages', () => {
    assert.throws(() => u.savePrices({ electricity: -1 }), /electricity price/);
    assert.throws(() => u.savePrices({ electricity: 0.3, currency: 'dollars' }), /three-letter/);
    assert.deepEqual(u.savePrices({ electricity: 0.32, gas: '' }), { electricity: 0.32, gas: null, currency: 'USD' });
    assert.throws(() => u.setWatts(1, 9000), /watts/);
  });

  it('keeps HomeHub’s running time with a heartbeat', () => {
    u.startUptime(at(10, 5, 9));
    const rows = db.prepare('SELECT started_at FROM homehub_uptime').all() as { started_at: string }[];
    assert.equal(rows.length, 1);
    u.stopUptime();
    assert.deepEqual(u.upIntervals(at(10, 5, 8), at(10, 5, 10)), [[at(10, 5, 8), at(10, 5, 9)], [at(10, 5, 9), at(10, 5, 9) + 90_000]],
      'before it kept track counts as running; then running until 90 s after its last heartbeat');
  });
});
