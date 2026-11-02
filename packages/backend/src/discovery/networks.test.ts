import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import net from 'node:net';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-networks-test-'));
process.env.DB_PATH = path.join(TMP, 'db.sqlite');

let n: typeof import('./networks');

describe('discovery networks', () => {
  before(async () => { n = await import('./networks'); });
  after(() => fs.rmSync(TMP, { recursive: true, force: true }));

  it('reads the ways people write a home network', () => {
    for (const input of ['192.168.1.x', '192.168.1.*', '192.168.1.0/24', '192.168.1', ' 192.168.1.50 ', '192.168.001.X']) {
      assert.equal(n.parseNetwork(input), '192.168.1', input);
    }
    assert.equal(n.parseNetwork('10.0.0.x'), '10.0.0');
    assert.equal(n.parseNetwork('172.20.3.x'), '172.20.3');
  });

  it('refuses public addresses, wide ranges and nonsense', () => {
    for (const input of ['8.8.8.x', '172.32.0.x', '192.168.1.0/16', '192.168.1.0/25', '192.168.300.x', 'garage', '', '192.168.1.256']) {
      assert.equal(n.parseNetwork(input), null, input);
    }
  });

  it("saves other networks, skipping duplicates and HomeHub's own", () => {
    const own = n.ownNetworks()[0];
    const saved = n.saveExtraNetworks(['192.168.1.x', '192.168.1.0/24', '', ...(own ? [`${own}.x`] : [])]);
    assert.deepEqual(saved, ['192.168.1']);
    assert.deepEqual(n.extraNetworks(), ['192.168.1']);
    assert.ok(n.searchNetworks().includes('192.168.1'));
    assert.ok(!n.suggestedNetworks().includes('192.168.1'));
  });

  it('rejects a bad entry and keeps what was saved', () => {
    n.saveExtraNetworks(['10.0.0.x']);
    assert.throws(() => n.saveExtraNetworks(['8.8.8.x']), /isn't a home network/);
    assert.throws(() => n.saveExtraNetworks(['10.0.0.x', '10.0.1.x', '10.0.2.x', '10.0.3.x', '10.0.4.x']), /up to 4/);
    assert.deepEqual(n.extraNetworks(), ['10.0.0']);
    n.saveExtraNetworks([]);
    assert.deepEqual(n.extraNetworks(), []);
  });

  it('lists the 254 host addresses', () => {
    const hosts = n.hostsOf('192.168.1');
    assert.equal(hosts.length, 254);
    assert.equal(hosts[0], '192.168.1.1');
    assert.equal(hosts[253], '192.168.1.254');
  });

  it('checks whether a port is open', async () => {
    const server = net.createServer((s) => s.end());
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as net.AddressInfo).port;
    assert.equal(await n.isPortOpen('127.0.0.1', port, 1000), true);
    server.close();
    assert.equal(await n.isPortOpen('127.0.0.1', port, 1000), false);
  });
});
