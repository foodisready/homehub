/** How HomeHub reads a Roomba's answers on the home network. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { commandPayload, decodePassword, mergeReported, parseDiscovery, statusOf, type Reported } from './protocol';

const ID = '0123456789ABCDEF0123456789ABCDEF';

describe('Roomba discovery', () => {
  it('reads the name, model, id and MAC from an i-series answer', () => {
    const r = parseDiscovery('10.0.0.9', JSON.stringify({
      ver: '3', hostname: `iRobot-${ID}`, robotname: 'Hall Robot', ip: '10.0.0.9', mac: '50:14:79:aa:bb:cc', sku: 'i855020', proto: 'mqtt',
    }));
    assert.deepEqual(r, { ip: '10.0.0.9', blid: ID, name: 'Hall Robot', sku: 'i855020', mac: '501479AABBCC', mqtt: true });
  });

  it('takes the older "Roomba-" names, and the sender’s address when the answer has none', () => {
    const r = parseDiscovery('10.0.0.7', JSON.stringify({ hostname: 'Roomba-3115C60441234567', robotname: '', sku: 'R980020' }));
    assert.equal(r?.blid, '3115C60441234567');
    assert.equal(r?.ip, '10.0.0.7');
    assert.equal(r?.name, 'Roomba');
  });

  it('ignores anything that isn’t a robot', () => {
    assert.equal(parseDiscovery('10.0.0.1', 'irobotmcs'), null);
    assert.equal(parseDiscovery('10.0.0.1', JSON.stringify({ hostname: 'printer' })), null);
  });

  it('notes a robot that doesn’t speak MQTT, so it isn’t offered', () => {
    assert.equal(parseDiscovery('10.0.0.1', JSON.stringify({ hostname: `iRobot-${ID}`, proto: 'http' }))?.mqtt, false);
  });
});

describe('Roomba password answer', () => {
  const answer = (password: string) => {
    const body = Buffer.concat([Buffer.from('efcc3b2900', 'hex'), Buffer.from(password), Buffer.from([0])]);
    return Buffer.concat([Buffer.from([0xf0, body.length]), body]);
  };

  it('reads the password, without the trailing zero', () => {
    assert.equal(decodePassword(answer(':1:1700000000:abcDEF123')), ':1:1700000000:abcDEF123');
  });

  it('waits for the rest when the answer comes in pieces', () => {
    const full = answer('secret-pass');
    assert.equal(decodePassword(full.subarray(0, 2)), undefined);
    assert.equal(decodePassword(full.subarray(0, 9)), undefined);
    assert.equal(decodePassword(full), 'secret-pass');
  });

  it('says none when the robot wasn’t in pairing mode', () => {
    assert.equal(decodePassword(Buffer.from('f005efcc3b2900', 'hex')), null);
    assert.equal(decodePassword(Buffer.from('200200', 'hex')), null);
  });

  it('reads a length longer than 127 bytes', () => {
    const password = 'p'.repeat(150);
    const body = Buffer.concat([Buffer.from('efcc3b2900', 'hex'), Buffer.from(password)]);
    const len = body.length;   // 155: two length bytes
    const data = Buffer.concat([Buffer.from([0xf0, (len & 0x7f) | 0x80, len >> 7]), body]);
    assert.equal(decodePassword(data), password);
  });
});

describe('Roomba status', () => {
  const at = (cycle: string, phase: string, extra: Partial<Reported> = {}) =>
    statusOf({ batPct: 80, bin: { present: true, full: false }, cleanMissionStatus: { cycle, phase, error: 0 }, ...extra })!;

  it('is cleaning, and on, while it runs', () => {
    assert.deepEqual([at('clean', 'run').activity, at('clean', 'run').cleaning], ['cleaning', true]);
  });

  it('is paused, still on, when stopped part way through a job', () => {
    assert.deepEqual([at('clean', 'stop').activity, at('clean', 'stop').cleaning], ['paused', true]);
  });

  it('is recharging part way, still on, and will carry on', () => {
    assert.equal(at('clean', 'hmMidMsn').activity, 'recharging');
    assert.equal(at('clean', 'charge').activity, 'recharging');
    assert.equal(at('clean', 'charge').cleaning, true);
    const counting = at('clean', 'charge', { cleanMissionStatus: { cycle: 'clean', phase: 'charge', error: 0, rechrgM: 35 } });
    assert.deepEqual([counting.activity, counting.cleaning], ['recharging', true]);
  });

  it('is paused at home, and off, when a job was sent home part way: it won’t set off again by itself', () => {
    const parked = at('clean', 'charge', { cleanMissionStatus: { cycle: 'clean', phase: 'charge', error: 0, rechrgM: 0 }, homeFor: 'sent' });
    assert.deepEqual([parked.activity, parked.cleaning, parked.jobOpen, parked.onDock], ['paused', false, true, true]);
    // A robot that doesn't count the minutes: full and still on the dock.
    const full = at('clean', 'charge', { batPct: 100 });
    assert.deepEqual([full.activity, full.cleaning], ['paused', false]);
    // Paused out on the floor is still out.
    assert.deepEqual([at('clean', 'stop').onDock, at('clean', 'stop').cleaning], [false, true]);
    assert.equal(at('none', 'charge').jobOpen, false);
  });

  it('is recharging when it went home to recharge, though an i-series counts 0 minutes', () => {
    const s = at('clean', 'charge', { cleanMissionStatus: { cycle: 'clean', phase: 'charge', error: 0, rechrgM: 0 }, homeFor: 'recharge', batPct: 93 });
    assert.deepEqual([s.activity, s.cleaning], ['recharging', true]);
  });

  it('names the job’s rooms in order, or the whole house, only while it holds a job', () => {
    const rooms = { lastCommand: { command: 'pause' }, jobStart: { command: 'start', regions: [{ region_id: 30 }, { region_id: '2' }] } };
    assert.deepEqual(at('clean', 'run', rooms).jobRooms, ['30', '2']);
    assert.equal(at('clean', 'run', { jobStart: { command: 'start' } }).jobRooms, 'all');
    assert.equal(at('none', 'charge', rooms).jobRooms, null);
  });

  it('leaves out a code iRobot doesn’t list when there’s no job: what’s left of one someone ended', () => {
    assert.equal(statusOf({ cleanMissionStatus: { cycle: 'none', phase: 'charge', error: 236 } })!.error, null);
    assert.equal(statusOf({ cleanMissionStatus: { cycle: 'clean', phase: 'run', error: 236 } })!.error, 'Error 236');
  });

  it('is off once heading home for good, whether sent or finished', () => {
    for (const phase of ['hmUsrDock', 'hmPostMsn']) {
      assert.deepEqual([at('clean', phase).activity, at('clean', phase).cleaning], ['returning', false]);
    }
    assert.equal(at('dock', 'hmUsrDock').cleaning, false);
  });

  it('is docked and off on its dock with no job', () => {
    assert.deepEqual([at('none', 'charge').activity, at('none', 'charge').cleaning], ['docked', false]);
    assert.equal(at('none', 'stop').activity, 'idle');
  });

  it('says what’s wrong when stuck', () => {
    const s = statusOf({ cleanMissionStatus: { cycle: 'clean', phase: 'stuck', error: 17 } })!;
    assert.equal(s.activity, 'stuck');
    assert.equal(s.cleaning, true);
    assert.equal(s.error, 'Path blocked');
    assert.equal(statusOf({ cleanMissionStatus: { cycle: 'clean', phase: 'stuck', error: 999 } })!.error, 'Error 999');
  });

  it('reports battery and a full bin', () => {
    const s = at('none', 'charge', { batPct: 42, bin: { present: true, full: true } });
    assert.equal(s.battery, 42);
    assert.equal(s.binFull, true);
  });

  it('knows nothing until the robot has said what it’s doing', () => {
    assert.equal(statusOf({ batPct: 50 }), null);
  });

  it('keeps what an update leaves out: updates carry only what changed', () => {
    const known: Record<string, unknown> = { batPct: 90, cleanMissionStatus: { cycle: 'none', phase: 'charge', error: 0 } };
    mergeReported(known, { cleanMissionStatus: { phase: 'run', cycle: 'clean' } });
    mergeReported(known, { batPct: 89 });
    assert.deepEqual(known, { batPct: 89, cleanMissionStatus: { cycle: 'clean', phase: 'run', error: 0 } });
  });
});

describe('Roomba commands', () => {
  it('sends the command with the time in seconds, as the iRobot app does locally', () => {
    assert.deepEqual(JSON.parse(commandPayload('dock', 1_700_000_000_999)), { command: 'dock', time: 1_700_000_000, initiator: 'localApp' });
  });
});
