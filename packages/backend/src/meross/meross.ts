import crypto from 'crypto';
import net from 'net';
import { getDb } from '../db';

/**
 * Meross devices on the local network.
 *
 * Each message is signed with md5(messageId + key + timestamp). The key comes
 * from the owner's Meross account, so HomeHub signs in to Meross once and keeps
 * only the key, never the password. The same key works for every device on
 * that account.
 *
 * Meross devices end HTTP header lines with a bare LF, which Node's HTTP
 * parser rejects, so requests go over a plain TCP socket.
 */

export class MerossKeyError extends Error {
  constructor() { super('The device rejected the Meross key'); }
}
export class MerossCloudError extends Error {
  constructor(message: string, readonly code?: number) { super(message); }
}

const TIMEOUT_MS = 8000;

export interface MerossReply {
  header: { method: string; namespace: string };
  payload: Record<string, any>;
}

export function buildMessage(namespace: string, method: 'GET' | 'SET', payload: object, key: string, now = Date.now()): string {
  const messageId = crypto.randomBytes(16).toString('hex');
  const timestamp = Math.floor(now / 1000);
  return JSON.stringify({
    header: {
      from: 'MerossClient',
      messageId,
      method,
      namespace,
      payloadVersion: 1,
      sign: crypto.createHash('md5').update(messageId + key + timestamp).digest('hex'),
      timestamp,
      timestampMs: 0,
      triggerSrc: 'MerossClient',
    },
    payload,
  });
}

/** Splits host and port, as stored in devices.ip ("192.168.1.20" or "host:8080"). */
function hostPort(address: string): { host: string; port: number } {
  const m = /^(.*):(\d+)$/.exec(address);
  return m ? { host: m[1], port: Number(m[2]) } : { host: address, port: 80 };
}

/** The JSON body of a raw HTTP response, tolerating LF-only line endings. */
export function parseHttpReply(raw: string): MerossReply {
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(raw);
  if (!status) throw new Error('Not an HTTP reply');
  if (status[1] !== '200') throw new Error(`HTTP ${status[1]}`);
  const split = raw.search(/\r?\n\r?\n/);
  let body = split >= 0 ? raw.slice(split).trim() : '';
  // A chunked reply has a hex length line before the JSON.
  const brace = body.indexOf('{');
  body = brace >= 0 ? body.slice(brace, body.lastIndexOf('}') + 1) : body;
  const reply = JSON.parse(body) as MerossReply;
  if (!reply?.header || !reply.payload) throw new Error('Not a Meross reply');
  return reply;
}

