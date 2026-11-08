import { getDb } from '../db';
import { logger } from '../logger';
import { sendPushToAll } from '../push/push.service';
import { automationsPaused } from '../automation/pause';
import { isActiveServer } from '../system/role';
import { capture, getSettings as cameraSettings, latestForCamera, type Snapshot } from '../cameras/snapshots';
import { fetchWithLogin } from './http-auth';
import {
  ONVIF_PORTS, OnvifError, onvifLibrary, withoutLogin,
  type CameraLogin, type Detection, type FoundCamera, type MotionEvent, type MotionWatch, type OnvifConnector, type PanAction, type ProbeResult,
} from './onvif-client';
import * as relay from './relay';

/**
 * IP cameras that HomeHub reaches directly on the home network, with no
 * cloud: any camera with RTSP video, and ONVIF for the rest (Reolink,
 * Amcrest, Axis and others).
 *
 * - An admin adds one by its address and the login set on the camera.
 *   HomeHub asks it over ONVIF where its video and pictures are, whether it
 *   turns, and watches it for motion. A camera without ONVIF can be added by
 *   its RTSP address instead: live video and pictures, no motion.
 * - Live video goes through the camera relay (relay.ts) and HomeHub, so it
 *   works over HomeHub's own address and login.
 * - Motion saves a picture and notifies by the Cameras page settings, as
 *   Wyze and Ring motion do. Paused automations stop it. Only the active
 *   HomeHub watches.
 * - Cameras are a table of their own, in backups, with the password hidden
 *   when a backup is viewed. They aren't devices: there's nothing to switch.
 */

/** How often HomeHub checks which cameras to watch, and retries after a problem. */
const CHECK_MS = 60_000;
const FIRST_CHECK_MS = 5_000;
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
const DETECTIONS: Record<Detection, string> = { person: 'a person', vehicle: 'a vehicle', animal: 'an animal' };

export type Quality = 'main' | 'sub';

interface Row {
  id: number; name: string; host: string; onvif_port: number | null; username: string; password: string;
  main_url: string; sub_url: string | null; snapshot_url: string | null; quality: Quality;
  maker: string | null; model: string | null; can_pan: number; motion: number; created_at: string;
}

export class IpCamError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

// ── Injection for tests ──────────────────────────────────────────────

let connector: OnvifConnector = onvifLibrary;
export function setOnvifConnectorForTests(c: OnvifConnector): void { connector = c; }

let push: (title: string, body: string, data?: Record<string, unknown>) => void = sendPushToAll;
export function setPushForTests(fn: typeof push): void { push = fn; }

// ── Names and addresses ──────────────────────────────────────────────

/** The key a camera's snapshots are filed under. */
export const cameraKey = (id: number): string => `ipcam-${id}`;
/** The camera's stream on the relay. */
export const streamName = (id: number, quality: Quality): string => `ipcam_${id}_${quality}`;

/** The camera's RTSP address with its login, for the relay. */
export function withLogin(url: string, username: string, password: string): string {
  if (!username) return url;
  try {
    const u = new URL(url);
    u.username = encodeURIComponent(username);
    u.password = encodeURIComponent(password);
    return u.toString();
  } catch {
    return url;
  }
}

/** An IPv4 address or a host name, nothing else. */
export const isHost = (s: unknown): s is string =>
  typeof s === 'string' && s.length <= 253 && /^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*)$/.test(s);

const loginOf = (r: Row): CameraLogin => ({ host: r.host, port: r.onvif_port ?? 80, username: r.username, password: r.password });

// ── The table ────────────────────────────────────────────────────────

const rows = (): Row[] => getDb().prepare('SELECT * FROM ip_cameras ORDER BY name').all() as Row[];
const row = (id: number): Row | undefined => getDb().prepare('SELECT * FROM ip_cameras WHERE id = ?').get(id) as Row | undefined;

export const cameraCount = (): number => (getDb().prepare('SELECT COUNT(*) AS n FROM ip_cameras').get() as { n: number }).n;

export interface AddInput {
  host: string;
  /** The ONVIF port, if not one of the usual ones. */
  port?: number;
  username: string;
  password: string;
  name?: string;
  /** For a camera without ONVIF: its RTSP address. */
  rtspUrl?: string;
}

/**
 * Tries the camera's usual ONVIF ports all at once, so a wrong address fails
 * in seconds rather than one port after another. A port that connects wins;
 * otherwise a wrong login says the most (that port was right), then a port
 * that answered but not as ONVIF.
 */
