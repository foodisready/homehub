import crypto from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import os from 'node:os';
import type { RealtimeNormalized } from 'tplink-smarthome-api';
import { getDb } from '../db';
import { logger } from '../logger';

/**
 * KLAP: the login-protected connection used by newer Kasa plugs, which no longer
 * answer the open protocol on port 9999. The plug only accepts a session proven
 * with the TP-Link account it was set up on. Once connected, it takes the same
 * JSON commands as older plugs.
 */

const REQUEST_TIMEOUT_MS = 5000;
const DISCOVERY_TIMEOUT_MS = 3000;
const DISCOVERY_PORT = 20002;
// Fixed query from TP-Link's protocol: version, message type and a checksum.
const DISCOVERY_QUERY = Buffer.from('020000010000000000000000463cb5d3', 'hex');
// A session is dropped this long before the plug would expire it.
const SESSION_MARGIN_MS = 20 * 60 * 1000;

export class KlapAuthError extends Error {
  constructor(host: string, detail: string) {
    super(`Kasa login failed for ${host}: ${detail}`);
    this.name = 'KlapAuthError';
  }
}

type LoginVersion = 1 | 2;

/** A login reduced to the hashes the plugs check, so the password itself is never kept. */
export interface KasaLogin {
  username: string;
  hashes: Record<LoginVersion, Buffer>;
}

interface Hashing {
  version: LoginVersion;
  authHash: (username: string, password: string) => Buffer;
  firstProof: (localSeed: Buffer, remoteSeed: Buffer, auth: Buffer) => Buffer;
  secondProof: (localSeed: Buffer, remoteSeed: Buffer, auth: Buffer) => Buffer;
}

const digest = (algorithm: string, ...parts: Buffer[]) =>
  crypto.createHash(algorithm).update(Buffer.concat(parts)).digest();
const text = (value: string) => Buffer.from(value, 'utf8');

// Plugs use one of two versions, and the first handshake reply shows which.
const HASHING: Hashing[] = [
  {
    version: 2,
    authHash: (u, p) => digest('sha256', digest('sha1', text(u)), digest('sha1', text(p))),
    firstProof: (local, remote, auth) => digest('sha256', local, remote, auth),
    secondProof: (local, remote, auth) => digest('sha256', remote, local, auth),
  },
  {
    version: 1,
    authHash: (u, p) => digest('md5', digest('md5', text(u)), digest('md5', text(p))),
    firstProof: (local, _remote, auth) => digest('sha256', local, auth),
    secondProof: (_local, remote, auth) => digest('sha256', remote, auth),
  },
];

class Session {
  private readonly key: Buffer;
  private readonly iv: Buffer;
  private readonly signingKey: Buffer;
  private seq: number;

  constructor(
    readonly cookie: string,
    readonly expiresAt: number,
    localSeed: Buffer,
    remoteSeed: Buffer,
    auth: Buffer,
  ) {
    const seeds = Buffer.concat([localSeed, remoteSeed, auth]);
    this.key = digest('sha256', text('lsk'), seeds).subarray(0, 16);
    const ivAndSeq = digest('sha256', text('iv'), seeds);
    this.iv = ivAndSeq.subarray(0, 12);
    this.seq = ivAndSeq.readInt32BE(28);
    this.signingKey = digest('sha256', text('ldk'), seeds).subarray(0, 28);
  }

  private seqIv(seq: Buffer): Buffer {
    return Buffer.concat([this.iv, seq]);
  }

  encrypt(message: string): { body: Buffer; seq: number } {
    this.seq = (this.seq + 1) | 0;
    const seq = Buffer.alloc(4);
    seq.writeInt32BE(this.seq);
    const cipher = crypto.createCipheriv('aes-128-cbc', this.key, this.seqIv(seq));
    const encrypted = Buffer.concat([cipher.update(text(message)), cipher.final()]);
    const signature = digest('sha256', this.signingKey, seq, encrypted);
    return { body: Buffer.concat([signature, encrypted]), seq: this.seq };
  }

  decrypt(message: Buffer, seqNumber: number): string {
    const seq = Buffer.alloc(4);
    seq.writeInt32BE(seqNumber);
    const decipher = crypto.createDecipheriv('aes-128-cbc', this.key, this.seqIv(seq));
    return Buffer.concat([decipher.update(message.subarray(32)), decipher.final()]).toString('utf8');
  }
}

interface PostResult {
  status: number;
  body: Buffer;
  cookies: string | undefined;
}

