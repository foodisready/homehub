import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger';
import { signInDir, signInSavedAt } from './bridge';

/**
 * HomeHub's own connection to the Wyze cloud, for what the camera bridge
 * can't do: pausing and resuming a camera (Wyze's power off and on, the same
 * switch as in the Wyze app; a Pan also tucks its lens away).
 *
 * It uses the Wyze sign-in saved for the bridge, and keeps its own login
 * token next to it (`homehub-auth.json`, 0600), so it signs in once and then
 * refreshes the token rather than signing in again. Wyze limits sign-ins.
 *
 * The requests follow the Wyze app's own API, as docker-wyze-bridge uses it.
 */

const AUTH_API = () => (process.env.WYZE_AUTH_URL || 'https://auth-prod.api.wyze.com').replace(/\/+$/, '');
const WYZE_API = () => (process.env.WYZE_API_URL || 'https://api.wyzecam.com/app').replace(/\/+$/, '');

const APP_VERSION = '3.6.5.5';
const IOS_VERSION = '17.7.2';
const SC_SV: Record<string, [string, string]> = {
  default: ['9f275790cab94a72bd206c8876429f3c', 'e1fe392906d54888a9b99b88de4162d7'],
  run_action: ['01dd431d098546f9baf5233724fa2ee2', '2c0edc06d4c5465b8c55af207144f0d9'],
  get_device_Info: ['01dd431d098546f9baf5233724fa2ee2', '0bc2c3bedf6c4be688754c9ad42bbf2e'],
};
/** A token lasts about a day; refresh well before. */
const TOKEN_LIFE_MS = 20 * 60 * 60 * 1000;
/** After a failed sign-in, wait before trying again, so Wyze doesn't lock the account. */
const LOGIN_BACKOFF_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 15_000;

export class WyzeCloudError extends Error {
  constructor(message: string, readonly status = 502, readonly code?: string) { super(message); }
}

interface Auth { accessToken: string; refreshToken: string; phoneId: string; at: number; signIn: number }

let auth: Auth | null = null;
let lastFailedLogin = 0;
let pending: Promise<Auth> | null = null;

const authFile = () => process.env.WYZE_AUTH_FILE || path.join(signInDir(), 'homehub-auth.json');

/** What Wyze last said about requests left (X-RateLimit-Remaining), and when. */
let requestsLeft: { count: number; at: number } | null = null;

/** Requests Wyze says are left, if it said so in the last 10 minutes. */
export function wyzeRequestsLeft(now = Date.now()): number | null {
  return requestsLeft && now - requestsLeft.at < 10 * 60_000 ? requestsLeft.count : null;
}

/** For tests. */
export function resetCloud(): void { auth = null; lastFailedLogin = 0; pending = null; requestsLeft = null; }

function readLogin(): { email: string; password: string; keyId: string; apiKey: string } {
  const dir = signInDir();
  const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8').trim();
  try {
    return { email: read('email'), password: read('password'), keyId: read('key-id'), apiKey: read('api-key') };
  } catch {
    throw new WyzeCloudError('Sign in to Wyze on the Cameras page first.', 409, 'SIGNED_OUT');
  }
}

function loadSaved(signIn: number): Auth | null {
  try {
    const saved = JSON.parse(fs.readFileSync(authFile(), 'utf8')) as Auth;
    return saved.signIn === signIn && saved.accessToken ? saved : null;
  } catch {
    return null;
  }
}

function save(a: Auth): void {
  try {
    fs.writeFileSync(`${authFile()}.tmp`, JSON.stringify(a), { mode: 0o600 });
    fs.renameSync(`${authFile()}.tmp`, authFile());
  } catch (err) {
    logger.warn({ reason: (err as Error).message }, 'Could not save the Wyze token');
  }
}

/** Wyze's password hashing: MD5, three times. */
export function hashPassword(password: string): string {
  let out = password.trim();
  for (let i = 0; i < 3; i++) out = crypto.createHash('md5').update(out).digest('hex');
  return out;
}

const appHeaders = () => ({ 'user-agent': `Wyze/${APP_VERSION} (iPhone; iOS ${IOS_VERSION}; Scale/3.00)`, appversion: APP_VERSION, env: 'prod', 'content-type': 'application/json' });

function payload(a: Auth, endpoint: string): Record<string, unknown> {
  const [sc, sv] = SC_SV[endpoint] ?? SC_SV.default;
  return {
    sc, sv,
    app_ver: `com.hualai.WyzeCam___${APP_VERSION}`, app_version: APP_VERSION, app_name: 'com.hualai.WyzeCam',
    phone_system_type: 1, ts: Date.now(), access_token: a.accessToken, phone_id: a.phoneId,
  };
}