async function probeCamera(host: string, port: number | undefined, username: string, password: string): Promise<ProbeResult> {
  const ports = port ? [port] : ONVIF_PORTS;
  const results = await Promise.all(ports.map((p) => connector.probe({ host, port: p, username, password }).then(
    (found) => ({ found, err: null }),
    (err: unknown) => ({ found: null, err: err instanceof OnvifError ? err : new OnvifError((err as Error).message, 'other') }),
  )));
  const ok = results.find((r) => r.found);
  if (ok) return ok.found!;
  const errors = results.map((r) => r.err!);
  const rank: Record<string, number> = { login: 0, 'not-onvif': 1, other: 2, unreachable: 3 };
  const last = errors.sort((x, y) => rank[x.problem] - rank[y.problem])[0] ?? null;
  if (last?.problem === 'login') throw new IpCamError('The camera didn\'t accept that username and password. Use the login set on the camera itself, not a cloud account.', 422);
  if (last?.problem === 'unreachable') {
    throw new IpCamError(`No camera answered at ${host}. Check the address in the camera's app, that ONVIF is on (in Reolink: Settings → Network → Advanced → Server Settings), and that it's on the same Wi-Fi as HomeHub.`, 502);
  }
  throw new IpCamError(`${host} didn't answer as an ONVIF camera${last ? ` (${last.message})` : ''}. Turn on ONVIF in the camera's settings, or add it by its RTSP address instead.`, 502);
}

