import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-meross-test-'));
process.env.DB_PATH = path.join(TMP, 'db.sqlite');

let m: typeof import('./meross');

const KEY = 'account-key';

/** A fake MSG100: checks the signature and replies with LF-only headers, like the real one. */
function fakeOpener() {
  const state = { open: 0, requests: [] as any[] };
  const server = net.createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
      const split = data.indexOf('\r\n\r\n');
      if (split < 0) return;
      const len = Number(/Content-Length: (\d+)/i.exec(data)?.[1] ?? 0);
      if (Buffer.byteLength(data.slice(split + 4)) < len) return;
      const msg = JSON.parse(data.slice(split + 4));
      state.requests.push(msg);
      const h = msg.header;
      const good = h.sign === crypto.createHash('md5').update(h.messageId + KEY + h.timestamp).digest('hex');
      let reply: object;
      if (!good) {
        reply = { header: { method: 'ERROR', namespace: h.namespace }, payload: { error: { code: 5001, detail: 'sign error' } } };
      } else if (h.namespace === 'Appliance.System.All') {
        reply = {
          header: { method: 'GETACK', namespace: h.namespace },
          payload: { all: {
            system: { hardware: { type: 'msg100', uuid: 'abc123', macAddress: '48:e1:e9:00:11:22' }, firmware: { version: '3.2.7' } },
            digest: { garageDoor: [{ channel: 0, open: state.open, lmTime: 0 }] },
          } },
        };
      } else {
        state.open = msg.payload.state.open;
        reply = { header: { method: 'SETACK', namespace: h.namespace }, payload: { state: { channel: 0, open: state.open, execute: 1 } } };
      }
      const body = JSON.stringify(reply);
      socket.end(`HTTP/1.1 200 OK\nContent-Type: application/json\nContent-Length: ${Buffer.byteLength(body)}\n\n${body}`);
    });
  });
  return { server, state };
}

