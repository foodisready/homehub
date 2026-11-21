/**
 * Honeywell Total Connect Comfort thermostats, against a temp SQLite DB and a fake portal
 * that behaves like the real one: a wrong password gets the sign-in page with
 * "The email or password provided is incorrect." and emptied cookies; a signed-out
 * request gets 401.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

process.env.TEMPERATURE_UNIT = 'F';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-honeywell-test-'));
process.env.DB_PATH = path.join(TMP, 'db.sqlite');

let db: Database.Database;
let h: typeof import('./honeywell');
let tcc: typeof import('./tcc');
let t: typeof import('../thermostat/thermostat');

const EMAIL = 'owner@example.com';
const GOOD = 'right-password';

/** A Prestige-like thermostat in °F, as CheckDataSession's uiData gives it. */
const ui = (over: Record<string, unknown> = {}) => ({
  DispTemperature: 69, HeatSetpoint: 68, CoolSetpoint: 76, SystemSwitchPosition: 1,
  SwitchHeatAllowed: true, SwitchCoolAllowed: true, SwitchAutoAllowed: true, SwitchOffAllowed: true, SwitchEmergencyHeatAllowed: false,
  HeatLowerSetptLimit: 40, HeatUpperSetptLimit: 90, CoolLowerSetptLimit: 50, CoolUpperSetptLimit: 99,
  Deadband: 3, StatusHeat: 0, StatusCool: 0, HeatNextPeriod: 68, CoolNextPeriod: 68, DisplayUnits: 'F',
  EquipmentOutputStatus: 1, ...over,
});

/** The fake portal: its thermostats, what it was sent, and how many times someone signed in. */
function portal() {
  const state = {
    signIns: 0,
    password: GOOD,
    /** The next data request finds the session ended. */
    expireNext: false,
    live: true,
    devices: new Map<number, Record<string, unknown>>([[101, ui()], [102, ui({ DispTemperature: 64, HeatSetpoint: 62, EquipmentOutputStatus: 0 })]]),
    changes: [] as Record<string, unknown>[],
    cookie: '',
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
  const f = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const headers = new Headers(init?.headers);
    if (u.pathname === '/portal' && init?.method === 'POST') {
      state.signIns++;
      const form = new URLSearchParams(String(init.body));
      if (form.get('UserName') === EMAIL && form.get('Password') === state.password) {
        state.cookie = `session${state.signIns}`;
        return new Response('', { status: 302, headers: [['location', '/portal/'], ['set-cookie', `.ASPXAUTH_TRUEHOME=${state.cookie}; path=/; secure; HttpOnly`]] });
      }
      return new Response('<form><input name="UserName"/><input name="Password"/><div class="validation-summary-errors"><ul><li>The email or password provided is incorrect.</li></ul></div></form>', {
        status: 200, headers: [['content-type', 'text/html'], ['set-cookie', '.ASPXAUTH_TRUEHOME=; expires=Tue, 12-Oct-1999 00:00:00 GMT; path=/']],
      });
    }
    const signedIn = state.cookie && (headers.get('cookie') ?? '').includes(`.ASPXAUTH_TRUEHOME=${state.cookie}`);
    if (!signedIn || state.expireNext) {
      state.expireNext = false;
      state.cookie = '';
      return new Response('', { status: 401, headers: { location: '/portal/Home/Index' } });
    }
    if (u.pathname.startsWith('/portal/Location/GetLocationListData')) {
      if (u.searchParams.get('page') !== '1') return json([]);
      return json([{ LocationID: 7, Name: 'Home', Devices: [{ DeviceID: 101, Name: 'BASEMENT', MacID: 'AA' }, { DeviceID: 102, Name: 'MAIN FLOOR', MacID: 'BB' }] }]);
    }
    const m = /^\/portal\/Device\/CheckDataSession\/(\d+)$/.exec(u.pathname);
    if (m) {
      const d = state.devices.get(Number(m[1]));
      return json({ success: true, deviceLive: state.live, communicationLost: !state.live, latestData: { uiData: d, hasFan: true, fanData: { fanIsRunning: false } } });
    }
    if (u.pathname === '/portal/Device/SubmitControlScreenChanges') {
      const body = JSON.parse(String(init?.body));
      state.changes.push(body);
      return json({ success: 1 });
    }
    return new Response('not found', { status: 404 });
  };
  return { state, fetch: f as typeof fetch };
}

let p = portal();