// Uses http directly: these plugs answer 400 to the same request sent through fetch.
function post(host: string, path: string, body: Buffer, cookie?: string): Promise<PostResult> {
  const [hostname, port] = host.split(':');
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname,
      port: port ? Number(port) : 80,
      path,
      method: 'POST',
      agent: false,
      timeout: REQUEST_TIMEOUT_MS,
      headers: { 'Content-Length': body.length, ...(cookie ? { Cookie: cookie } : {}) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks),
        cookies: response.headers['set-cookie']?.join(';'),
      }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error(`Timed out reaching ${host}`)));
    request.on('error', reject);
    request.end(body);
  });
}

const USERNAME_KEY = 'kasa_username';
const hashKey = (version: LoginVersion) => `kasa_auth_v${version}`;

export function makeLogin(username: string, password: string): KasaLogin {
  const hashFor = (version: LoginVersion) =>
    HASHING.find((h) => h.version === version)!.authHash(username, password);
  return { username, hashes: { 1: hashFor(1), 2: hashFor(2) } };
}

export function saveLogin(login: KasaLogin): void {
  const upsert = getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  upsert.run(USERNAME_KEY, login.username);
  for (const { version } of HASHING) upsert.run(hashKey(version), login.hashes[version].toString('hex'));
  sessions.clear();
}

export function clearLogin(): void {
  const remove = getDb().prepare('DELETE FROM settings WHERE key = ?');
  remove.run(USERNAME_KEY);
  for (const { version } of HASHING) remove.run(hashKey(version));
  sessions.clear();
}

function loadLogin(): KasaLogin | null {
  const get = getDb().prepare('SELECT value FROM settings WHERE key = ?');
  const read = (key: string) => (get.get(key) as { value: string } | undefined)?.value;
  const username = read(USERNAME_KEY);
  const v1 = read(hashKey(1));
  const v2 = read(hashKey(2));
  if (!username || !v1 || !v2) return null;
  return { username, hashes: { 1: Buffer.from(v1, 'hex'), 2: Buffer.from(v2, 'hex') } };
}

export function savedUsername(): string | null {
  return loadLogin()?.username ?? null;
}

/** Tries a login on a plug without saving it. Throws KlapAuthError if it's refused. */
export async function checkLogin(host: string, login: KasaLogin): Promise<void> {
  await connect(host, login);
}

async function connect(host: string, login: KasaLogin): Promise<Session> {
  const localSeed = crypto.randomBytes(16);

  const first = await post(host, '/app/handshake1', localSeed);
  if (first.status !== 200 || first.body.length !== 48) {
    throw new Error(`Unexpected handshake reply from ${host}: ${first.status}`);
  }
  const remoteSeed = first.body.subarray(0, 16);
  const serverProof = first.body.subarray(16);

  const match = HASHING
    .map((hashing) => ({ hashing, auth: login.hashes[hashing.version] }))
    .find(({ hashing, auth }) => hashing.firstProof(localSeed, remoteSeed, auth).equals(serverProof));
  if (!match) throw new KlapAuthError(host, 'the plug rejected the TP-Link login');

  const sessionId = /TP_SESSIONID=([^;]+)/.exec(first.cookies ?? '')?.[1];
  if (!sessionId) throw new Error(`No session cookie from ${host}`);
  const cookie = `TP_SESSIONID=${sessionId}`;

  const proof = match.hashing.secondProof(localSeed, remoteSeed, match.auth);
  const second = await post(host, '/app/handshake2', proof, cookie);
  if (second.status !== 200) {
    throw new KlapAuthError(host, `the plug refused the session (${second.status})`);
  }

  const lifetimeSeconds = Number(/TIMEOUT=(\d+)/.exec(first.cookies ?? '')?.[1] ?? 86400);
  const expiresAt = Date.now() + lifetimeSeconds * 1000 - SESSION_MARGIN_MS;
  logger.debug({ host, version: match.hashing.version }, 'Kasa login session started');
  return new Session(cookie, expiresAt, localSeed, remoteSeed, match.auth);
}

const sessions = new Map<string, Session>();
// A session's sequence numbers must arrive in order, so each plug takes one request at a time.
const queues = new Map<string, Promise<unknown>>();

async function exchange(host: string, command: string): Promise<string> {
  let session = sessions.get(host);
  if (!session || Date.now() >= session.expiresAt) {
    const login = loadLogin();
    if (!login) throw new KlapAuthError(host, 'no TP-Link login is saved');
    session = await connect(host, login);
    sessions.set(host, session);
  }

  const { body, seq } = session.encrypt(command);
  const reply = await post(host, `/app/request?seq=${seq}`, body, session.cookie);
  if (reply.status !== 200) {
    sessions.delete(host);
    throw new SessionExpired(reply.status);
  }
  return session.decrypt(reply.body, seq);
}

class SessionExpired extends Error {
  constructor(status: number) {
    super(`Kasa session rejected: ${status}`);
  }
}