describe('Meross', () => {
  const opener = fakeOpener();
  let address = '';

  before(async () => {
    m = await import('./meross');
    await new Promise<void>((ok) => opener.server.listen(0, '127.0.0.1', ok));
    address = `127.0.0.1:${(opener.server.address() as net.AddressInfo).port}`;
  });

  after(() => {
    opener.server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('signs messages with md5(messageId + key + timestamp)', () => {
    const msg = JSON.parse(m.buildMessage('Appliance.System.All', 'GET', {}, 'k', 1_700_000_000_500));
    assert.equal(msg.header.timestamp, 1_700_000_000);
    assert.equal(msg.header.sign, crypto.createHash('md5').update(`${msg.header.messageId}k1700000000`).digest('hex'));
    assert.match(msg.header.messageId, /^[0-9a-f]{32}$/);
  });

  it('reads replies with LF-only headers', () => {
    const reply = m.parseHttpReply('HTTP/1.1 200 OK\nContent-Type: application/json\n\n{"header":{"method":"GETACK","namespace":"x"},"payload":{}}');
    assert.equal(reply.header.method, 'GETACK');
  });

  it('reads the device and the door state', async () => {
    const info = await m.getSystemAll(address, KEY);
    assert.deepEqual(info, { type: 'msg100', uuid: 'abc123', mac: '48E1E9001122', firmware: '3.2.7', garageDoors: [{ channel: 0, open: false }] });
  });

  it('opens and closes the door', async () => {
    await m.moveDoor(address, KEY, true);
    assert.deepEqual(opener.state.requests.at(-1).payload, { state: { channel: 0, open: 1 } });
    assert.equal(opener.state.requests.at(-1).header.method, 'SET');
    assert.equal(await m.isDoorOpen(address, KEY), true);
    await m.moveDoor(address, KEY, false);
    assert.equal(await m.isDoorOpen(address, KEY), false);
  });

  it('reports a wrong key', async () => {
    await assert.rejects(m.getSystemAll(address, 'wrong'), m.MerossKeyError);
  });

  it('fails when nothing answers', async () => {
    await assert.rejects(m.getSystemAll('127.0.0.1:1', KEY));
  });

  describe('sign-in', () => {
    const reply = (body: object) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

    it('sends a signed request with the hashed password and returns the key', async () => {
      let sent: any;
      let url = '';
      const key = await m.signIn('me@example.com', 'pw', undefined, ((u: string, init: RequestInit) => {
        url = u;
        sent = JSON.parse(String(init.body));
        return reply({ apiStatus: 0, data: { key: 'the-key', token: 't', domain: 'iotx-eu.meross.com' } });
      }) as typeof fetch);
      assert.deepEqual(key, { key: 'the-key', token: 't', domain: 'https://iotx-eu.meross.com' });
      assert.equal(url, 'https://iotx-us.meross.com/v1/Auth/signIn');
      const params = JSON.parse(Buffer.from(sent.params, 'base64').toString());
      assert.equal(params.password, crypto.createHash('md5').update('pw').digest('hex'));
      assert.equal(sent.sign, crypto.createHash('md5').update(`23x17ahWarFH6w29${sent.timestamp}${sent.nonce}${sent.params}`).digest('hex'));
    });

    it('follows a redirect to another region', async () => {
      const urls: string[] = [];
      const key = await m.signIn('me@example.com', 'pw', undefined, ((u: string) => {
        urls.push(u);
        return urls.length === 1
          ? reply({ apiStatus: 1030, data: { domain: 'https://iotx-eu.meross.com' } })
          : reply({ apiStatus: 0, data: { key: 'eu-key' } });
      }) as typeof fetch);
      assert.deepEqual(key, { key: 'eu-key', token: null, domain: 'https://iotx-eu.meross.com' });
      assert.equal(urls[1], 'https://iotx-eu.meross.com/v1/Auth/signIn');
    });

    it('asks for a verification code', async () => {
      await assert.rejects(
        m.signIn('me@example.com', 'pw', undefined, (() => reply({ apiStatus: 1033, data: {} })) as typeof fetch),
        (err: any) => err instanceof m.MerossCloudError && err.code === 1033,
      );
    });

    it("passes on Meross's reason for a rejection", async () => {
      await assert.rejects(
        m.signIn('x@example.com', 'pw', undefined, (() => reply({ apiStatus: 1008, info: 'Email unregistered', data: {} })) as typeof fetch),
        /Email unregistered/,
      );
    });
  });

  describe('device names', () => {
    const list = (body: object, seen?: (url: string, init: RequestInit) => void) => ((url: string, init: RequestInit) => {
      seen?.(url, init);
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as typeof fetch;

    it('returns nothing without a token from sign-in', async () => {
      m.saveKey('me@example.com', 'k1');
      assert.equal(m.hasCloudToken(), false);
      assert.deepEqual(await m.cloudDevices(list({ apiStatus: 0, data: [{ uuid: 'u' }] })), []);
    });

    it('reads names from the account with the saved token', async () => {
      m.saveKey('me@example.com', 'k1', { token: 'tok', domain: 'https://iotx-us.meross.com' });
      let url = '';
      let auth = '';
      const devices = await m.cloudDevices(list(
        { apiStatus: 0, data: [{ uuid: 'u1', devName: 'Garage Door', deviceType: 'msg100', onlineStatus: 1 }, { devName: 'no uuid' }] },
        (u, init) => { url = u; auth = (init.headers as Record<string, string>).Authorization; },
      ));
      assert.equal(url, 'https://iotx-us.meross.com/v1/Device/devList');
      assert.equal(auth, 'Basic tok');
      assert.deepEqual(devices, [{ uuid: 'u1', name: 'Garage Door', type: 'msg100', online: true }]);
    });

    it('keeps names for a few minutes, and forgets them on sign-out', async () => {
      const again = await m.cloudDevices(list({ apiStatus: 0, data: [] }));
      assert.equal(again.length, 1, 'cached');
      m.clearKey();
      assert.equal(m.hasCloudToken(), false);
    });

    it('gives up quietly when Meross refuses', async () => {
      m.saveKey('me@example.com', 'k1', { token: 'old', domain: 'https://iotx-us.meross.com' });
      assert.deepEqual(await m.cloudDevices(list({ apiStatus: 1022, info: 'token expired' })), []);
      m.clearKey();
    });
  });

  it('stores only the email and key', () => {
    m.saveKey('me@example.com', 'k1');
    assert.equal(m.savedKey(), 'k1');
    assert.equal(m.savedEmail(), 'me@example.com');
    m.clearKey();
    assert.equal(m.savedKey(), null);
  });
});
