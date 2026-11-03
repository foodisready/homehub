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
    // Header: response + authoritative, one answer; then the record ending in the address.
    assert.equal(r.message.readUInt16BE(2), 0x8400);
    assert.equal(r.message.readUInt16BE(6), 1);
    assert.deepEqual([...r.message.subarray(-4)], [10, 1, 2, 88]);
    assert.equal(r.message.readUInt16BE(r.message.length - 14), 1, 'type A');
    assert.equal(r.message.readUInt16BE(r.message.length - 12), 0x8001, 'cache-flush, IN');

    const other = respond(query('homehub.local'), { address: '192.168.50.9', port: 5353 }, 'homehub.local', HOME);
    assert.equal(other?.via, '192.168.50.5');
  });

  it('ignores other names, other record types and answers', () => {
    assert.equal(respond(query('printer.local'), MDNS, 'homehub.local', HOME), null);
    assert.equal(respond(query('homehub.local', 28), MDNS, 'homehub.local', HOME), null, 'AAAA');
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
