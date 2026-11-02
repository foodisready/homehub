import { logger } from '../logger';

/**
 * Client for docker-wyze-bridge (mrlt8/wyze-bridge), which connects to Wyze
 * cameras with the owner's Wyze account and serves their video locally.
 *
 * The bridge's ports are bound to localhost in docker-compose.yml, so only
 * HomeHub reaches it. HomeHub authenticates with a shared API key
 * (WYZE_BRIDGE_API_KEY here, WB_API in the bridge), sent in the `api` header.
 *
 * The Wyze sign-in is passed through to the bridge's /login and never stored
 * by HomeHub. The bridge keeps its own tokens in its /tokens volume.
 */

const TIMEOUT_MS = 10_000;
const SNAPSHOT_TIMEOUT_MS = 20_000;

export const bridgeUrl = () => (process.env.WYZE_BRIDGE_URL || 'http://127.0.0.1:5050').replace(/\/+$/, '');
export const hlsUrl = () => (process.env.WYZE_BRIDGE_HLS_URL || 'http://127.0.0.1:8888').replace(/\/+$/, '');
const apiKey = () => process.env.WYZE_BRIDGE_API_KEY || '';

export class BridgeError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

export interface BridgeCamera {
  /** The bridge's URI name, e.g. "front-door". Stable while the Wyze name stays the same. */
  id: string;
  name: string;
  model: string | null;
  modelName: string | null;
  ip: string | null;
  mac: string | null;
  /** The bridge has a live stream from the camera. */
  connected: boolean;
  enabled: boolean;
  /** Motion in the last 20 seconds, per the bridge. */
  motion: boolean;
  /** Seconds since the epoch of the last motion, or null. */
  motionTs: number | null;
  status: string | null;
}

export type BridgeState =
  | { state: 'not-configured' }          // no API key in .env
  | { state: 'unreachable'; detail: string }
  | { state: 'signed-out' }               // bridge is up but has no Wyze login
  | { state: 'unauthorized' }             // API key doesn't match WB_API
  | { state: 'ready'; cameras: number };

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** Tests replace fetch; production uses the global. */
export function setFetch(f: Fetch | null): void { fetchImpl = f ?? ((...args) => fetch(...args)); }

