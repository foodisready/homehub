import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

/**
 * Client for the Wyze camera bridge: IDisposable's docker-wyze-bridge 4.x,
 * which signs in to the owner's Wyze account, connects to the cameras on the
 * home network and hands their video to go2rtc.
 *
 * The bridge runs with host networking, because the cameras are only found by
 * a broadcast on the local network. Its go2rtc listens on 127.0.0.1 only
 * (see docker-compose.yml); its own API on 5080 is reachable from the network
 * but requires HomeHub's key (WYZE_BRIDGE_API_KEY), sent as a Bearer token.
 *
 * The bridge only takes a Wyze sign-in at startup, so HomeHub saves it in the
 * data volume's `wyze` folder, readable by the bridge alone, and the bridge
 * restarts itself when it changes. Signing out deletes it.
 */

const TIMEOUT_MS = 10_000;
const SNAPSHOT_TIMEOUT_MS = 25_000;
/** How long a sign-in may take: the bridge restarts, starts go2rtc and logs in to Wyze. */
const SIGN_IN_WAIT_MS = 90_000;

export const bridgeUrl = () => (process.env.WYZE_BRIDGE_URL || 'http://127.0.0.1:5080').replace(/\/+$/, '');
/** The bridge's go2rtc, for live video. Only reachable from this computer. */
export const go2rtcUrl = () => (process.env.WYZE_GO2RTC_URL || 'http://127.0.0.1:1984').replace(/\/+$/, '');
const apiKey = () => process.env.WYZE_BRIDGE_API_KEY || '';

export class BridgeError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

export interface BridgeCamera {
  /** The bridge's name for the camera, e.g. "front_door". Stable while the Wyze name stays the same. */
  id: string;
  name: string;
  model: string | null;
  modelName: string | null;
  ip: string | null;
  mac: string | null;
  /** The bridge has the camera's stream set up. */
  connected: boolean;
  enabled: boolean;
  /** This bridge doesn't report motion; kept for when HomeHub learns it from Wyze. */
  motion: boolean;
  motionTs: number | null;
  status: string | null;
}

export type BridgeState =
  | { state: 'not-configured' }           // the bridge is left out (HOMEHUB_CAMERA_BRIDGE=0)
  | { state: 'off' }                       // cameras turned off in Settings
  | { state: 'unreachable'; detail: string }
  | { state: 'signed-out' }                // no Wyze sign-in saved
  | { state: 'starting' }                  // signed in moments ago; the bridge is restarting
  | { state: 'sign-in-failed'; detail: string }
  | { state: 'unauthorized' }              // the API key doesn't match the bridge's
  | { state: 'ready'; cameras: number };

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** Tests replace fetch; production uses the global. */
export function setFetch(f: Fetch | null): void { fetchImpl = f ?? ((...args) => fetch(...args)); }

function call(p: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const headers = new Headers(init.headers);
  if (apiKey()) headers.set('Authorization', `Bearer ${apiKey()}`);
  return fetchImpl(bridgeUrl() + p, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
}

const enc = encodeURIComponent;

// ── The saved Wyze sign-in ────────────────────────────────────────

export interface WyzeLogin { email: string; password: string; keyId: string; apiKey: string }

/** File per value, so the bridge's start script reads each one without parsing anything. */
const FILES: Record<keyof WyzeLogin, string> = { email: 'email', password: 'password', keyId: 'key-id', apiKey: 'api-key' };

export function signInDir(): string {
  if (process.env.WYZE_SIGNIN_DIR) return process.env.WYZE_SIGNIN_DIR;
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'db.sqlite');
  return path.join(path.dirname(dbPath), 'wyze');
}

const versionFile = () => path.join(signInDir(), 'version');

