import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const TMP_DB = path.join(os.tmpdir(), `homehub-klap-test-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_PATH = TMP_DB;

import { getDb } from '../db';
import {
  KlapAuthError, checkLogin, clearLogin, getSysInfo, makeLogin, parseDiscoveryReply, saveLogin, savedUsername, setPower,
} from './klap';
import { KasaDriver } from '../drivers/KasaDriver';
import { kasaRouter } from '../routes/kasa';

const sha256 = (...parts: Buffer[]) => crypto.createHash('sha256').update(Buffer.concat(parts)).digest();
const sha1 = (value: string) => crypto.createHash('sha1').update(value).digest();
const md5 = (...parts: Buffer[]) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();

const USERNAME = 'owner@example.test';
const PASSWORD = 'plug-password';

/** A plug speaking KLAP, written from the protocol rather than from klap.ts. */
class FakePlug {
  version: 1 | 2 = 2;
  // The login the plug was set up with.
  username = USERNAME;
  password = PASSWORD;
  relay = 0;
  commands: unknown[] = [];
  handshakes = 0;
  rejectNextRequest = false;
  server!: http.Server;
  private sessions = new Map<string, { local: Buffer; remote: Buffer; verified: boolean }>();

  get auth(): Buffer {
    return this.version === 2
      ? sha256(sha1(this.username), sha1(this.password))
      : md5(md5(Buffer.from(this.username)), md5(Buffer.from(this.password)));
  }

  private handleRequest(session: { local: Buffer; remote: Buffer }, seq: number, body: Buffer): Buffer {
    const seeds = Buffer.concat([session.local, session.remote, this.auth]);
    const key = sha256(Buffer.from('lsk'), seeds).subarray(0, 16);
    const iv = sha256(Buffer.from('iv'), seeds).subarray(0, 12);
    const signingKey = sha256(Buffer.from('ldk'), seeds).subarray(0, 28);
    const seqBytes = Buffer.alloc(4);
    seqBytes.writeInt32BE(seq);

    const encrypted = body.subarray(32);
    assert.deepEqual(body.subarray(0, 32), sha256(signingKey, seqBytes, encrypted), 'bad signature');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.concat([iv, seqBytes]));
    const request = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString());
    this.commands.push(request);

    let reply: unknown;
    if (request.system?.set_relay_state) {
      this.relay = request.system.set_relay_state.state;
      reply = { system: { set_relay_state: { err_code: 0 } } };
    } else {
      reply = { system: { get_sysinfo: {
        err_code: 0, alias: 'Statue', model: 'EP10(US)', mac: 'AC:A7:F1:80:50:60',
        relay_state: this.relay, feature: 'TIM',
      } } };
    }
    const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.concat([iv, seqBytes]));
    const out = Buffer.concat([cipher.update(JSON.stringify(reply)), cipher.final()]);
    return Buffer.concat([sha256(signingKey, seqBytes, out), out]);
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const id = /TP_SESSIONID=(\w+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
        const url = new URL(req.url ?? '', 'http://plug');

        if (url.pathname === '/app/handshake1') {
          this.handshakes++;
          const remote = crypto.randomBytes(16);
          const sessionId = crypto.randomBytes(8).toString('hex');
          this.sessions.set(sessionId, { local: body, remote, verified: false });
          const proof = this.version === 2 ? sha256(body, remote, this.auth) : sha256(body, this.auth);
          res.setHeader('Set-Cookie', `TP_SESSIONID=${sessionId};TIMEOUT=86400`);
          return res.end(Buffer.concat([remote, proof]));
        }

        const session = this.sessions.get(id);
        if (!session) { res.statusCode = 403; return res.end(); }

        if (url.pathname === '/app/handshake2') {
          const expected = this.version === 2
            ? sha256(session.remote, session.local, this.auth)
            : sha256(session.remote, this.auth);
          session.verified = expected.equals(body);
          res.statusCode = session.verified ? 200 : 403;
          return res.end();
        }

        if (this.rejectNextRequest || !session.verified) {
          this.rejectNextRequest = false;
          res.statusCode = 403;
          return res.end();
        }
        res.end(this.handleRequest(session, Number(url.searchParams.get('seq')), body));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
}

describe('KLAP plugs', () => {
  const plug = new FakePlug();
  const driver = new KasaDriver();
  let host: string;

  before(async () => { host = await plug.start(); });
  after(() => { plug.server.close(); });
  beforeEach(() => {
    saveLogin(makeLogin(USERNAME, PASSWORD));
    plug.relay = 0;
    plug.commands.length = 0;
  });

  it('reads the plug and switches it through the driver', async () => {
    assert.deepEqual(await getSysInfo(host), {
      alias: 'Statue', model: 'EP10(US)', mac: 'ACA7F1805060', isOn: false, hasEmeter: false,
    });

    await driver.setPower(host, true, { protocol: 'klap' });
    assert.equal(plug.relay, 1);
    assert.equal(await driver.getPower(host, { protocol: 'klap' }), true);

    await driver.setPower(host, false, { protocol: 'klap' });
    assert.equal(plug.relay, 0);
    assert.equal(await driver.getEnergy(host, { protocol: 'klap' }), null);
  });

  it('reuses one login for later commands', async () => {
    await getSysInfo(host);
    const before = plug.handshakes;
    await getSysInfo(host);
    await setPower(host, true);
    assert.equal(plug.handshakes, before);
  });

  it('keeps commands in order when they overlap', async () => {
    await Promise.all([setPower(host, true), getSysInfo(host), setPower(host, false), getSysInfo(host)]);
    assert.equal(plug.commands.length, 4);
    assert.equal(plug.relay, 0);
  });

  it('logs in again when the plug drops the session', async () => {
    await getSysInfo(host);
    const before = plug.handshakes;
    plug.rejectNextRequest = true;
    assert.equal((await getSysInfo(host)).alias, 'Statue');
    assert.equal(plug.handshakes, before + 1);
  });

  it('supports the older login version', async () => {
    const older = new FakePlug();
    older.version = 1;
    const olderHost = await older.start();
    await setPower(olderHost, true);
    assert.equal(older.relay, 1);
    older.server.close();
  });

  it('reports a wrong password as a login failure', async () => {
    const other = new FakePlug();
    const otherHost = await other.start();
    saveLogin(makeLogin(USERNAME, 'wrong'));
    await assert.rejects(getSysInfo(otherHost), KlapAuthError);
    other.server.close();
  });

  it('reaches a plug not yet linked to an account, with TP-Link\'s setup login', async () => {
    // From the Pi, 2026-11-13: a new EP10 refused the account login that another plug accepted.
    const fresh = new FakePlug();
    fresh.username = 'kasa@tp-link.net';
    fresh.password = 'kasaSetup';
    const freshHost = await fresh.start();
    assert.equal((await getSysInfo(freshHost)).model, 'EP10(US)');
    fresh.server.close();
  });

  it('reaches a plug with no login at all', async () => {
    const fresh = new FakePlug();
    fresh.username = '';
    fresh.password = '';
    fresh.version = 1;
    const freshHost = await fresh.start();
    await setPower(freshHost, true);
    assert.equal(fresh.relay, 1);
    fresh.server.close();
  });

  it('never saves a default login as the account\'s', async () => {
    const fresh = new FakePlug();
    fresh.username = 'kasa@tp-link.net';
    fresh.password = 'kasaSetup';
    const freshHost = await fresh.start();
    await assert.rejects(checkLogin(freshHost, makeLogin(USERNAME, PASSWORD)), KlapAuthError);
    fresh.server.close();
  });

  it('reports a missing login, after trying the setup logins', async () => {
    const other = new FakePlug();
    const otherHost = await other.start();
    clearLogin();
    await assert.rejects(getSysInfo(otherHost), /no TP-Link login/);
    assert.equal(other.handshakes, 1, 'one handshake shows whether a setup login works');
    other.server.close();
  });

  it('reaches a plug not yet linked to an account even with no login saved', async () => {
    const fresh = new FakePlug();
    fresh.username = 'kasa@tp-link.net';
    fresh.password = 'kasaSetup';
    const freshHost = await fresh.start();
    clearLogin();
    assert.equal((await getSysInfo(freshHost)).model, 'EP10(US)');
    fresh.server.close();
  });

  it('stores hashes, never the password', () => {
    const stored = JSON.stringify(getDb().prepare('SELECT * FROM settings').all());
    assert.ok(stored.includes(USERNAME));
    assert.ok(!stored.includes(PASSWORD));
  });

  it('can check a login without saving it', async () => {
    clearLogin();
    await checkLogin(host, makeLogin(USERNAME, PASSWORD));
    await assert.rejects(checkLogin(host, makeLogin(USERNAME, 'wrong')), KlapAuthError);
    assert.equal(savedUsername(), null);
  });

  it('forgets an open session when the login changes', async () => {
    await getSysInfo(host);
    saveLogin(makeLogin(USERNAME, 'wrong'));
    await assert.rejects(getSysInfo(host), KlapAuthError);
  });
});

describe('/api/kasa/login', () => {
  const plug = new FakePlug();
  let server: http.Server;
  let baseUrl: string;

  const put = (body: unknown) => fetch(`${baseUrl}/login`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  before(async () => {
    const host = await plug.start();
    getDb().prepare(
      "INSERT INTO devices (alias, ip, driver_type, driver_config) VALUES ('Login plug', ?, 'kasa', ?)",
    ).run(host, JSON.stringify({ protocol: 'klap' }));

    const app = express();
    app.use(express.json());
    app.use(kasaRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => {
    server.close();
    plug.server.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TMP_DB + suffix, { force: true });
  });
  beforeEach(() => clearLogin());

  it('saves a login the plug accepts', async () => {
    const response = await put({ username: ` ${USERNAME} `, password: PASSWORD });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { username: USERNAME, verified: true });
    assert.equal(savedUsername(), USERNAME);
  });

  it('does not save a login the plug rejects', async () => {
    const response = await put({ username: USERNAME, password: 'wrong' });
    assert.equal(response.status, 422);
    assert.equal(savedUsername(), null);
  });

  it('requires both fields', async () => {
    assert.equal((await put({ username: USERNAME })).status, 400);
    assert.equal((await put({ password: PASSWORD })).status, 400);
  });

  it('shows the email but never the password', async () => {
    await put({ username: USERNAME, password: PASSWORD });
    const body = await (await fetch(`${baseUrl}/login`)).text();
    assert.equal(body, JSON.stringify({ username: USERNAME }));
  });

  it('forgets the login', async () => {
    await put({ username: USERNAME, password: PASSWORD });
    assert.equal((await fetch(`${baseUrl}/login`, { method: 'DELETE' })).status, 204);
    assert.equal(savedUsername(), null);
  });
});

describe('parseDiscoveryReply', () => {
  const reply = (result: unknown) => Buffer.concat([Buffer.alloc(16), Buffer.from(JSON.stringify({ result }))]);

  it('accepts a Kasa plug that needs a login', () => {
    assert.deepEqual(parseDiscoveryReply(reply({
      device_type: 'IOT.SMARTPLUGSWITCH', device_model: 'EP10(US)', mac: 'AC-A7-F1-80-50-60',
      mgt_encrypt_schm: { encrypt_type: 'KLAP' },
    }), '192.0.2.1'), { ip: '192.0.2.1', model: 'EP10(US)', mac: 'ACA7F1805060' });
  });

  it('ignores Tapo devices, which take different commands', () => {
    assert.equal(parseDiscoveryReply(reply({
      device_type: 'SMART.TAPOPLUG', mgt_encrypt_schm: { encrypt_type: 'KLAP' },
    }), '192.0.2.1'), null);
  });

  it('ignores plugs on the open protocol', () => {
    assert.equal(parseDiscoveryReply(reply({
      device_type: 'IOT.SMARTPLUGSWITCH', mgt_encrypt_schm: { encrypt_type: 'XOR' },
    }), '192.0.2.1'), null);
  });

  it('ignores a malformed reply', () => {
    assert.equal(parseDiscoveryReply(Buffer.from('nonsense'), '192.0.2.1'), null);
  });
});
