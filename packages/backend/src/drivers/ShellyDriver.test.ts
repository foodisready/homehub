import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ShellyDriver } from './ShellyDriver';

describe('ShellyDriver channels', () => {
  const driver = new ShellyDriver();
  const requests: { url: string; body: string }[] = [];
  let server: http.Server;
  let address: string;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push({ url: req.url ?? '', body });
        const on = (req.url ?? '').includes('turn=on');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ison: on, output: true, is_valid: true, power: 7, voltage: 120 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    address = `127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(() => { server.close(); });
  beforeEach(() => { requests.length = 0; });

  it('uses the first relay by default', async () => {
    await driver.setPower(address, true, { gen: 1 });
    await driver.getPower(address, { gen: 1 });
    assert.deepEqual(requests.map((r) => r.url), ['/relay/0?turn=on', '/relay/0']);
  });

  it('uses the chosen relay on a Gen 1 Shelly', async () => {
    await driver.setPower(address, false, { gen: 1, channel: 1 });
    await driver.getPower(address, { gen: 1, channel: 1 });
    await driver.getEnergy(address, { gen: 1, channel: 1 });
    assert.deepEqual(requests.map((r) => r.url), ['/relay/1?turn=off', '/relay/1', '/meter/1']);
  });

  it('uses the chosen switch on a Gen 2 Shelly', async () => {
    await driver.setPower(address, true, { gen: 2, channel: 1 });
    assert.deepEqual(JSON.parse(requests[0].body), { id: 1, on: true });
  });

  it('falls back to the first relay for a bad channel', async () => {
    await driver.getPower(address, { gen: 1, channel: -1 });
    assert.equal(requests[0].url, '/relay/0');
  });
});

describe('ShellyDriver logins', () => {
  const driver = new ShellyDriver();
  let info: Record<string, unknown>;
  let server: http.Server;
  let address: string;

  before(async () => {
    server = http.createServer((req, res) => {
      res.statusCode = req.url === '/shelly' ? 200 : 404;
      res.end(JSON.stringify(info));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    address = `127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(() => { server.close(); });

  it('flags a device that needs a login', async () => {
    info = { type: 'SHSW-1', auth: true };
    assert.equal((await driver.probe(address))?.needsLogin, true);
  });

  it('does not flag an open device', async () => {
    info = { type: 'SHSW-1', auth: false };
    assert.equal((await driver.probe(address))?.needsLogin, undefined);
  });

  it('does not flag a device when a login is supplied', async () => {
    info = { type: 'SHSW-1', auth: true };
    const result = await driver.probe(address, { auth: { user: 'admin', pass: 'x' } });
    assert.equal(result?.needsLogin, undefined);
  });
});