function call(path: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const headers = new Headers(init.headers);
  if (apiKey()) headers.set('api', apiKey());
  return fetchImpl(bridgeUrl() + path, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
}

const enc = encodeURIComponent;

/** "1" | 1 | true | "true" → true */
const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

function toCamera(id: string, raw: Record<string, any>): BridgeCamera {
  const ts = Number(raw.motion_ts);
  return {
    id: String(raw.name_uri ?? id),
    name: String(raw.nickname ?? raw.name ?? raw.name_uri ?? id),
    model: raw.product_model != null ? String(raw.product_model) : null,
    modelName: raw.model_name != null ? String(raw.model_name) : null,
    ip: typeof raw.ip === 'string' && raw.ip ? raw.ip : null,
    mac: typeof raw.mac === 'string' && raw.mac ? raw.mac.replace(/[^0-9a-f]/gi, '').toUpperCase() : null,
    connected: truthy(raw.connected),
    enabled: raw.enabled === undefined ? true : truthy(raw.enabled),
    motion: truthy(raw.motion),
    motionTs: Number.isFinite(ts) && ts > 0 ? ts : null,
    status: raw.status != null ? String(raw.status) : null,
  };
}

/**
 * Reads the bridge's camera list. Its /api returns either the cameras keyed
 * by name, or an object with a `cameras` map plus totals, depending on version.
 */
export function parseCameraList(body: unknown): BridgeCamera[] {
  const b = body as Record<string, any> | null;
  if (!b || typeof b !== 'object') return [];
  const map = b.cameras && typeof b.cameras === 'object' ? b.cameras : b;
  if (Array.isArray(map)) return map.filter((c) => c && typeof c === 'object').map((c, i) => toCamera(String(c.name_uri ?? i), c));
  return Object.entries(map)
    .filter(([, c]) => c && typeof c === 'object' && !Array.isArray(c) && ('name_uri' in (c as object) || 'nickname' in (c as object)))
    .map(([id, c]) => toCamera(id, c as Record<string, any>));
}

/** A redirect to /login, or a 401 page, means the bridge isn't usable yet. */
async function readApi(res: Response): Promise<unknown> {
  if (res.status === 401) throw new BridgeError('The bridge rejected HomeHub\'s API key', 401);
  if (res.status >= 300 && res.status < 400) throw new BridgeError('The bridge isn\'t signed in to Wyze', 409);
  if (!res.ok) throw new BridgeError(`The bridge answered HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // Signed out, older versions render the login page instead of redirecting.
    if (/<form[\s\S]*password/i.test(text)) throw new BridgeError('The bridge isn\'t signed in to Wyze', 409);
    throw new BridgeError('The bridge sent something other than JSON');
  }
}

export async function listCameras(): Promise<BridgeCamera[]> {
  return parseCameraList(await readApi(await call('/api')));
}

export async function getState(): Promise<BridgeState> {
  if (!apiKey()) return { state: 'not-configured' };
  try {
    return { state: 'ready', cameras: (await listCameras()).length };
  } catch (err) {
    if (err instanceof BridgeError && err.status === 409) return { state: 'signed-out' };
    if (err instanceof BridgeError && err.status === 401) return { state: 'unauthorized' };
    return { state: 'unreachable', detail: (err as Error).message };
  }
}

/**
 * Passes a Wyze sign-in to the bridge. Wyze requires a developer API key and
 * ID as well as the account email and password.
 */
export async function signIn(login: { email: string; password: string; keyId: string; apiKey: string }): Promise<void> {
  const body = new URLSearchParams(login);
  const res = await call('/login', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 30_000);
  const text = await res.text();
  let json: { status?: string } | null = null;
  try { json = JSON.parse(text); } catch { /* the bridge may redirect to / on success */ }
  if (json?.status && json.status !== 'success') {
    throw new BridgeError(json.status === 'missing credentials' ? 'Enter all four fields.' : `Wyze sign-in failed: ${json.status}`, 422);
  }
  if (res.status >= 400) throw new BridgeError(`The bridge answered HTTP ${res.status}`);
  // The bridge signs in to Wyze in the background, so check that it worked.
  for (let i = 0; i < 10; i++) {
    const state = await getState();
    if (state.state === 'ready') return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new BridgeError('The bridge accepted the details but hasn\'t connected to Wyze yet. Check the email, password and API key, then try again.', 422);
}

/** Sends a camera command through the bridge, e.g. power on/off. */
async function command(cam: string, topic: string, payload?: string): Promise<Record<string, any>> {
  const path = `/api/${enc(cam)}/${enc(topic)}${payload ? `/${enc(payload)}` : ''}`;
  const body = await readApi(await call(path, {}, 20_000));
  const result = (body ?? {}) as Record<string, any>;
  if (typeof result.status === 'string' && /error|fail/i.test(result.status)) {
    throw new BridgeError(`Camera command failed: ${result.response ?? result.status}`);
  }
  return result;
}

/** Whether the camera is switched on. Asks Wyze, so it's slow; cache the answer. */
export async function getPower(cam: string): Promise<boolean> {
  const r = await command(cam, 'power');
  const v = r.value ?? r.response ?? r.power;
  return v === 'on' || v === 1 || v === '1' || v === true;
}

export async function setPower(cam: string, on: boolean): Promise<void> {
  await command(cam, 'power', on ? 'on' : 'off');
}

/**
 * A JPEG from the camera. `fresh` grabs a frame from the live stream; otherwise
 * the bridge's copy is used if it's less than a minute old.
 */
export async function snapshot(cam: string, fresh = true): Promise<Buffer> {
  const path = fresh ? `/snapshot/${enc(cam)}.jpg` : `/img/${enc(cam)}.jpg?exp=60`;
  const res = await call(path, {}, SNAPSHOT_TIMEOUT_MS);
  if (res.status >= 300 && res.status < 400) throw new BridgeError('No picture from this camera right now', 404);
  if (!res.ok) throw new BridgeError(`No picture from this camera (HTTP ${res.status})`, res.status === 404 ? 404 : 502);
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) throw new BridgeError('No picture from this camera right now', 404);
  return Buffer.from(await res.arrayBuffer());
}

/** Fetches from the bridge's HLS server, for proxying live video. */
export function hlsFetch(path: string, signal?: AbortSignal): Promise<Response> {
  return fetchImpl(`${hlsUrl()}/${path}`, { signal });
}

export function logBridgeError(err: unknown, what: string): void {
  logger.warn({ reason: (err as Error).message }, what);
}