export async function addCamera(input: AddInput): Promise<CameraStatus> {
  const db = getDb();
  let id: number;
  if (input.rtspUrl) {
    const u = new URL(input.rtspUrl);
    if (rows().some((r) => r.main_url === withoutLogin(input.rtspUrl!))) throw new IpCamError('That camera is already in HomeHub', 409);
    const username = input.username || decodeURIComponent(u.username);
    const password = input.password || decodeURIComponent(u.password);
    const name = input.name?.trim() || u.hostname;
    ({ lastInsertRowid: id } = db.prepare(
      `INSERT INTO ip_cameras (name, host, onvif_port, username, password, main_url, motion) VALUES (?, ?, NULL, ?, ?, ?, 0)`,
    ).run(name, u.hostname, username, password, withoutLogin(input.rtspUrl)) as { lastInsertRowid: number });
  } else {
    if (rows().some((r) => r.host === input.host && r.onvif_port !== null)) throw new IpCamError('That camera is already in HomeHub', 409);
    const found = await probeCamera(input.host, input.port, input.username, input.password);
    const name = input.name?.trim() || found.model || input.host;
    ({ lastInsertRowid: id } = db.prepare(`
      INSERT INTO ip_cameras (name, host, onvif_port, username, password, main_url, sub_url, snapshot_url, maker, model, can_pan, motion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(name, input.host, found.port, input.username, input.password, found.mainUrl, found.subUrl, found.snapshotUrl,
      found.maker, found.model, found.canPan ? 1 : 0) as { lastInsertRowid: number });
  }
  id = Number(id);
  logger.info({ camera: row(id)!.name, onvif: !input.rtspUrl }, 'IP camera added');
  void checkIpCameras();
  return cameraStatuses().find((c) => c.id === id)!;
}

export interface UpdateInput { name?: string; username?: string; password?: string; quality?: Quality; motion?: boolean }

/** Changes a camera. A new login is checked with the camera first, and what it offers read again. */
export async function updateCamera(id: number, patch: UpdateInput): Promise<CameraStatus> {
  const r = row(id);
  if (!r) throw new IpCamError('Camera not found', 404);
  const username = patch.username ?? r.username;
  // A blank password keeps the saved one, as the form never shows it.
  const password = patch.password ? patch.password : r.password;
  const loginChanged = username !== r.username || password !== r.password;
  if (patch.quality === 'sub' && !r.sub_url) throw new IpCamError('This camera has only one stream');
  if (patch.motion === true && r.onvif_port === null) throw new IpCamError('Motion needs ONVIF, and this camera was added by its RTSP address');
  const db = getDb();
  if (loginChanged && r.onvif_port !== null) {
    const found = await probeCamera(r.host, r.onvif_port, username, password);
    db.prepare('UPDATE ip_cameras SET main_url = ?, sub_url = ?, snapshot_url = ?, maker = ?, model = ?, can_pan = ? WHERE id = ?')
      .run(found.mainUrl, found.subUrl, found.snapshotUrl, found.maker, found.model, found.canPan ? 1 : 0, id);
  }
  db.prepare('UPDATE ip_cameras SET name = ?, username = ?, password = ?, quality = ?, motion = ? WHERE id = ?').run(
    patch.name?.trim() || r.name, username, password, patch.quality ?? r.quality,
    patch.motion === undefined ? r.motion : (patch.motion ? 1 : 0), id,
  );
  // A new login or setting starts the watch afresh.
  stopWatch(id);
  void checkIpCameras();
  return cameraStatuses().find((c) => c.id === id)!;
}

/** Takes the camera out of HomeHub. Its snapshots stay until they're old enough to delete. */
export async function removeCamera(id: number): Promise<boolean> {
  const { changes } = getDb().prepare('DELETE FROM ip_cameras WHERE id = ?').run(id);
  if (!changes) return false;
  stopWatch(id);
  lastMotion.delete(id);
  await Promise.all((['main', 'sub'] as Quality[]).map((q) => relay.removeStream(streamName(id, q))));
  return true;
}

// ── Status ───────────────────────────────────────────────────────────

export type MotionState = 'off' | 'unsupported' | 'standby' | 'connecting' | 'watching' | 'error';

export interface CameraStatus {
  id: number; name: string; key: string; host: string; maker: string | null; model: string | null;
  /** Added over ONVIF, rather than by its RTSP address. */
  onvif: boolean;
  canPan: boolean;
  username: string;
  hasPassword: boolean;
  quality: Quality;
  hasSubStream: boolean;
  /** Watching for motion is turned on for this camera. */
  motion: boolean;
  motionState: MotionState;
  motionDetail: string | null;
  lastMotionAt: string | null;
  latestSnapshot: Snapshot | null;
}

export function cameraStatuses(): CameraStatus[] {
  const watching = shouldWatch();
  return rows().map((r) => {
    const w = watches.get(r.id);
    const motionState: MotionState = r.onvif_port === null ? 'unsupported'
      : !r.motion ? 'off'
        : !watching ? 'standby'
          : w?.error ? 'error'
            : w?.live ? 'watching' : 'connecting';
    const last = lastMotion.get(r.id);
    return {
      id: r.id, name: r.name, key: cameraKey(r.id), host: r.host, maker: r.maker, model: r.model,
      onvif: r.onvif_port !== null, canPan: r.can_pan === 1, username: r.username, hasPassword: !!r.password,
      quality: r.quality, hasSubStream: !!r.sub_url, motion: r.motion === 1, motionState,
      motionDetail: motionState === 'error' ? w!.error : null,
      lastMotionAt: last ? new Date(last).toISOString() : null,
      latestSnapshot: latestForCamera(cameraKey(r.id)),
    };
  });
}

// ── Pictures and live video ──────────────────────────────────────────

const isJpeg = (b: Buffer) => b.length > 2 && b[0] === 0xff && b[1] === 0xd8;

function cameraOr404(id: number): Row {
  const r = row(id);
  if (!r) throw new IpCamError('Camera not found', 404);
  return r;
}

/** The relay's stream for watching the camera, set up if needed. */
export async function liveStream(id: number): Promise<string> {
  const r = cameraOr404(id);
  const quality: Quality = r.quality === 'sub' && r.sub_url ? 'sub' : 'main';
  const url = quality === 'sub' ? r.sub_url! : r.main_url;
  const name = streamName(id, quality);
  await relay.ensureStream(name, withLogin(url, r.username, r.password));
  return name;
}

/** A picture from the camera now: its own snapshot if it has one, or one made from its video. */
export async function picture(id: number): Promise<Buffer> {
  const r = cameraOr404(id);
  if (r.snapshot_url) {
    try {
      const res = await fetchWithLogin(r.snapshot_url, r.username, r.password);
      const body = Buffer.from(await res.arrayBuffer());
      if (res.ok && isJpeg(body)) return body;
      if (res.status === 401) throw new IpCamError(`${r.name} didn't accept its saved login. Edit the camera and enter it again.`, 502);
      logger.debug({ camera: r.name, status: res.status }, 'IP camera snapshot address gave no picture');
    } catch (err) {
      if (err instanceof IpCamError) throw err;
      logger.debug({ camera: r.name, reason: (err as Error).message }, 'IP camera snapshot failed');
    }
  }
  try {
    const name = streamName(id, r.sub_url ? 'sub' : 'main');
    await relay.ensureStream(name, withLogin(r.sub_url ?? r.main_url, r.username, r.password));
    return await relay.frame(name);
  } catch (err) {
    if (err instanceof relay.RelayError && err.status === 503) throw new IpCamError(err.message, 503);
    throw new IpCamError(`No picture from ${r.name}. Check that it's on, and on the same Wi-Fi as HomeHub.`, 502);
  }
}

export async function takeSnapshot(id: number): Promise<Snapshot> {
  const r = cameraOr404(id);
  return capture({ id: null, alias: r.name, cam: cameraKey(id) }, 'manual', new Date(), await picture(id));
}

export async function pan(id: number, action: PanAction): Promise<void> {
  const r = cameraOr404(id);
  if (!r.can_pan || r.onvif_port === null) throw new IpCamError('This camera doesn\'t turn', 409);
  try {
    await connector.pan(loginOf(r), action);
  } catch (err) {
    throw new IpCamError(`${r.name} didn't turn: ${(err as Error).message}`, 502);
  }
}

export async function discover(timeoutMs = 4_000): Promise<(FoundCamera & { added: boolean })[]> {
  const hosts = new Set(rows().map((r) => r.host));
  return (await connector.discover(timeoutMs)).map((c) => ({ ...c, added: hosts.has(c.host) }));
}

// ── Motion ───────────────────────────────────────────────────────────

interface Watch { handle: MotionWatch | null; live: boolean; error: string | null; failures: number; retryAt: number; login: string }
const watches = new Map<number, Watch>();
const lastMotion = new Map<number, number>();
const lastShot = new Map<number, number>();

const shouldWatch = (): boolean => isActiveServer() && cameraSettings().enabled;
const loginId = (r: Row) => `${r.host}:${r.onvif_port}:${r.username}:${r.password}`;

function stopWatch(id: number): void {
  watches.get(id)?.handle?.stop();
  watches.delete(id);
}

function startWatch(r: Row, previous?: Watch): void {
  const w: Watch = { handle: null, live: false, error: null, failures: previous?.failures ?? 0, retryAt: 0, login: loginId(r) };
  watches.set(r.id, w);
  w.handle = connector.watchMotion(
    loginOf(r),
    (e) => {
      if (watches.get(r.id) !== w) return;
      w.live = true;
      w.failures = 0;
      w.error = null;
      void handleMotion(r.id, e);
    },
    (err) => {
      if (watches.get(r.id) !== w) return;
      // Stop, and start again after a wait that doubles each time, up to ten minutes.
      w.handle?.stop();
      w.handle = null;
      w.live = false;
      w.failures++;
      w.error = err.message;
      w.retryAt = Date.now() + Math.min(RETRY_MIN_MS * 2 ** (w.failures - 1), RETRY_MAX_MS);
      logger.warn({ camera: r.name, reason: err.message, failures: w.failures }, 'IP camera motion watch stopped');
    },
  );
  // ONVIF gives no "subscribed" signal: no error within the first check counts as watching.
  setTimeout(() => { if (watches.get(r.id) === w && !w.error) w.live = true; }, 15_000).unref();
}

/** Starts and stops motion watches as cameras, settings and the server's role say. Runs every minute. */
export function checkIpCameras(now = Date.now()): void {
  const want = shouldWatch() ? rows().filter((r) => r.onvif_port !== null && r.motion === 1) : [];
  const wanted = new Set(want.map((r) => r.id));
  for (const id of [...watches.keys()]) if (!wanted.has(id)) stopWatch(id);
  for (const r of want) {
    const w = watches.get(r.id);
    if (w && w.login !== loginId(r)) { stopWatch(r.id); startWatch(r); continue; }
    if (!w) { startWatch(r); continue; }
    if (!w.handle && now >= w.retryAt) startWatch(r, w);
  }
}

/** One motion change from a camera. Returns the snapshot it saved, if any, for tests. */
export async function handleMotion(id: number, e: MotionEvent, now = Date.now()): Promise<Snapshot | null> {
  if (!e.active) return null;
  const r = row(id);
  if (!r) return null;
  lastMotion.set(id, now);
  if (automationsPaused()) return null;
  const settings = cameraSettings();
  if (!settings.motionSnapshots) return null;
  const previous = lastShot.get(id);
  if (previous !== undefined && now - previous < settings.cooldownSeconds * 1000) return null;
  lastShot.set(id, now);

  let snap: Snapshot | null = null;
  try {
    snap = await capture({ id: null, alias: r.name, cam: cameraKey(id) }, 'motion', new Date(now), await picture(id));
    logger.info({ camera: r.name, id: snap.id, detection: e.detection }, 'IP camera motion snapshot saved');
  } catch (err) {
    logger.warn({ camera: r.name, reason: (err as Error).message }, 'Couldn\'t save the IP camera motion snapshot');
  }
  if (settings.notify && snap) {
    push('Motion', `${r.name} saw ${e.detection ? DETECTIONS[e.detection] : 'motion'}`, { url: '/cameras', snapshotId: snap.id });
  }
  return snap;
}

let timer: NodeJS.Timeout | null = null;

export function startIpCameras(): void {
  if (timer) return;
  setTimeout(() => checkIpCameras(), FIRST_CHECK_MS).unref();
  timer = setInterval(() => checkIpCameras(), CHECK_MS);
  timer.unref();
}

export function stopIpCameras(): void {
  if (timer) clearInterval(timer);
  timer = null;
  for (const id of [...watches.keys()]) stopWatch(id);
}

/** For tests. */
export function resetIpCamState(): void {
  for (const id of [...watches.keys()]) stopWatch(id);
  lastMotion.clear();
  lastShot.clear();
  relay.resetRelayState();
}