const signIn = () => h.signIn(EMAIL, GOOD).then((r) => h.addThermostats(r.locations!));
const idOf = (deviceId: number) => t.thermostatIdForHoneywell(deviceId)!;

describe('Honeywell Total Connect Comfort', () => {
  before(async () => {
    db = (await import('../db')).getDb();
    h = await import('./honeywell');
    tcc = await import('./tcc');
    t = await import('../thermostat/thermostat');
  });
  after(() => { h.stopHoneywell(); db.close(); fs.rmSync(TMP, { recursive: true, force: true }); });
  beforeEach(() => {
    p = portal();
    h.setFetch(p.fetch);
    h.resetForTests();
    db.exec("DELETE FROM devices; DELETE FROM thermostats; DELETE FROM settings WHERE key LIKE 'honeywell_%'");
  });

  it('reads the error a portal page shows', () => {
    assert.equal(tcc.pageError('<div class="validation-summary-errors"><ul><li>The email or password provided is incorrect.</li></ul></div>'),
      'The email or password provided is incorrect.');
    assert.equal(tcc.pageError('<html>nothing wrong</html>'), null);
  });

  it('a wrong password is refused and nothing is saved', async () => {
    await assert.rejects(h.signIn(EMAIL, 'wrong'), (err: unknown) =>
      err instanceof tcc.TccError && err.kind === 'rejected' && /incorrect/.test(err.message));
    assert.equal(h.accountStatus().signedIn, false);
  });

  it('signing in saves the account and adds each thermostat once, named for voice', async () => {
    const added = await signIn();
    assert.deepEqual(added.map((d) => d.alias), ['Basement Thermostat', 'Main Floor Thermostat']);
    assert.deepEqual(h.accountStatus(), { email: EMAIL, signedIn: true, rejected: false, message: null });
    const row = db.prepare("SELECT ip, driver_type, driver_config FROM devices WHERE alias = 'Basement Thermostat'").get() as { ip: string; driver_type: string; driver_config: string };
    assert.equal(row.ip, 'honeywell:101');
    assert.equal(row.driver_type, 'honeywell');
    assert.deepEqual(JSON.parse(row.driver_config), { kind: 'thermostat', deviceId: 101, locationId: 7 });
    // Signing in again adds nothing new.
    assert.deepEqual(await signIn(), []);
  });

  it('names: capitals become words; a name that says thermostat is kept', () => {
    assert.equal(h.aliasFor('MAIN FLOOR'), 'Main Floor Thermostat');
    assert.equal(h.aliasFor('Upstairs thermostat'), 'Upstairs thermostat');
    assert.equal(h.aliasFor('Kid’s Room'), 'Kid’s Room Thermostat');
  });

  it('a reading becomes °C, with its modes, limits, deadband, running state and hold', () => {
    const r = h.toReading({ live: true, ui: ui(), fan: { running: false } });
    assert.equal(r.temperature, 20.56);
    assert.equal(r.heat, 20);
    assert.equal(r.cool, 24.44);
    assert.equal(r.mode, 'heat');
    assert.deepEqual(r.modes, ['off', 'heat', 'cool', 'auto']);
    assert.equal(r.running, 'heating');
    assert.deepEqual(r.heatLimits, [4.44, 32.22]);
    assert.equal(r.deadband, 1.67);
    assert.equal(r.hold, 'schedule');
    // Heat only, emergency heat on, fan running, a temporary hold.
    const heatOnly = h.toReading({ live: true, ui: ui({ SwitchCoolAllowed: false, SwitchAutoAllowed: false, SystemSwitchPosition: 0, EquipmentOutputStatus: 0, StatusHeat: 1 }), fan: { running: true } });
    assert.deepEqual(heatOnly.modes, ['off', 'heat']);
    assert.equal(heatOnly.cool, null);
    assert.equal(heatOnly.coolLimits, null);
    assert.equal(heatOnly.mode, 'other');
    assert.equal(heatOnly.running, 'fan');
    assert.equal(heatOnly.hold, 'temporary');
    // Nothing said about the equipment: running is unknown, not idle.
    assert.equal(h.toReading({ live: true, ui: ui({ EquipmentOutputStatus: null }), fan: null }).running, null);
    // A thermostat shown in °C.
    const c = h.toReading({ live: true, ui: ui({ DisplayUnits: 'C', HeatSetpoint: 20.5, Deadband: 1.5 }), fan: null });
    assert.equal(c.heat, 20.5);
    assert.equal(c.deadband, 1.5);
  });

  it('a change becomes whole °F, keeps the deadband, and holds as asked', () => {
    // 22.2 °C is 72 °F; cooling at 76 must move up to keep 3 °F apart? 72 + 3 = 75 ≤ 76, so it stays.
    assert.deepEqual(h.buildChange(ui(), { heat: 22.2 }, 'temporary'), { HeatSetpoint: 72, StatusHeat: 1, StatusCool: 1 });
    // 24.4 °C is 76 °F: cooling moves to 79.
    assert.deepEqual(h.buildChange(ui(), { heat: 24.4 }, 'temporary'), { HeatSetpoint: 76, CoolSetpoint: 79, StatusHeat: 1, StatusCool: 1 });
    // Cooling down to 70 °F pushes heating to 67.
    assert.deepEqual(h.buildChange(ui(), { cool: 21.1 }, 'permanent'), { CoolSetpoint: 70, HeatSetpoint: 67, StatusHeat: 2, StatusCool: 2 });
    // Already held until changed: stays that way.
    assert.equal(h.buildChange(ui({ StatusHeat: 2 }), { heat: 20 }, 'temporary').StatusHeat, 2);
    // Beyond its limits: kept inside them.
    assert.equal(h.buildChange(ui(), { heat: 40 }, 'temporary').HeatSetpoint, 90);
    // A mode alone holds nothing.
    assert.deepEqual(h.buildChange(ui(), { mode: 'cool' }, 'temporary'), { SystemSwitch: 3 });
    assert.throws(() => h.buildChange(ui({ SwitchCoolAllowed: false }), { mode: 'cool' }, 'temporary'), /can’t be set to cool/);
    // °C thermostats take halves.
    assert.equal(h.buildChange(ui({ DisplayUnits: 'C', HeatSetpoint: 20, CoolSetpoint: 25, Deadband: 1.5, HeatLowerSetptLimit: 4.5, HeatUpperSetptLimit: 32 }), { heat: 21.3 }, 'temporary').HeatSetpoint, 21.5);
  });

  it('polling makes them thermostats HomeHub shows; a change shows at once and holds per source', async () => {
    await signIn();
    await h.pollAll();
    const basement = idOf(101);
    const view = await t.getThermostat(basement);
    assert.equal(view.online, true);
    assert.equal(view.alias, 'Basement Thermostat');
    assert.equal(view.heat, 20);
    assert.equal(view.hold, 'schedule');
    assert.equal((await t.listThermostats()).length, 2);

    // From the card: held until the thermostat's next schedule period.
    const after = await t.changeThermostat(basement, { heat: 21.11 }, 'app');
    assert.equal(after.heat, 21.11);
    assert.deepEqual(
      { DeviceID: p.state.changes[0].DeviceID, HeatSetpoint: p.state.changes[0].HeatSetpoint, StatusHeat: p.state.changes[0].StatusHeat, SystemSwitch: p.state.changes[0].SystemSwitch, CoolSetpoint: p.state.changes[0].CoolSetpoint },
      { DeviceID: 101, HeatSetpoint: 70, StatusHeat: 1, SystemSwitch: null, CoolSetpoint: null },
    );
    // Honeywell hasn't caught up yet, but the card shows what was sent.
    await h.pollAll();
    assert.equal((await t.getThermostat(basement)).heat, 21.11);
    assert.equal((await t.getThermostat(basement)).hold, 'temporary');

    // From a HomeHub schedule: held until HomeHub changes it.
    await t.changeThermostat(basement, { heat: 18.89 }, 'schedule');
    assert.equal(p.state.changes[1].HeatSetpoint, 66);
    assert.equal(p.state.changes[1].StatusHeat, 2);

    // Back to its own schedule.
    p.state.devices.set(101, ui({ HeatSetpoint: 66, StatusHeat: 2, StatusCool: 2 }));
    await h.pollAll();
    assert.equal(await t.resumeOwnSchedule(basement), true);
    assert.equal(p.state.changes[2].StatusHeat, 0);
    assert.equal(p.state.changes[2].HeatSetpoint, null);
  });

  it('chat and voice stay inside the allowed range; the card can go to the thermostat’s own limits', async () => {
    await signIn();
    await h.pollAll();
    const id = idOf(101);
    await assert.rejects(t.changeThermostat(id, { heat: 29 }, 'voice'), /outside the range allowed/);
    await t.changeThermostat(id, { heat: 29 }, 'app');
    assert.equal(p.state.changes.at(-1)!.HeatSetpoint, 84);
  });

  it('an ended session signs in again once and carries on', async () => {
    await signIn();
    await h.pollAll();
    const before = p.state.signIns;
    p.state.expireNext = true;
    p.state.devices.set(101, ui({ DispTemperature: 71 }));
    await h.pollAll();
    assert.equal(p.state.signIns, before + 1);
    assert.equal((await t.getThermostat(idOf(101))).temperature, 21.67);
  });

  it('a saved password Honeywell later refuses is tried once, then HomeHub waits for a new sign-in', async () => {
    await signIn();
    await h.pollAll();
    p.state.password = 'changed-in-the-app';
    p.state.expireNext = true;
    await h.pollAll();
    const after = p.state.signIns;
    assert.equal(h.accountStatus().rejected, true);
    assert.match(h.accountStatus().message ?? '', /incorrect/);
    // Later rounds don't try again.
    h.resetForTests();
    await h.pollAll();
    await h.pollAll();
    assert.equal(p.state.signIns, after);
    // Signing in again with the new password clears it.
    p.state.password = GOOD;
    await signIn();
    assert.equal(h.accountStatus().rejected, false);
  });

  it('signed in but turned away each time: backs off instead of signing in every minute', async () => {
    await signIn();
    await h.pollAll();
    const before = p.state.signIns;
    // Every data request now finds the session ended, even a brand-new one.
    const orig = p.fetch;
    h.setFetch(async (url, init) => {
      if (String(url).includes('/portal/Device/')) return new Response('', { status: 401 });
      return orig(url, init);
    });
    await h.pollAll();
    // Swapping the fake dropped the session, so: sign in, turned away, sign in once more, turned away.
    assert.equal(p.state.signIns, before + 2);
    await h.pollAll();
    await h.pollAll();
    assert.equal(p.state.signIns, before + 2, 'then it waits, rather than signing in each round');
  });

  it('signed in but the list was slow: the sign-in is kept, and the next poll adds the thermostats', async () => {
    const orig = p.fetch;
    let slow = true;
    h.setFetch(async (url, init) => {
      if (slow && String(url).includes('GetLocationListData')) return new Response('', { status: 503 });
      return orig(url, init);
    });
    const r = await h.signIn(EMAIL, GOOD);
    assert.equal(r.locations, null);
    assert.ok(r.listError);
    assert.equal(h.accountStatus().signedIn, true);
    slow = false;
    await h.pollAll();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM devices WHERE driver_type = 'honeywell'").get() as { n: number }).n, 2);
    assert.equal((await t.getThermostat(idOf(101))).online, true);
  });

  it('a thermostat that lost touch with its gateway, or not read lately, shows offline', async () => {
    await signIn();
    p.state.live = false;
    await h.pollAll();
    const id = idOf(101);
    assert.equal((await t.getThermostat(id)).online, false);
    await assert.rejects(t.changeThermostat(id, { heat: 21 }, 'app'), (err: unknown) => err instanceof t.ThermostatError && err.status === 503);
  });

  it('on and off: off sets the mode off; on goes back to the last mode', async () => {
    const { getDriver } = await import('../drivers/registry');
    await signIn();
    await h.pollAll();
    const driver = getDriver('honeywell');
    const cfg = { kind: 'thermostat', deviceId: 101 };
    assert.equal(await driver.getPower('honeywell:101', cfg), true);
    await driver.setPower('honeywell:101', false, cfg);
    assert.equal(p.state.changes.at(-1)!.SystemSwitch, 2);
    assert.equal(await driver.getPower('honeywell:101', cfg), false);
    // Honeywell confirms it's off; turning on goes back to heat, its last mode.
    p.state.devices.set(101, ui({ SystemSwitchPosition: 2 }));
    await h.pollAll();
    await driver.setPower('honeywell:101', true, cfg);
    assert.equal(p.state.changes.at(-1)!.SystemSwitch, 1);
  });

  it('signing out forgets the account; the thermostats stay, offline', async () => {
    await signIn();
    await h.pollAll();
    h.signOut();
    assert.equal(h.accountStatus().signedIn, false);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM devices WHERE driver_type = 'honeywell'").get() as { n: number }).n, 2);
    assert.equal((await t.getThermostat(idOf(101))).online, false);
  });
});