/** Wyze answers 200 with its own code: "1" or "0" is fine, "2001" an expired token. */
async function post(url: string, body: unknown, headers: Record<string, string>): Promise<Record<string, any>> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new WyzeCloudError(`Couldn't reach Wyze: ${(err as Error).message}`, 503, 'UNREACHABLE');
  }
  // Wyze counts requests per account. A low count isn't a failure, but the motion watch slows down for it.
  const remaining = res.headers.has('x-ratelimit-remaining') ? Number(res.headers.get('x-ratelimit-remaining')) : NaN;
  if (Number.isFinite(remaining)) requestsLeft = { count: remaining, at: Date.now() };
  if (res.status === 429) {
    requestsLeft = { count: 0, at: Date.now() };
    throw new WyzeCloudError('Wyze is limiting requests for now. Try again in a few minutes.', 429, 'RATE_LIMITED');
  }
  let json: Record<string, any>;
  try { json = (await res.json()) as Record<string, any>; } catch { throw new WyzeCloudError(`Wyze answered HTTP ${res.status}`); }
  const code = String(json.code ?? json.errorCode ?? (res.ok ? 0 : res.status));
  if (code === '2001') throw new WyzeCloudError('Wyze token expired', 401, 'TOKEN_EXPIRED');
  if (code !== '1' && code !== '0') {
    const msg = String(json.msg ?? json.description ?? code);
    throw new WyzeCloudError(/invalid credentials|1000/i.test(`${code} ${msg}`) ? 'Wyze didn\'t accept the saved sign-in. Sign in again on the Cameras page.' : `Wyze: ${msg}`, 502, code);
  }
  return (json.data ?? json) as Record<string, any>;
}

async function login(signIn: number): Promise<Auth> {
  if (Date.now() - lastFailedLogin < LOGIN_BACKOFF_MS) {
    throw new WyzeCloudError('Wyze sign-in failed a moment ago. Try again in a few minutes.', 429, 'BACKOFF');
  }
  const creds = readLogin();
  const phoneId = crypto.randomUUID();
  try {
    const r = await post(`${AUTH_API()}/api/user/login`, { email: creds.email, password: hashPassword(creds.password) }, {
      'content-type': 'application/json', apikey: creds.apiKey, keyid: creds.keyId, 'user-agent': 'homehub', 'phone-id': phoneId,
    });
    if (!r.access_token) {
      throw new WyzeCloudError(r.mfa_options ? 'Your Wyze account asks for a verification code, which HomeHub can\'t enter yet.' : 'Wyze sign-in failed.', 422, 'LOGIN_FAILED');
    }
    logger.info('Signed in to Wyze for camera control');
    return { accessToken: r.access_token, refreshToken: r.refresh_token ?? '', phoneId, at: Date.now(), signIn };
  } catch (err) {
    lastFailedLogin = Date.now();
    throw err;
  }
}

async function refresh(a: Auth): Promise<Auth> {
  const r = await post(`${WYZE_API()}/user/refresh_token`, { ...payload(a, 'default'), refresh_token: a.refreshToken }, appHeaders());
  if (!r.access_token) throw new WyzeCloudError('Wyze token refresh failed', 401, 'TOKEN_EXPIRED');
  return { ...a, accessToken: r.access_token, refreshToken: r.refresh_token ?? a.refreshToken, at: Date.now() };
}

/** A working token: the saved one, refreshed, or a new sign-in, in that order. */
async function token(forceNew = false): Promise<Auth> {
  const signIn = signInSavedAt();
  if (signIn === null) throw new WyzeCloudError('Sign in to Wyze on the Cameras page first.', 409, 'SIGNED_OUT');
  if (auth?.signIn !== signIn) auth = loadSaved(signIn);
  if (auth && !forceNew && Date.now() - auth.at < TOKEN_LIFE_MS) return auth;
  // One sign-in or refresh at a time, however many cameras ask at once.
  pending ??= (async () => {
    let next: Auth | null = null;
    if (auth?.refreshToken) {
      try { next = await refresh(auth); } catch (err) { logger.info({ reason: (err as Error).message }, 'Wyze token refresh failed; signing in again'); }
    }
    next ??= await login(signIn);
    auth = next;
    save(next);
    return next;
  })().finally(() => { pending = null; });
  return pending;
}

/** Calls Wyze with a token, getting a new one once if it has expired. */
async function call(endpoint: string, url: string, params: Record<string, unknown>): Promise<Record<string, any>> {
  const a = await token();
  try {
    return await post(url, { ...params, ...payload(a, endpoint) }, appHeaders());
  } catch (err) {
    if (!(err instanceof WyzeCloudError) || err.code !== 'TOKEN_EXPIRED') throw err;
    const fresh = await token(true);
    return post(url, { ...params, ...payload(fresh, endpoint) }, appHeaders());
  }
}

export interface CloudCamera { mac: string; model: string }

// ── Events (motion) ───────────────────────────────────────────────