/** When the saved sign-in was last changed, or null if there isn't one. */
export function signInSavedAt(): number | null {
  try {
    const at = Number(fs.readFileSync(versionFile(), 'utf8').trim());
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

/**
 * Saves the sign-in for the bridge. `version` is written last: the bridge
 * waits for it, and restarts with the new sign-in when it changes.
 */
export function saveSignIn(login: WyzeLogin, now = Date.now()): void {
  const dir = signInDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  for (const [k, file] of Object.entries(FILES) as [keyof WyzeLogin, string][]) {
    const full = path.join(dir, file);
    fs.writeFileSync(`${full}.tmp`, login[k], { mode: 0o600 });
    fs.renameSync(`${full}.tmp`, full);
  }
  // Never the same as the last one, even within a millisecond.
  const at = Math.max(now, (signInSavedAt() ?? 0) + 1);
  fs.writeFileSync(`${versionFile()}.tmp`, String(at), { mode: 0o600 });
  fs.renameSync(`${versionFile()}.tmp`, versionFile());
}

/** Signs the bridge out of Wyze: it stops and waits for a new sign-in. */
export function clearSignIn(): void {
  fs.rmSync(versionFile(), { force: true });
  for (const file of Object.values(FILES)) fs.rmSync(path.join(signInDir(), file), { force: true });
}

// ── Reading the bridge ────────────────────────────────────────────

function toCamera(raw: Record<string, any>): BridgeCamera {
  const id = String(raw.name ?? '');
  const state = raw.state != null ? String(raw.state) : null;
  return {
    id,
    name: String(raw.nickname || id),
    model: raw.model != null ? String(raw.model) : null,
    modelName: raw.model_name ? String(raw.model_name) : null,
    ip: typeof raw.ip === 'string' && raw.ip ? raw.ip : null,
    mac: typeof raw.mac === 'string' && raw.mac ? raw.mac.replace(/[^0-9a-f]/gi, '').toUpperCase() : null,
    connected: state === 'streaming',
    enabled: state !== 'disabled',
    motion: false,
    motionTs: null,
    status: state,
  };
}

/** The bridge's /api/cameras: a list of cameras, each with its `name`. */
export function parseCameraList(body: unknown): BridgeCamera[] {
  if (!Array.isArray(body)) return [];
  return body
    .filter((c): c is Record<string, any> => !!c && typeof c === 'object' && typeof c.name === 'string' && c.name !== '')
    .map(toCamera);
}

export async function listCameras(): Promise<BridgeCamera[]> {
  const res = await call('/api/cameras');
  if (res.status === 401) throw new BridgeError('The bridge rejected HomeHub\'s API key', 401);
  if (!res.ok) throw new BridgeError(`The bridge answered HTTP ${res.status}`);
  try {
    return parseCameraList(await res.json());
  } catch {
    throw new BridgeError('The bridge sent something other than JSON');
  }
}

interface Health { uptime?: number; issues?: { ID?: string; Message?: string; Detail?: string }[] }

async function health(): Promise<Health> {
  const res = await call('/api/health', {}, 5000);
  if (!res.ok) throw new BridgeError(`The bridge answered HTTP ${res.status}`);
  return (await res.json()) as Health;
}

/** Wyze's reason, in words a person can act on. */
function signInProblem(issue: { Message?: string; Detail?: string }): string {
  const text = `${issue.Message ?? ''} ${issue.Detail ?? ''}`;
  if (/invalid credentials|code=1000/i.test(text)) return 'Wyze didn\'t accept the email, password, API key ID or API key.';
  if (/429|too many/i.test(text)) return 'Wyze is limiting sign-ins for now. The bridge keeps trying; give it a few minutes.';
  if (/mfa|totp|verification/i.test(text)) return 'Your Wyze account asks for a verification code, which HomeHub can\'t enter yet. Turn off two-step verification in the Wyze app, then sign in again.';
  return issue.Message || 'Wyze sign-in failed.';
}

export async function getState(now = Date.now()): Promise<BridgeState> {
  if (!apiKey()) return { state: 'not-configured' };
  const savedAt = signInSavedAt();
  if (savedAt === null) return { state: 'signed-out' };
  let h: Health;
  try {
    h = await health();
  } catch (err) {
    // The bridge restarts after a new sign-in; that's not a fault.
    if (now - savedAt < SIGN_IN_WAIT_MS) return { state: 'starting' };
    return { state: 'unreachable', detail: (err as Error).message };
  }
  // Still the bridge from before the sign-in was saved: it restarts within seconds.
  if (typeof h.uptime === 'number' && now - h.uptime * 1000 < savedAt - 2000) return { state: 'starting' };
  const auth = h.issues?.find((i) => i.ID === 'wyzeapi/auth');
  if (auth) return { state: 'sign-in-failed', detail: signInProblem(auth) };
  try {
    return { state: 'ready', cameras: (await listCameras()).length };
  } catch (err) {
    if (err instanceof BridgeError && err.status === 401) return { state: 'unauthorized' };
    return { state: 'unreachable', detail: (err as Error).message };
  }
}

/**
 * Saves a Wyze sign-in and waits for the bridge to restart with it. Wyze
 * requires a developer API key and ID as well as the account email and password.
 */
export async function signIn(login: WyzeLogin, opts: { waitMs?: number; pollMs?: number } = {}): Promise<BridgeState> {
  saveSignIn(login);
  const until = Date.now() + (opts.waitMs ?? SIGN_IN_WAIT_MS);
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 2000));
    const state = await getState();
    if (state.state === 'ready') return state;
    if (state.state === 'sign-in-failed') throw new BridgeError(state.detail, 422);
    if (state.state === 'unauthorized') throw new BridgeError('The camera bridge rejected HomeHub\'s key', 502);
  }
  throw new BridgeError('The camera bridge hasn\'t finished signing in. Check that the wyze-bridge service is running, then look again in a minute.', 504);
}

/**
 * A JPEG from the camera now. The bridge answers an empty 200 while the
 * camera is still connecting, so that counts as no picture, and is tried
 * once more: the first request is often what wakes the connection.
 */
export async function snapshot(cam: string, attempts = 2): Promise<Buffer> {
  for (let i = 1; ; i++) {
    const res = await call(`/api/snapshot/${enc(cam)}`, {}, SNAPSHOT_TIMEOUT_MS);
    if (res.status === 404) throw new BridgeError('Camera not found on the bridge', 404);
    if (res.status === 401) throw new BridgeError('The bridge rejected HomeHub\'s API key', 401);
    const type = res.headers.get('content-type') ?? '';
    const body = res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
    if (type.startsWith('image/') && body.length > 0) return body;
    if (i >= attempts) throw new BridgeError('No picture from this camera right now', 404);
  }
}

/**
 * Live video from go2rtc's HLS server, for relaying. `index.m3u8` starts a
 * session for the camera; the playlist and segments that follow name the
 * session, under `hls/`.
 */
export function hlsFetch(cam: string, file: string, query: string, signal?: AbortSignal): Promise<Response> {
  const target = file === 'index.m3u8' ? `/api/stream.m3u8?src=${enc(cam)}` : `/api/${file}${query}`;
  return fetchImpl(go2rtcUrl() + target, { signal });
}

export function logBridgeError(err: unknown, what: string): void {
  logger.warn({ reason: (err as Error).message }, what);
}
