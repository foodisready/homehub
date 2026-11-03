/**
 * homehub.local answers, built and parsed without touching the network.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { addressFor, buildAnswer, homeAddresses, localName, parseQuery, respond } from './local-name';

/** A question as an mDNS client sends it. */
function query(name: string, type = 1, opts: { unicast?: boolean; id?: number } = {}): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(opts.id ?? 0, 0);
  header.writeUInt16BE(1, 4);
  const labels = name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(opts.unicast ? 0x8001 : 1, 2);
  return Buffer.concat([header, ...labels, Buffer.from([0]), tail]);
}

/** The records in a reply (names written out in full, as HomeHub writes them). */
function records(msg: Buffer): { name: string; type: number; cls: number; rdata: Buffer }[] {
  let pos = 12;
  const skipName = () => { while (msg[pos] !== 0) pos += msg[pos] + 1; pos++; };
  for (let i = 0; i < msg.readUInt16BE(4); i++) { skipName(); pos += 4; }
  const out = [];
  const total = msg.readUInt16BE(6) + msg.readUInt16BE(8) + msg.readUInt16BE(10);
  for (let i = 0; i < total; i++) {
    const start = pos;
    skipName();
    const name = parseQuery(Buffer.concat([Buffer.alloc(4), Buffer.from([0, 1, 0, 0, 0, 0, 0, 0]), msg.subarray(start, pos), Buffer.alloc(4)]))!.questions[0].name;
    const type = msg.readUInt16BE(pos), cls = msg.readUInt16BE(pos + 2), len = msg.readUInt16BE(pos + 8);
    out.push({ name, type, cls, rdata: msg.subarray(pos + 10, pos + 10 + len) });
    pos += 10 + len;
  }
  assert.equal(pos, msg.length, 'nothing left over');
  return out;
}

const HOME = [{ address: '10.1.2.88', netmask: '255.255.255.0' }, { address: '192.168.50.5', netmask: '255.255.255.0' }];
const MDNS = { address: '10.1.2.40', port: 5353 };

