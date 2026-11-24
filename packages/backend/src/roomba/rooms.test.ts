/**
 * Learning a Roomba's rooms from its jobs, naming them, and cleaning them from the dashboard,
 * Chat and voice, against a temp DB and a pretend robot.
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this file stays on its temp DB.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { MqttClient } from 'mqtt';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-roomba-rooms-test-'));

let db: Database.Database;
let rooms: typeof import('./rooms');
let link: typeof import('./link');
let service: typeof import('./service');
let voice: typeof import('../nlp/vacuum-rooms');
let protocol: typeof import('./protocol');

const MAP = 'MAPID1';

/** A robot that reports its state and, like a real one, the last job it was given. */
class FakeRobot extends EventEmitter {
  connected = false;
  sent: Record<string, unknown>[] = [];
  phase = 'charge';
  cycle = 'none';
  /** Takes no notice of anything sent. */
  deaf = false;
  lastCommand: Record<string, unknown> = { command: 'start', initiator: 'rmtApp' };
  start(): this {
    setImmediate(() => { this.connected = true; this.emit('connect'); this.report(); });
    return this;
  }
  subscribe(_t: string, _o: unknown, cb: () => void) { cb(); }
  publish(_topic: string, payload: string, _o: unknown, cb: (err?: Error) => void) {
    const cmd = JSON.parse(payload);
    this.sent.push(cmd);
    cb();
    if (this.deaf) return;
    // Like an i-series: a job it holds paused has to be ended before it takes a new one.
    if (cmd.command === 'stop') { this.cycle = 'none'; this.phase = this.phase === 'charge' ? 'charge' : 'stop'; this.report(); }
    if (cmd.command === 'start' && this.cycle === 'none') { this.cycle = 'clean'; this.phase = 'run'; this.lastCommand = cmd; this.report(); }
  }
  /** Someone started a job in the iRobot app. */
  appJob(regions: string[]) {
    this.lastCommand = { command: 'start', initiator: 'rmtApp', ordered: 1, pmap_id: MAP, user_pmapv_id: 'V1',
      regions: regions.map((id) => ({ region_id: id, type: 'rid' })) };
    this.report();
  }
  report() {
    this.emit('message', 'shadow', Buffer.from(JSON.stringify({ state: { reported: {
      batPct: 90, cleanMissionStatus: { cycle: this.cycle, phase: this.phase, error: 0 }, lastCommand: this.lastCommand,
    } } })));
  }
  end() { this.connected = false; }
}