const CLOUD_API = () => (process.env.WYZE_CLOUD_URL || 'https://app-core.cloud.wyze.com/app').replace(/\/+$/, '');
/** Event pictures are only fetched from addresses like this. Tests point it at a local server. */
const imagePrefix = () => process.env.WYZE_IMAGE_URL_PREFIX || 'https://';
const APP_ID = '9319141212m2ik';
const APP_SECRET = 'wyze_app_secret_key_132';

/** JSON with keys sorted at every level, as Wyze signs it (Python's json.dumps(sort_keys=True)). */
export function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${sortedJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Wyze's v4 request signature: HMAC-MD5 of the body, keyed by md5(token + app secret) in hex. */
export function signBody(body: string, accessToken: string): string {
  const key = crypto.createHash('md5').update(accessToken + APP_SECRET).digest('hex');
  return crypto.createHmac('md5', key).update(body).digest('hex');
}

function signedHeaders(a: Auth, body: string): Record<string, string> {
  return {
    'content-type': 'application/json', phoneid: a.phoneId,
    'user-agent': `wyze_ios_${APP_VERSION}`, appinfo: `wyze_ios_${APP_VERSION}`, appversion: APP_VERSION,
    access_token: a.accessToken, appid: APP_ID, env: 'prod', signature2: signBody(body, a.accessToken),
  };
}

export interface WyzeEvent {
  id: string;
  /** The camera's hardware address, as the bridge and HomeHub store it. */
  mac: string;
  /** When it happened, ms since the epoch. */
  at: number;
  /** Wyze's picture of the moment, if it has one. */
  imageUrl: string | null;
  /** Wyze's event kind (`event_value`): "2" is sound alone. */
  kind: string;
  /** What Wyze's detection saw: 101 a person, 102 a vehicle, 103 a pet, 104 a package. */
  tags: number[];
}

/**
 * The account's camera events (motion, sound and the like) from `since`,
 * newest first, at most 20. Uses the request docker-wyze-bridge 2.x made for
 * its motion snapshots: signed, and without the app fields other calls carry.
 */
export async function getEvents(macs: string[], since: number, now = Date.now()): Promise<WyzeEvent[]> {
  if (!macs.length) return [];
  const send = async (a: Auth) => {
    const body = sortedJson({
      count: 20, order_by: 1, begin_time: since, end_time: now + 60_000, nonce: String(Date.now()),
      device_id_list: [...new Set(macs)], event_value_list: [], event_tag_list: [],
    });
    return post(`${CLOUD_API()}/v4/device/get_event_list`, body, signedHeaders(a, body));
  };
  let r: Record<string, any>;
  try {
    r = await send(await token());
  } catch (err) {
    if (!(err instanceof WyzeCloudError) || err.code !== 'TOKEN_EXPIRED') throw err;
    r = await send(await token(true));
  }
  const list = Array.isArray(r.event_list) ? (r.event_list as Record<string, any>[]) : [];
  return list.flatMap((e) => {
    const id = e.event_id != null ? String(e.event_id) : '';
    const mac = typeof e.device_id === 'string' ? e.device_id : typeof e.device_mac === 'string' ? e.device_mac : '';
    const at = Number(e.event_ts);
    if (!id || !mac || !Number.isFinite(at)) return [];
    const files = Array.isArray(e.file_list) ? (e.file_list as Record<string, any>[]) : [];
    const image = files.find((f) => Number(f.type) === 1 && typeof f.url === 'string' && f.url.startsWith(imagePrefix()));
    const tags = Array.isArray(e.tag_list) ? (e.tag_list as unknown[]).map(Number).filter(Number.isFinite) : [];
    return [{ id, mac: mac.replace(/[^0-9a-f]/gi, '').toUpperCase(), at, imageUrl: image?.url ?? null, kind: String(e.event_value ?? ''), tags }];
  });
}

/** Turns a camera on (watching) or off (paused), like its switch in the Wyze app. */
export async function setCameraPower(cam: CloudCamera, on: boolean): Promise<void> {
  await call('run_action', `${WYZE_API()}/v2/auto/run_action`, {
    action_params: {}, action_key: on ? 'power_on' : 'power_off', instance_id: cam.mac, provider_key: cam.model, custom_string: '',
  });
  logger.info({ mac: cam.mac, on }, on ? 'Camera resumed through Wyze' : 'Camera paused through Wyze');
}

/** Whether the camera is on, per Wyze (property P3). */
export async function getCameraPower(cam: CloudCamera): Promise<boolean> {
  const r = await call('get_device_Info', `${WYZE_API()}/v2/device/get_device_Info`, { device_mac: cam.mac, device_model: cam.model });
  const list = Array.isArray(r.property_list) ? r.property_list as { pid?: string; value?: unknown }[] : [];
  const p3 = list.find((p) => p.pid === 'P3');
  if (!p3) throw new WyzeCloudError('Wyze didn\'t say whether the camera is on');
  return String(p3.value) === '1';
}