describe('homehub.local', () => {
  const saved = process.env.HOMEHUB_LOCAL_NAME;
  afterEach(() => {
    if (saved === undefined) delete process.env.HOMEHUB_LOCAL_NAME; else process.env.HOMEHUB_LOCAL_NAME = saved;
  });

  it('answers an A question for its name with the address on the asker\'s network', () => {
    const r = respond(query('HomeHub.local'), MDNS, 'homehub.local', HOME);
    assert.ok(r);
    assert.deepEqual(r.to, { address: '224.0.0.251', port: 5353 });
    assert.equal(r.via, '10.1.2.88');
    // Response + authoritative: the address, then "no other address types" (NSEC).
    assert.equal(r.message.readUInt16BE(2), 0x8400);
    assert.deepEqual([r.message.readUInt16BE(6), r.message.readUInt16BE(10)], [1, 1]);
    const [a, nsec] = records(r.message);
    assert.deepEqual([a.name, a.type, a.cls, [...a.rdata]], ['homehub.local', 1, 0x8001, [10, 1, 2, 88]]);
    assert.deepEqual([nsec.name, nsec.type], ['homehub.local', 47]);

    const other = respond(query('homehub.local'), { address: '192.168.50.9', port: 5353 }, 'homehub.local', HOME);
    assert.equal(other?.via, '192.168.50.5');
  });

  it('tells IPv6 (AAAA) askers there is only an IPv4 address, so they don\'t wait', () => {
    const r = respond(query('homehub.local', 28), MDNS, 'homehub.local', HOME);
    assert.ok(r);
    const [nsec, a] = records(r.message);
    assert.equal(nsec.type, 47, 'answer: NSEC');
    // Next name is homehub.local itself, then window 0, one byte, bit for type A only.
    assert.deepEqual([...nsec.rdata.subarray(-3)], [0, 1, 0x40]);
    assert.equal(nsec.rdata.length, 'homehub.local'.length + 2 + 3);
    assert.deepEqual([a.type, [...a.rdata]], [1, [10, 1, 2, 88]], 'address as additional');
  });

  it('ignores other names, other record types and answers', () => {
    assert.equal(respond(query('printer.local'), MDNS, 'homehub.local', HOME), null);
    assert.equal(respond(query('homehub.local', 16), MDNS, 'homehub.local', HOME), null, 'TXT');
    assert.equal(respond(buildAnswer('homehub.local', '10.1.2.88'), MDNS, 'homehub.local', HOME), null);
    assert.equal(respond(Buffer.from([1, 2, 3]), MDNS, 'homehub.local', HOME), null);
    assert.equal(respond(query('homehub.local'), MDNS, 'homehub.local', []), null, 'no home network');
  });

  it('replies directly to unicast and plain DNS questions', () => {
    const qu = respond(query('homehub.local', 1, { unicast: true }), MDNS, 'homehub.local', HOME);
    assert.deepEqual(qu?.to, MDNS);

    const legacy = respond(query('homehub.local', 1, { id: 0x1234 }), { address: '10.1.2.40', port: 50000 }, 'homehub.local', HOME);
    assert.deepEqual(legacy?.to, { address: '10.1.2.40', port: 50000 });
    assert.equal(legacy?.message.readUInt16BE(0), 0x1234, 'echoes the id');
    assert.equal(legacy?.message.readUInt16BE(4), 1, 'echoes the question');
    assert.deepEqual(records(legacy!.message).map((x) => x.cls), [1, 1], 'plain DNS: no cache-flush bit');
    assert.deepEqual(parseQuery(Buffer.concat([query('x.local')]))?.questions[0].name, 'x.local');
  });

  it('follows name compression in questions', () => {
    // Two questions; the second is "homehub" + pointer to "local" in the first.
    const first = query('printer.local');
    first.writeUInt16BE(2, 4);
    const localAt = 12 + 1 + 'printer'.length;
    const second = Buffer.concat([Buffer.from([7]), Buffer.from('homehub'), Buffer.from([0xc0, localAt]), Buffer.from([0, 1, 0, 1])]);
    const r = respond(Buffer.concat([first, second]), MDNS, 'homehub.local', HOME);
    assert.equal(r?.via, '10.1.2.88');
  });

  it('leaves out Docker, Tailscale and loopback addresses', () => {
    const addrs = homeAddresses({
      lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: null }],
      docker0: [{ address: '172.17.0.1', netmask: '255.255.0.0', family: 'IPv4', mac: '', internal: false, cidr: null }],
      tailscale0: [{ address: '100.101.1.2', netmask: '255.255.255.255', family: 'IPv4', mac: '', internal: false, cidr: null }],
      wlan0: [
        { address: '10.1.2.88', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null },
        { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '', internal: false, cidr: null, scopeid: 3 },
      ],
    });
    assert.deepEqual(addrs, [{ address: '10.1.2.88', netmask: '255.255.255.0' }]);
    assert.equal(addressFor('8.8.8.8', addrs), '10.1.2.88', 'falls back to the first address');
  });

  it('uses HOMEHUB_LOCAL_NAME, and is off without it', () => {
    delete process.env.HOMEHUB_LOCAL_NAME;
    assert.equal(localName(), null);
    process.env.HOMEHUB_LOCAL_NAME = '';
    assert.equal(localName(), null);
    process.env.HOMEHUB_LOCAL_NAME = 'homehub';
    assert.equal(localName(), 'homehub');
    process.env.HOMEHUB_LOCAL_NAME = 'Cabin.local';
    assert.equal(localName(), 'cabin');
    process.env.HOMEHUB_LOCAL_NAME = 'off';
    assert.equal(localName(), null);
    process.env.HOMEHUB_LOCAL_NAME = 'not valid!';
    assert.equal(localName(), null);
  });
});