let robot: FakeRobot;
let deviceId: number;
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('Roomba rooms', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    rooms = await import('./rooms');
    link = await import('./link');
    service = await import('./service');
    voice = await import('../nlp/vacuum-rooms');
    protocol = await import('./protocol');
    service.startRoombaUpdates();
    service.setWaitsForTests({ endMs: 300, startMs: 300, stepMs: 20 });
  });

  after(() => {
    link.closeAll();
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(async () => {
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM device_events').run();
    db.prepare('DELETE FROM devices').run();
    db.pragma('foreign_keys = ON');
    deviceId = Number(db.prepare("INSERT INTO devices (alias, ip, driver_type, driver_config) VALUES ('Roomba i8', '10.0.0.55', 'roomba', ?)")
      .run(JSON.stringify({ blid: 'BLID', password: 'pw' })).lastInsertRowid);
    robot = new FakeRobot();
    link.setConnectForTests(() => robot.start() as unknown as MqttClient);
    await link.readStatus('10.0.0.55', { blid: 'BLID', password: 'pw' });
  });

  afterEach(() => link.closeAll());

  it('learns a room from a one-room job started in the iRobot app, unnamed', async () => {
    robot.appJob(['7']);
    await tick();
    const learned = rooms.roomsOf(deviceId);
    assert.equal(learned.length, 1);
    assert.equal(learned[0].id, '7');
    assert.equal(learned[0].name, null);
  });

  it('learns nothing new from a job of several rooms: it doesn’t say which is which', async () => {
    robot.appJob(['7', '9']);
    await tick();
    assert.equal(rooms.roomsOf(deviceId).length, 0);
  });

  it('a whole-house job teaches nothing', async () => {
    robot.lastCommand = { command: 'start', initiator: 'localApp' };
    robot.report();
    await tick();
    assert.equal(rooms.roomsOf(deviceId).length, 0);
  });

  it('names a room, refusing a blank name or one another room has', async () => {
    robot.appJob(['7']); await tick();
    robot.appJob(['9']); await tick();
    const [a, b] = rooms.roomsOf(deviceId);
    rooms.nameRoom(deviceId, a.key, '  Kitchen ');
    assert.equal(rooms.roomsOf(deviceId).find((r) => r.key === a.key)?.name, 'Kitchen');
    assert.throws(() => rooms.nameRoom(deviceId, b.key, ' '), /Give the room a name/);
    assert.throws(() => rooms.nameRoom(deviceId, b.key, 'kitchen'), /already called Kitchen/);
  });

  it('keeps rooms and the robot’s login when learning, and never shows the password in the room list', async () => {
    robot.appJob(['7']); await tick();
    const config = JSON.parse((db.prepare('SELECT driver_config FROM devices WHERE id = ?').get(deviceId) as { driver_config: string }).driver_config);
    assert.equal(config.password, 'pw');
    assert.equal(config.maps[MAP], 'V1');
    assert.ok(!JSON.stringify(rooms.roomsView(JSON.stringify(config))).includes('pw'));
  });

  it('cleans named rooms in the order asked, on the map and version they were learned on', async () => {
    robot.appJob(['7']); await tick();
    robot.appJob(['9']); await tick();
    const [k, l] = rooms.roomsOf(deviceId);
    rooms.nameRoom(deviceId, k.key, 'Kitchen');
    rooms.nameRoom(deviceId, l.key, 'Living Room');
    robot.cycle = 'none'; robot.phase = 'charge'; robot.report(); await tick();
    // HomeHub has known it off a while: a start it sees on its own counts as done outside HomeHub.
    (await import('../kasa/device.cache')).noteState(deviceId, false, Date.now() - 60_000);
    const done = await service.cleanRooms(deviceId, [l.key, k.key]);
    assert.deepEqual(done.names, ['Living Room', 'Kitchen']);
    const sent = robot.sent.at(-1)!;
    assert.equal(sent.command, 'start');
    assert.equal(sent.pmap_id, MAP);
    assert.equal(sent.user_pmapv_id, 'V1');
    assert.equal(sent.ordered, 1);
    assert.deepEqual(sent.regions, [{ region_id: '9', type: 'rid' }, { region_id: '7', type: 'rid' }]);
    await tick();
    // Recorded once, as HomeHub switching it on, not as something done outside HomeHub.
    const events = db.prepare("SELECT state, source FROM device_events WHERE device_id = ? AND kind = 'power' AND at >= datetime('now', '-1 minute')").all(deviceId) as { state: number; source: string }[];
    assert.deepEqual(events.filter((e) => e.state === 1).map((e) => e.source).filter((s) => s === 'outside'), []);
    assert.equal(events.filter((e) => e.state === 1).length, 1);
    // The dashboard names the job's rooms, in order.
    assert.deepEqual(service.vacuumViewOf(deviceId, JSON.stringify({ blid: 'BLID' }))?.job, { whole: false, rooms: ['Living Room', 'Kitchen'] });
  });

  it('won’t start rooms while it’s out on a job, which would quietly replace that job', async () => {
    robot.appJob(['7']); await tick();
    rooms.nameRoom(deviceId, rooms.roomsOf(deviceId)[0].key, 'Kitchen');
    robot.cycle = 'clean'; robot.phase = 'run'; robot.report(); await tick();
    await assert.rejects(service.cleanRooms(deviceId, [rooms.roomsOf(deviceId)[0].key]), /already cleaning/);
    assert.equal(robot.sent.length, 0);
  });

  it('ends a job it holds paused on its dock before starting the rooms: it ignores a new job until then', async () => {
    robot.appJob(['7']); await tick();
    const [k] = rooms.roomsOf(deviceId);
    rooms.nameRoom(deviceId, k.key, 'Kitchen');
    robot.cycle = 'clean'; robot.phase = 'charge'; robot.report(); await tick();
    // Sent home part way: full, and not counting down to carry on.
    robot.emit('message', 'shadow', Buffer.from(JSON.stringify({ state: { reported: { batPct: 100, cleanMissionStatus: { rechrgM: 0 } } } })));
    await tick();
    assert.equal((await link.readStatus('10.0.0.55', { blid: 'BLID', password: 'pw' })).activity, 'paused');
    await service.cleanRooms(deviceId, [k.key]);
    assert.deepEqual(robot.sent.map((c) => c.command), ['stop', 'start']);
    assert.deepEqual((robot.sent[1].regions as { region_id: string }[]).map((r) => r.region_id), ['7']);
  });

  it('says so, and records nothing, when the robot doesn’t set off', async () => {
    robot.appJob(['7']); await tick();
    const [k] = rooms.roomsOf(deviceId);
    rooms.nameRoom(deviceId, k.key, 'Kitchen');
    robot.deaf = true;
    await assert.rejects(service.cleanRooms(deviceId, [k.key]), /didn’t start/);
    const started = db.prepare("SELECT COUNT(*) AS n FROM device_events WHERE device_id = ? AND kind = 'power' AND state = 1").get(deviceId) as { n: number };
    assert.equal(started.n, 0);
  });

  it('ends a job on request, as the app’s End now', async () => {
    robot.cycle = 'clean'; robot.phase = 'stop'; robot.report(); await tick();
    await service.endJob(deviceId);
    assert.deepEqual(robot.sent.map((c) => c.command), ['stop']);
    await assert.rejects(service.endJob(deviceId), /no job to end/);
  });

  it('won’t clean a room that hasn’t been named', async () => {
    robot.appJob(['7']); await tick();
    assert.throws(() => rooms.jobFor(deviceId, [rooms.roomsOf(deviceId)[0].key]), /isn’t known/);
  });

  describe('by voice and in Chat', () => {
    beforeEach(async () => {
      robot.appJob(['7']); await tick();
      robot.appJob(['9']); await tick();
      robot.appJob(['12']); await tick();
      const [k, l, b] = rooms.roomsOf(deviceId);
      rooms.nameRoom(deviceId, k.key, 'Kitchen');
      rooms.nameRoom(deviceId, l.key, 'Living Room');
      rooms.nameRoom(deviceId, b.key, 'Breakfast Room');
      robot.cycle = 'none'; robot.phase = 'charge'; robot.report(); await tick();
      robot.sent = [];
    });

    const regionsSent = () => (robot.sent.at(-1)?.regions as { region_id: string }[] | undefined)?.map((r) => r.region_id);

    it('"vacuum the kitchen"', async () => {
      const r = await voice.runVacuumCommand('Vacuum the kitchen');
      assert.equal(r?.response, 'Cleaning the Kitchen.');
      assert.deepEqual(regionsSent(), ['7']);
    });

    it('"clean the breakfast room and the living room", in that order', async () => {
      const r = await voice.runVacuumCommand('clean the breakfast room and the living room');
      assert.equal(r?.response, 'Cleaning the Breakfast Room and Living Room.');
      assert.deepEqual(regionsSent(), ['12', '9']);
    });

    it('"have the robot clean the living room"', async () => {
      await voice.runVacuumCommand('have the robot clean the living room please');
      assert.deepEqual(regionsSent(), ['9']);
    });

    it('掃廚房, in Cantonese, answered in Cantonese', async () => {
      const r = await voice.runVacuumCommand('掃廚房啦');
      assert.equal(r?.response, '而家去掃廚房。');
      assert.deepEqual(r?.said, { lang: 'yue' });
      assert.deepEqual(regionsSent(), ['7']);
    });

    it('打扫厨房和客厅, in Mandarin with simplified characters', async () => {
      const r = await voice.runVacuumCommand('打扫厨房和客厅');
      assert.equal(r?.lang, 'zh');
      assert.deepEqual(regionsSent(), ['7', '9']);
    });

    it('hút bụi nhà bếp, in Vietnamese, accents or not', async () => {
      const r = await voice.runVacuumCommand('hút bụi nhà bếp');
      assert.equal(r?.response, 'Đang hút bụi nhà bếp.');
      robot.cycle = 'none'; robot.phase = 'charge'; robot.report(); await tick();
      await voice.runVacuumCommand('hut bui phong khach');
      assert.deepEqual(regionsSent(), ['9']);
    });

    it('"vacuum the whole house" is a plain start', async () => {
      const r = await voice.runVacuumCommand('vacuum the whole house');
      assert.match(r!.response, /whole house/);
      assert.equal(robot.sent.at(-1)?.command, 'start');
      assert.equal(robot.sent.at(-1)?.regions, undefined);
    });

    it('leaves anything else for the other rules: a room it doesn’t have, or a light', async () => {
      assert.equal(await voice.runVacuumCommand('clean the garage'), null);
      assert.equal(await voice.runVacuumCommand('turn on the kitchen light'), null);
      assert.equal(await voice.runVacuumCommand('what time is it'), null);
      assert.equal(robot.sent.length, 0);
    });

    it('says the robot is busy rather than replacing its job', async () => {
      robot.cycle = 'clean'; robot.phase = 'run'; robot.report(); await tick();
      const r = await voice.runVacuumCommand('vacuum the kitchen');
      assert.match(r!.response, /already cleaning/);
      assert.equal(robot.sent.length, 0);
    });

    it('the chat models’ tool lists the rooms when a name doesn’t fit', async () => {
      const r = await voice.cleanRoomsByName('Garage');
      assert.ok('error' in r && /Breakfast Room, Kitchen, Living Room|Kitchen/.test(r.error));
      const ok = await voice.cleanRoomsByName('Kitchen, Living Room');
      assert.ok('success' in ok);
      assert.deepEqual(regionsSent(), ['7', '9']);
    });
  });

  it('reads a room job from what the robot reports', () => {
    assert.deepEqual(protocol.roomJobOf({ lastCommand: { command: 'start', pmap_id: 'M', user_pmapv_id: 'V', regions: [{ region_id: 3, type: 'rid' }] } }),
      { pmapId: 'M', versionId: 'V', regions: [{ id: '3', type: 'rid' }] });
    assert.equal(protocol.roomJobOf({ lastCommand: { command: 'dock' } }), null);
    assert.equal(protocol.roomJobOf({ lastCommand: { command: 'start' } }), null);
  });
});