async function exchangeWithRetry(host: string, command: string): Promise<string> {
  try {
    return await exchange(host, command);
  } catch (err) {
    // The plug drops sessions when it restarts, so log in again once.
    if (err instanceof SessionExpired) return exchange(host, command);
    throw err;
  }
}

function enqueue<T>(host: string, work: () => Promise<T>): Promise<T> {
  const result = (queues.get(host) ?? Promise.resolve()).catch(() => undefined).then(work);
  queues.set(host, result);
  return result;
}

interface ModuleReply {
  err_code?: number;
  [key: string]: unknown;
}

/** Sends one module command, such as `system.get_sysinfo`, and returns its reply. */
async function command(
  host: string,
  module: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<ModuleReply> {
  const raw = await enqueue(host, () =>
    exchangeWithRetry(host, JSON.stringify({ [module]: { [method]: params } })));
  const reply = (JSON.parse(raw) as Record<string, Record<string, ModuleReply>>)[module]?.[method];
  if (!reply) throw new Error(`Empty reply from ${host} for ${module}.${method}`);
  if (reply.err_code) throw new Error(`${host} returned error ${reply.err_code} for ${module}.${method}`);
  return reply;
}

export interface KlapSysInfo {
  alias: string;
  model: string;
  mac: string;
  isOn: boolean;
  hasEmeter: boolean;
}

export async function getSysInfo(host: string): Promise<KlapSysInfo> {
  const info = await command(host, 'system', 'get_sysinfo') as {
    alias?: string; model?: string; mac?: string; relay_state?: number; feature?: string;
  };
  return {
    alias: info.alias ?? '',
    model: (info.model ?? '').trim(),
    mac: normalizeMac(info.mac ?? ''),
    isOn: info.relay_state === 1,
    hasEmeter: (info.feature ?? '').includes('ENE'),
  };
}

export async function setPower(host: string, on: boolean): Promise<void> {
  await command(host, 'system', 'set_relay_state', { state: on ? 1 : 0 });
}

export async function getRealtime(host: string): Promise<RealtimeNormalized> {
  return await command(host, 'emeter', 'get_realtime') as RealtimeNormalized;
}

function normalizeMac(mac: string): string {
  return mac.replace(/[^0-9a-f]/gi, '').toUpperCase();
}

export interface KlapDiscovered {
  ip: string;
  model: string;
  mac: string;
}

/** Reads a discovery reply. Returns null for anything but a Kasa device that needs a login. */
export function parseDiscoveryReply(message: Buffer, ip: string): KlapDiscovered | null {
  try {
    const { result } = JSON.parse(message.subarray(16).toString('utf8')) as {
      result?: {
        device_type?: string;
        device_model?: string;
        mac?: string;
        mgt_encrypt_schm?: { encrypt_type?: string };
      };
    };
    // SMART.* devices are Tapo products, which take different commands.
    if (!result?.device_type?.startsWith('IOT.')) return null;
    if (result.mgt_encrypt_schm?.encrypt_type !== 'KLAP') return null;
    return { ip, model: result.device_model ?? '', mac: normalizeMac(result.mac ?? '') };
  } catch {
    return null;
  }
}

function broadcastAddresses(): string[] {
  const addresses = new Set(['255.255.255.255']);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const ip = entry.address.split('.').map(Number);
      const mask = entry.netmask.split('.').map(Number);
      addresses.add(ip.map((octet, i) => (octet | ~mask[i]) & 255).join('.'));
    }
  }
  return [...addresses];
}

/**
 * Finds plugs that need a login. They don't reply to the older broadcast.
 * `unicast` lists extra addresses to ask one by one, for networks a broadcast
 * can't reach.
 */
export function discoverKlap(timeoutMs = DISCOVERY_TIMEOUT_MS, unicast: string[] = []): Promise<KlapDiscovered[]> {
  return new Promise((resolve) => {
    const found = new Map<string, KlapDiscovered>();
    const socket = dgram.createSocket('udp4');
    let finished = false;
    const timers: NodeJS.Timeout[] = [];

    const finish = () => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      socket.close();
      resolve([...found.values()]);
    };

    socket.on('error', (err) => {
      logger.warn({ err }, 'Kasa login-plug discovery failed');
      finish();
    });
    socket.on('message', (message, remote) => {
      const device = parseDiscoveryReply(message, remote.address);
      if (device) found.set(device.ip, device);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      // Repeat the query: a single UDP packet is easily lost on Wi-Fi.
      for (const delay of [0, 500, 1000]) {
        timers.push(setTimeout(() => {
          for (const address of [...broadcastAddresses(), ...unicast]) {
            socket.send(DISCOVERY_QUERY, DISCOVERY_PORT, address, () => undefined);
          }
        }, delay));
      }
      timers.push(setTimeout(finish, timeoutMs));
    });
  });
}