export function request(
  address: string, namespace: string, method: 'GET' | 'SET', payload: object, key: string, timeoutMs = TIMEOUT_MS,
): Promise<MerossReply> {
  const { host, port } = hostPort(address);
  const body = buildMessage(namespace, method, payload, key);
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (err: Error | null, reply?: MerossReply) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err); else resolve(reply!);
    };
    socket.setTimeout(timeoutMs, () => done(new Error(`Meross device at ${address} did not answer`)));
    socket.on('error', (err) => done(err));
    socket.on('connect', () => {
      socket.write(
        `POST /config HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
    socket.on('data', (c) => chunks.push(c));
    socket.on('close', () => {
      try {
        const reply = parseHttpReply(Buffer.concat(chunks).toString('utf8'));
        if (reply.header.method === 'ERROR') {
          const error = reply.payload.error as { code?: number; detail?: string } | undefined;
          if (error?.code === 5001) return done(new MerossKeyError());
          return done(new Error(`Meross error ${error?.code ?? ''}: ${error?.detail ?? 'unknown'}`));
        }
        done(null, reply);
      } catch (err) {
        done(err as Error);
      }
    });
  });
}

// ── Garage door ───────────────────────────────────────────────────

export interface MerossInfo {
  type: string;        // e.g. "msg100"
  uuid: string | null;
  mac: string | null;
  firmware: string | null;
  garageDoors: { channel: number; open: boolean }[];
}

export async function getSystemAll(address: string, key: string, timeoutMs?: number): Promise<MerossInfo> {
  const reply = await request(address, 'Appliance.System.All', 'GET', {}, key, timeoutMs);
  const all = reply.payload.all ?? {};
  const hw = all.system?.hardware ?? {};
  const doors = all.digest?.garageDoor;
  return {
    type: String(hw.type ?? 'meross'),
    uuid: typeof hw.uuid === 'string' ? hw.uuid : null,
    mac: typeof hw.macAddress === 'string' ? hw.macAddress.replace(/[^0-9a-f]/gi, '').toUpperCase() : null,
    firmware: all.system?.firmware?.version != null ? String(all.system.firmware.version) : null,
    garageDoors: Array.isArray(doors)
      ? doors.map((d: { channel?: number; open?: number }) => ({ channel: Number(d.channel ?? 0), open: d.open === 1 }))
      : [],
  };
}

export async function isDoorOpen(address: string, key: string, channel = 0): Promise<boolean> {
  const info = await getSystemAll(address, key);
  const door = info.garageDoors.find((d) => d.channel === channel);
  if (!door) throw new Error(`No garage door on channel ${channel}`);
  return door.open;
}

/** Ask the opener to open (true) or close (false). It ignores a request for the position it's already in. */
export async function moveDoor(address: string, key: string, open: boolean, channel = 0): Promise<void> {
  await request(address, 'Appliance.GarageDoor.State', 'SET', { state: { channel, open: open ? 1 : 0 } }, key);
}

// ── Account key ───────────────────────────────────────────────────

const CLOUD_SECRET = '23x17ahWarFH6w29';
const CLOUD_URL = 'https://iotx-us.meross.com';
const SIGNIN_PATH = '/v1/Auth/signIn';

let cloudCache: { at: number; devices: CloudDevice[] } | null = null;

export function savedKey(): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'meross_key'").get() as { value: string } | undefined;
  return row?.value || null;
}

export function savedEmail(): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'meross_email'").get() as { value: string } | undefined;
  return row?.value || null;
}

const ACCOUNT_SETTINGS = ['meross_email', 'meross_key', 'meross_token', 'meross_domain'];

const setting = (key: string) =>
  (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value || null;

/** Saves the account key, plus the token and server used to read the account's device names. */
export function saveKey(email: string, key: string, cloud?: { token: string; domain: string }): void {
  const upsert = getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  getDb().transaction(() => {
    upsert.run('meross_email', email);
    upsert.run('meross_key', key);
    if (cloud) {
      upsert.run('meross_token', cloud.token);
      upsert.run('meross_domain', cloud.domain);
    }
  })();
  cloudCache = null;
}

export function clearKey(): void {
  getDb().prepare(`DELETE FROM settings WHERE key IN (${ACCOUNT_SETTINGS.map(() => '?').join(', ')})`).run(...ACCOUNT_SETTINGS);
  cloudCache = null;
}

type Fetch = typeof fetch;

export interface MerossAccount { key: string; token: string | null; domain: string }

/**
 * Sign in to the Meross cloud and return the account key, plus the token used
 * to read device names. The password is sent as its MD5, as the Meross app
 * does, and isn't kept.
 */
export async function signIn(email: string, password: string, mfaCode?: string, fetchImpl: Fetch = fetch): Promise<MerossAccount> {
  const data: Record<string, unknown> = {
    email,
    password: crypto.createHash('md5').update(password, 'utf8').digest('hex'),
    encryption: 1,
    agree: 0,
  };
  if (mfaCode) data.mfaCode = mfaCode;
  const params = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');

  let base = CLOUD_URL;
  for (let attempt = 0; attempt < 2; attempt++) {
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sign = crypto.createHash('md5').update(CLOUD_SECRET + timestamp + nonce + params).digest('hex');
    const res = await fetchImpl(base + SIGNIN_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timestamp, nonce, params, sign }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => null) as
      { apiStatus?: number; info?: string; data?: { key?: string; token?: string; domain?: string } } | null;
    if (!json) throw new MerossCloudError(`Meross sign-in failed (HTTP ${res.status})`);

    const status = json.apiStatus ?? 0;
    if (status === 1030 && json.data?.domain) {          // account lives in another region
      base = withScheme(json.data.domain);
      continue;
    }
    if (status === 1033) throw new MerossCloudError('Meross sent you a verification code. Enter it and sign in again.', status);
    if (status === 1032) throw new MerossCloudError('That verification code is wrong.', status);
    if (status !== 0 || !json.data?.key) {
      throw new MerossCloudError(json.info || `Meross rejected the sign-in (code ${status})`, status);
    }
    const domain = json.data.domain ? withScheme(json.data.domain) : base;
    return { key: json.data.key, token: json.data.token || null, domain };
  }
  throw new MerossCloudError('Meross sign-in kept redirecting');
}

const withScheme = (domain: string) => (domain.startsWith('http') ? domain : `https://${domain}`);

// ── Device names from the account ─────────────────────────────────

export interface CloudDevice {
  uuid: string;
  name: string;
  type: string;
  online: boolean;
}

const CLOUD_CACHE_MS = 5 * 60 * 1000;

/** Signs a cloud API call the same way as sign-in. */
async function cloudPost(path: string, data: object, fetchImpl: Fetch): Promise<any> {
  const token = setting('meross_token');
  const domain = setting('meross_domain');
  if (!token || !domain) return null;
  const params = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');
  const sign = crypto.createHash('md5').update(CLOUD_SECRET + timestamp + nonce + params).digest('hex');
  const res = await fetchImpl(domain + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${token}` },
    body: JSON.stringify({ timestamp, nonce, params, sign }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = await res.json().catch(() => null) as { apiStatus?: number; info?: string; data?: unknown } | null;
  if (!json || (json.apiStatus ?? 0) !== 0) {
    throw new MerossCloudError(json?.info || `Meross device list failed (HTTP ${res.status})`, json?.apiStatus);
  }
  return json.data;
}

/**
 * The devices on the Meross account, with the names given in the Meross app.
 * Empty if HomeHub has no token (signed in before names were supported) or
 * Meross can't be reached; names are a convenience, so this never throws.
 */
export async function cloudDevices(fetchImpl: Fetch = fetch): Promise<CloudDevice[]> {
  if (cloudCache && Date.now() - cloudCache.at < CLOUD_CACHE_MS) return cloudCache.devices;
  try {
    const list = await cloudPost('/v1/Device/devList', {}, fetchImpl);
    if (!Array.isArray(list)) return [];
    const devices = list
      .filter((d) => d && typeof d.uuid === 'string')
      .map((d) => ({
        uuid: d.uuid as string,
        name: typeof d.devName === 'string' && d.devName.trim() ? d.devName.trim() : 'Meross device',
        type: String(d.deviceType ?? ''),
        online: d.onlineStatus === 1,
      }));
    cloudCache = { at: Date.now(), devices };
    return devices;
  } catch {
    return [];
  }
}

/** Whether HomeHub can read device names, i.e. it has a token from a recent sign-in. */
export function hasCloudToken(): boolean {
  return setting('meross_token') !== null;
}
