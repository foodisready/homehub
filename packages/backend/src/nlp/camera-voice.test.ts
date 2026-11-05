/**
 * Pausing and resuming cameras by voice and Chat, against a temp DB with
 * stubbed drivers. Modules load in before(), after DB_PATH is set.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-camera-voice-test-'));

let db: Database.Database;
let commands: typeof import('./commands');
let act: typeof import('../activity/activity');
const calls: string[] = [];
const pushes: { title: string; body: string }[] = [];
let server: http.Server;
let base = '';
let role: 'admin' | 'member' = 'admin';

describe('cameras by voice', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    const { getDriver } = await import('../drivers/registry');
    for (const type of ['kasa', 'wyze']) {
      getDriver(type).setPower = async (ip: string, state: boolean) => { calls.push(`${ip}=${state ? 'on' : 'off'}`); };
    }
    const push = await import('../push/push.service');
    (push as { sendPushToAll: unknown }).sendPushToAll = (title: string, body: string) => { pushes.push({ title, body }); };
    commands = await import('./commands');
    act = await import('../activity/activity');

    const cam = db.prepare("INSERT INTO devices (alias, ip, driver_type, driver_config, room) VALUES (?, ?, 'wyze', '{}', ?)");
    cam.run('General', 'cam-general', 'Living room');
    cam.run('Kitchen Island', 'cam-kitchen', 'Kitchen');
    cam.run('Master bedroom', 'cam-bedroom', null);
    db.prepare("INSERT INTO devices (alias, ip, room) VALUES ('Kitchen lamp', 'lamp-kitchen', 'Kitchen')").run();

    const { scenesRouter } = await import('../routes/scenes');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { sub: 1, name: 'pat', role } as never; next(); });
    app.use('/api/scenes', scenesRouter);
    await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/scenes`;
  });

  after(async () => {
    await new Promise<void>((ok) => server.close(() => ok()));
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    calls.length = 0;
    pushes.length = 0;
    role = 'admin';
    db.prepare('DELETE FROM scenes').run();
    db.prepare('UPDATE devices SET is_protected = 0').run();
  });

  const voice = (text: string) => act.withActivity({ source: 'voice' }, () => commands.runPowerCommand(text));
  const sorted = () => [...calls].sort();

  describe('reading the words', () => {
    for (const [text, expected] of [
      ['pause the cameras', { name: 'the cameras', state: false }],
      ['Resume the cameras.', { name: 'the cameras', state: true }],
      ['unpause all cameras', { name: 'all cameras', state: true }],
      ['resume the kitchen island camera again', { name: 'the kitchen island camera', state: true }],
    ] as const) {
      it(`reads "${text}"`, () => assert.deepEqual(commands.parseCameraCommand(text), expected));
    }
    it('reads "turn the cameras back on" and "turn back on the cameras"', () => {
      assert.deepEqual(commands.parsePowerCommand('turn the cameras back on'), { name: 'the cameras', state: true });
      assert.deepEqual(commands.parsePowerCommand('turn back on the cameras'), { name: 'the cameras', state: true });
    });
  });

  describe('resuming', () => {
    for (const text of ['resume the cameras', 'resume all the cameras', 'turn on the cameras', 'turn the cameras back on', 'unpause every camera', 'resume my cams']) {
      it(`"${text}" resumes every camera`, async () => {
        const r = await voice(text);
        assert.equal(r?.response, 'Resumed General, Kitchen Island and Master bedroom.');
        assert.deepEqual(sorted(), ['cam-bedroom=on', 'cam-general=on', 'cam-kitchen=on']);
      });
    }

    it('resumes one camera by name', async () => {
      assert.equal((await voice('resume kitchen island'))?.response, 'Resumed Kitchen Island.');
      assert.deepEqual(calls, ['cam-kitchen=on']);
    });

    it('"resume the kitchen" resumes only the kitchen\'s camera', async () => {
      assert.equal((await voice('resume the kitchen'))?.response, 'Resumed Kitchen Island.');
      assert.deepEqual(calls, ['cam-kitchen=on']);
    });

    it('leaves a camera marked protected alone', async () => {
      db.prepare("UPDATE devices SET is_protected = 1 WHERE alias = 'General'").run();
      const r = await voice('resume the cameras');
      assert.match(r!.response, /General is protected/);
      assert.deepEqual(sorted(), ['cam-bedroom=on', 'cam-kitchen=on']);
    });

    it('leaves "pause" or "resume" of something that isn\'t a camera for the model', async () => {
      assert.equal(await voice('pause the kitchen lamp'), null);
      assert.equal(await voice('resume the music'), null);
      assert.deepEqual(calls, []);
    });
  });

  describe('pausing without a scene', () => {
    for (const text of ['pause the cameras', 'pause all cameras', 'turn off the cameras', 'pause general', 'turn off kitchen island', 'pause the kitchen']) {
      it(`refuses "${text}", without hinting how`, async () => {
        const r = await voice(text);
        assert.equal(r?.response, "For safety, I can't pause cameras that way.");
        assert.deepEqual(calls, []);
        assert.deepEqual(pushes, []);
      });
    }

    it('still turns off the lamp in a room, but not its camera', async () => {
      const r = await voice('turn off the kitchen');
      assert.deepEqual(calls, ['lamp-kitchen=off']);
      assert.match(r!.response, /Kitchen Island is protected/);
    });
  });

  describe('a scene allowed to pause cameras', () => {
    const scene = async (name: string, state: boolean, voiceMayPause?: boolean) => {
      const devices = db.prepare("SELECT id FROM devices WHERE driver_type = 'wyze'").all() as { id: number }[];
      const r = await fetch(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, actions: devices.map((d) => ({ deviceId: d.id, state })), ...(voiceMayPause === undefined ? {} : { voiceMayPause }) }),
      });
      return { status: r.status, body: await r.json() as any };
    };

    it('pauses every camera in it, and tells everyone\'s phone', async () => {
      const created = await scene('Pineapple time', false, true);
      assert.equal(created.status, 201);
      assert.equal(created.body.voiceMayPause, true);
      assert.ok(created.body.actions.every((a: { camera: boolean }) => a.camera));

      const r = await voice('pineapple time');
      assert.equal(r?.response, 'Ran Pineapple time.');
      assert.deepEqual(sorted(), ['cam-bedroom=off', 'cam-general=off', 'cam-kitchen=off']);
      assert.deepEqual(pushes, [{ title: 'Cameras paused', body: 'Pineapple time (by voice) paused General, Kitchen Island and Master bedroom.' }]);
    });

    it('says "from Chat" when Chat ran it', async () => {
      await scene('Pineapple time', false, true);
      await act.withActivity({ source: 'chat' }, () => commands.runPowerCommand('run pineapple time'));
      assert.equal(pushes[0]?.body, 'Pineapple time (from Chat) paused General, Kitchen Island and Master bedroom.');
    });

    it('a scene not allowed to leaves the cameras on', async () => {
      await scene('Quiet time', false);
      const r = await voice('quiet time');
      assert.deepEqual(calls, []);
      assert.deepEqual(pushes, []);
      assert.match(r!.response, /^Ran part of Quiet time\./);
    });

    it('never pauses a camera marked protected', async () => {
      await scene('Pineapple time', false, true);
      db.prepare("UPDATE devices SET is_protected = 1 WHERE alias = 'General'").run();
      await voice('pineapple time');
      assert.deepEqual(sorted(), ['cam-bedroom=off', 'cam-kitchen=off']);
      assert.match(pushes[0].body, /paused Kitchen Island and Master bedroom\.$/);
    });

    it('a resume scene needs no permission and sends no notification', async () => {
      await scene('Pineapple done', true);
      assert.equal((await voice('pineapple done'))?.response, 'Ran Pineapple done.');
      assert.deepEqual(sorted(), ['cam-bedroom=on', 'cam-general=on', 'cam-kitchen=on']);
      assert.deepEqual(pushes, []);
    });

    it('can be allowed or stopped later, by an admin only', async () => {
      const { body } = await scene('Pineapple time', false);
      assert.equal(body.voiceMayPause, false);
      const patch = (value: unknown) => fetch(`${base}/${body.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voiceMayPause: value }) });

      assert.equal((await (await patch(true)).json() as any).voiceMayPause, true);
      await voice('pineapple time');
      assert.equal(calls.length, 3);

      assert.equal((await patch('yes')).status, 400);
      assert.equal((await fetch(`${base}/99999`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voiceMayPause: true }) })).status, 404);

      role = 'member';
      assert.equal((await patch(false)).status, 403);
      assert.equal((await scene('Sneaky', false, true)).status, 403, 'a member can\'t make one either');
      assert.equal((await fetch(`${base}/${body.id}`, { method: 'DELETE' })).status, 403);
      const list = await (await fetch(base)).json() as any[];
      assert.equal(list.find((s) => s.id === body.id).voiceMayPause, true, 'still allowed; members can see it');
    });
  });
});
