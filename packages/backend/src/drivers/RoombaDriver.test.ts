/** Starting a Roomba, sending it home and reading what it's doing, against a pretend robot. */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { MqttClient } from 'mqtt';
import { RoombaDriver } from './RoombaDriver';
import { closeAll, setConnectForTests } from '../roomba/link';

/** A robot: answers commands the way a real one does, and reports its state over the connection. */
class FakeRobot extends EventEmitter {
  connected = false;
  commands: string[] = [];
  options: Record<string, unknown> = {};
  constructor(public cycle: string, public phase: string, private reachable = true) { super(); }

  start(options: Record<string, unknown>): this {
    this.options = options;
    setImmediate(() => {
      if (!this.reachable) { this.emit('error', new Error('connect ETIMEDOUT')); this.emit('close'); return; }
      this.connected = true;
      this.emit('connect');
      this.report();
    });
    return this;
  }
  subscribe(_topic: string, _opts: unknown, cb: () => void) { cb(); }
  publish(topic: string, payload: string, _opts: unknown, cb: (err?: Error) => void) {
    assert.equal(topic, 'cmd');
    const { command } = JSON.parse(payload);
    this.commands.push(command);
    cb();
    if (command === 'start') this.set('clean', 'run');
    if (command === 'resume') this.set(this.cycle, 'run');
    if (command === 'pause') setTimeout(() => this.set(this.cycle, 'stop'), 20);
    // Like a real one, it ignores "dock" while it's running.
    if (command === 'dock' && this.phase !== 'run') this.set('dock', 'hmUsrDock');
  }
  set(cycle: string, phase: string) { this.cycle = cycle; this.phase = phase; this.report(); }
  report() {
    this.emit('message', '$aws/things/x/shadow/update', Buffer.from(JSON.stringify({
      state: { reported: { batPct: 77, cleanMissionStatus: { cycle: this.cycle, phase: this.phase, error: 0 } } },
    })));
  }
  end() { this.connected = false; }
}

const config = { blid: 'ROBOTID', password: 'pw' };
let robot: FakeRobot;
const use = (r: FakeRobot) => {
  robot = r;
  setConnectForTests((_url, options) => r.start(options as Record<string, unknown>) as unknown as MqttClient);
};

describe('Roomba driver', () => {
  afterEach(() => closeAll());
  const driver = new RoombaDriver();

  it('logs in with the robot’s id and saved password, over TLS without checking its own certificate', async () => {
    use(new FakeRobot('none', 'charge'));
    await driver.getPower('10.0.0.9', config);
    assert.equal(robot.options.username, 'ROBOTID');
    assert.equal(robot.options.clientId, 'ROBOTID');
    assert.equal(robot.options.password, 'pw');
    assert.equal(robot.options.rejectUnauthorized, false);
  });

  it('is off on its dock, and on once cleaning', async () => {
    use(new FakeRobot('none', 'charge'));
    assert.equal(await driver.getPower('10.0.0.9', config), false);
    robot.set('clean', 'run');
    assert.equal(await driver.getPower('10.0.0.9', config), true);
  });

  it('turning on starts a job from the dock', async () => {
    use(new FakeRobot('none', 'charge'));
    await driver.setPower('10.0.0.9', true, config);
    assert.deepEqual(robot.commands, ['start']);
  });

  it('turning on carries on with a paused job instead of starting over', async () => {
    use(new FakeRobot('clean', 'stop'));
    await driver.setPower('10.0.0.9', true, config);
    assert.deepEqual(robot.commands, ['resume']);
  });

  it('turning on does nothing while it’s already cleaning', async () => {
    use(new FakeRobot('clean', 'run'));
    await driver.setPower('10.0.0.9', true, config);
    assert.deepEqual(robot.commands, []);
  });

  it('turning off pauses a running robot first, then sends it home', async () => {
    use(new FakeRobot('clean', 'run'));
    await driver.setPower('10.0.0.9', false, config);
    assert.deepEqual(robot.commands, ['pause', 'dock']);
    assert.equal(robot.phase, 'hmUsrDock');
  });

  it('turning off a paused robot sends it straight home', async () => {
    use(new FakeRobot('clean', 'stop'));
    await driver.setPower('10.0.0.9', false, config);
    assert.deepEqual(robot.commands, ['dock']);
  });

  it('turning off a robot recharging on its dock part way ends the job, rather than sending it home', async () => {
    use(new FakeRobot('clean', 'hmMidMsn'));
    await driver.getPower('10.0.0.9', config);
    robot.set('clean', 'charge');
    assert.equal(await driver.getPower('10.0.0.9', config), true);   // it will carry on
    await driver.setPower('10.0.0.9', false, config);
    assert.deepEqual(robot.commands, ['stop']);
  });

  it('turning off leaves a docked robot alone', async () => {
    use(new FakeRobot('none', 'charge'));
    await driver.setPower('10.0.0.9', false, config);
    assert.deepEqual(robot.commands, []);
  });

  it('says it can’t reach a robot that doesn’t answer, without waiting out the timeout', async () => {
    use(new FakeRobot('none', 'charge', false));
    const started = Date.now();
    await assert.rejects(driver.getPower('10.0.0.9', config), /isn't answering/);
    assert.ok(Date.now() - started < 2000);
  });

  it('asks to pair again when the saved login is missing', async () => {
    await assert.rejects(driver.getPower('10.0.0.9', { blid: 'ROBOTID' }), /isn’t paired/);
  });
});
