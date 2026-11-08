import crypto from 'node:crypto';
import { getDb } from '../db';
import { logger } from '../logger';
import { sendPushToAll } from '../push/push.service';
import { automationsPaused } from '../automation/pause';
import { isActiveServer } from '../system/role';
import { capture, getSettings as cameraSettings, latestForCamera, type Snapshot } from '../cameras/snapshots';
import { handleMotion } from '../sensors/motion';
import {
  RingAuthError, ringLibrary,
  type LiveSession, type PendingSignIn, type RingCam, type RingConnector, type RingEvent, type RingSession,
} from './ring-client';

/**
 * Ring cameras and doorbells, through the Ring account.
 *
 * - An admin signs in on the Cameras page, with the code Ring sends. HomeHub
 *   keeps only the token Ring gives back, never the password. The token
 *   belongs to this HomeHub: it's left out of backups, because two HomeHubs
 *   sharing one would sign each other out.
 * - Ring cameras added to HomeHub are listed in a setting, so backups keep them.
 *   They aren't devices: there's nothing to switch.
 * - A doorbell press saves a picture and notifies phones. Motion saves a
 *   picture and notifies like Wyze motion does, by the Cameras page settings.
 *   Either one counts as motion for a motion rule that names the camera.
 * - Only the active HomeHub connects. Paused automations still let doorbell
 *   presses through, but motion does nothing then, as with Wyze cameras.
 */

export const TOKEN_KEY = 'ring_token';
const CAMERAS_KEY = 'ring_cameras';
const NOTIFY_DOORBELL_KEY = 'ring_notify_doorbell';

/** How often HomeHub checks whether it should connect or disconnect, and retries after a problem. */
const CHECK_MS = 60_000;
const FIRST_CHECK_MS = 5_000;
/** After a failure, wait this long, doubling each time up to the limit. */
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
/** A doorbell pressed twice within this long gets one picture and one notification. */
const DOORBELL_REPEAT_MS = 15_000;
/** Ring sends no "motion over", so a motion rule hears "clear" this long after the last motion. */
const MOTION_CLEAR_MS = Number(process.env.RING_MOTION_CLEAR_MS) || 60_000;
/** A code sign-in waits this long for the code. */
const PENDING_MS = 10 * 60_000;
/** Live video ends by itself after this long, as in the Ring app, so a forgotten tab doesn't keep a camera streaming. */
const LIVE_MAX_MS = Number(process.env.RING_LIVE_MAX_MS) || 10 * 60_000;
const DETECTIONS: Record<string, string> = { human: 'a person', vehicle: 'a vehicle', package_delivery: 'a package', package: 'a package', animal: 'an animal' };

export interface AddedCamera { id: number; name: string; home?: string | null }

export type RingState =
  | { state: 'signed-out' }
  /** Signed in, but this HomeHub is a backup or development server, or cameras are off. */
  | { state: 'standby' }
  | { state: 'connecting' }
  | { state: 'ready' }
  /** The saved sign-in stopped working. */
  | { state: 'expired'; detail: string }
  | { state: 'error'; detail: string };

// ── Settings ─────────────────────────────────────────────────────────

function get(key: string): string | null {
  return (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}
function set(key: string, value: string): void {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
function remove(key: string): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
}

export const signedIn = (): boolean => !!get(TOKEN_KEY);

export function addedCameras(): AddedCamera[] {
  try {
    const list = JSON.parse(get(CAMERAS_KEY) ?? '[]') as unknown;
    return Array.isArray(list)
      ? list.filter((c): c is AddedCamera => Number.isInteger(c?.id) && typeof c?.name === 'string')
      : [];
  } catch {
    return [];
  }
}
function saveAdded(list: AddedCamera[]): void {
  set(CAMERAS_KEY, JSON.stringify(list));
}

export const notifyDoorbell = (): boolean => get(NOTIFY_DOORBELL_KEY) !== '0';
export function setNotifyDoorbell(on: boolean): void {
  set(NOTIFY_DOORBELL_KEY, on ? '1' : '0');
}

/** The key a Ring camera's snapshots are filed under. */
export const cameraKey = (id: number): string => `ring-${id}`;

// ── Connection ───────────────────────────────────────────────────────

let connector: RingConnector = ringLibrary;
/** For tests: replace Ring with a fake. */
export function setRingConnectorForTests(c: RingConnector): void { connector = c; }

let push: (title: string, body: string, data?: Record<string, unknown>) => void = sendPushToAll;
/** For tests: see notifications instead of sending them. */
export function setPushForTests(fn: typeof push): void { push = fn; }

let session: RingSession | null = null;
let cams: RingCam[] = [];
let stops: (() => void)[] = [];
let state: RingState = { state: 'signed-out' };
let failures = 0;
let retryAt = 0;
let connecting: Promise<void> | null = null;

/** Why HomeHub shouldn't be connected now, or null if it should. */
function holdReason(): RingState | null {
  if (!signedIn()) return { state: 'signed-out' };
  if (!isActiveServer() || !cameraSettings().enabled) return { state: 'standby' };
  return null;
}

export function ringState(): RingState {
  return holdReason() ?? state;
}

function disconnect(): void {
  for (const id of [...lives.keys()]) void endLive(id);
  for (const stop of stops) stop();
  stops = [];
  session?.disconnect();
  session = null;
  cams = [];
}

function saveToken(token: string): void {
  // A token that arrives after signing out mustn't sign HomeHub back in.
  if (signedIn()) set(TOKEN_KEY, token);
}

async function connect(now: number): Promise<void> {
  const token = get(TOKEN_KEY)!;
  state = { state: 'connecting' };
  const s = connector.connect(token, saveToken);
  session = s;
  try {
    const list = await s.cameras();
    if (session !== s) return;   // signed out or disconnected meanwhile
    cams = list;
    stops = list.map((cam) => cam.onEvent((event) => { void handleEvent(cam, event); }));
    state = { state: 'ready' };
    failures = 0;
    logger.info({ cameras: list.length }, 'Ring connected');
    refreshNames(list);
  } catch (err) {
    if (session === s) disconnect();
    failures++;
    retryAt = now + Math.min(RETRY_MIN_MS * 2 ** (failures - 1), RETRY_MAX_MS);
    const detail = (err as Error).message || String(err);
    state = err instanceof RingAuthError ? { state: 'expired', detail } : { state: 'error', detail };
    logger.warn({ reason: detail, failures }, 'Ring connection failed');
  }
}

/** Connects or disconnects as the settings and server role say. Runs every minute. */
export async function checkRing(now = Date.now()): Promise<void> {
  if (connecting) return connecting;
  const hold = holdReason();
  if (hold) {
    if (session) { disconnect(); logger.info({ reason: hold.state }, 'Ring disconnected'); }
    state = hold;
    return;
  }
  if (session || now < retryAt) return;
  connecting = connect(now).finally(() => { connecting = null; });
  return connecting;
}

/** Keeps the names and homes of added cameras as they are in the Ring app. */
function refreshNames(list: RingCam[]): void {
  const added = addedCameras();
  let changed = false;
  for (const a of added) {
    const cam = list.find((c) => c.id === a.id);
    if (cam && cam.name && cam.name !== a.name) { a.name = cam.name; changed = true; }
    if (cam && cam.home && cam.home !== a.home) { a.home = cam.home; changed = true; }
  }
  if (changed) saveAdded(added);
}

/** "Front Door", or "Front Door (Lake house)" when two added cameras share the name. */
export function labelFor(camera: AddedCamera, added = addedCameras()): string {
  const clash = added.some((c) => c.id !== camera.id && c.name === camera.name);
  return clash && camera.home ? `${camera.name} (${camera.home})` : camera.name;
}

let timer: NodeJS.Timeout | null = null;

export function startRing(): void {
  if (timer) return;
  setTimeout(() => { void checkRing(); }, FIRST_CHECK_MS).unref();
  timer = setInterval(() => { void checkRing(); }, CHECK_MS);
  timer.unref();
}

export function stopRing(): void {
  if (timer) clearInterval(timer);
  timer = null;
  disconnect();
}

// ── Signing in ───────────────────────────────────────────────────────

let pending: { signIn: PendingSignIn; at: number } | null = null;

export type SignInStep = { signedIn: true } | { signedIn: false; codeSentTo: string };

function finish(token: string): SignInStep {
  set(TOKEN_KEY, token);
  pending = null;
  disconnect();
  failures = 0;
  retryAt = 0;
  state = { state: 'connecting' };
  void checkRing();
  logger.info('Signed in to Ring');
  return { signedIn: true };
}

/** First step: email and password. Ring then usually sends a code. */
export async function startSignIn(email: string, password: string): Promise<SignInStep> {
  pending = null;
  const { result, pending: next } = await connector.signIn(email, password);
  if (result.done) return finish(result.token);
  pending = { signIn: next, at: Date.now() };
  return { signedIn: false, codeSentTo: result.prompt };
}

/** Second step: the code Ring sent. */
export async function submitCode(code: string): Promise<SignInStep> {
  if (!pending || Date.now() - pending.at > PENDING_MS) {
    pending = null;
    throw new RingAuthError('That sign-in has expired. Enter your email and password again.');
  }
  const result = await pending.signIn.submitCode(code);
  if (result.done) return finish(result.token);
  throw new RingAuthError("That code didn't work. Check it and try again.");
}

export function signOut(): void {
  pending = null;
  remove(TOKEN_KEY);
  disconnect();
  failures = 0;
  retryAt = 0;
  state = { state: 'signed-out' };
  logger.info('Signed out of Ring');
}

// ── Cameras ──────────────────────────────────────────────────────────

export class RingError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

async function liveCameras(): Promise<RingCam[]> {
  await checkRing();
  if (!session) {
    const s = ringState();
    throw new RingError(
      s.state === 'signed-out' ? 'Sign in to Ring first'
        : s.state === 'standby' ? 'Ring runs on the active HomeHub'
          : 'detail' in s ? s.detail : 'Ring isn\'t connected yet',
      409,
    );
  }
  return cams;
}

export interface AccountCamera { id: number; name: string; home: string | null; model: string; isDoorbell: boolean; hasBattery: boolean; offline: boolean; added: boolean }

/** Every camera on the Ring account, and whether it's in HomeHub. */
export async function accountCameras(): Promise<AccountCamera[]> {
  const added = new Set(addedCameras().map((c) => c.id));
  return (await liveCameras()).map((c) => ({
    id: c.id, name: c.name, home: c.home, model: c.model, isDoorbell: c.isDoorbell, hasBattery: c.hasBattery, offline: c.offline, added: added.has(c.id),
  }));
}

export async function addCamera(id: number): Promise<AddedCamera> {
  const cam = (await liveCameras()).find((c) => c.id === id);
  if (!cam) throw new RingError('That camera isn\'t on your Ring account', 404);
  const list = addedCameras().filter((c) => c.id !== id);
  const entry: AddedCamera = { id, name: cam.name, home: cam.home };
  saveAdded([...list, entry]);
  logger.info({ camera: cam.name }, 'Ring camera added');
  return entry;
}

/** Takes the camera out of HomeHub. Its snapshots stay until they're old enough to delete. */
export function removeCamera(id: number): boolean {
  const list = addedCameras();
  if (!list.some((c) => c.id === id)) return false;
  saveAdded(list.filter((c) => c.id !== id));
  getDb().prepare('UPDATE motion_rules SET ring_camera_id = NULL WHERE ring_camera_id = ?').run(id);
  return true;
}

/** What HomeHub knows about the last doorbell press and motion from each camera, since it started. */
const lastEvent = new Map<number, { ding?: number; motion?: number; encrypted?: boolean }>();

export interface CameraStatus extends AddedCamera {
  /** The name, with its home when another added camera has the same name. */
  label: string;
  key: string;
  model: string | null;
  isDoorbell: boolean;
  /** null while HomeHub isn't connected to Ring. */
  offline: boolean | null;
  hasBattery: boolean;
  lastDingAt: string | null;
  lastMotionAt: string | null;
  /** End-to-end encryption is on, so Ring gives HomeHub no pictures. */
  encrypted: boolean;
  latestSnapshot: Snapshot | null;
}

export function cameraStatuses(): CameraStatus[] {
  const iso = (ms?: number) => (ms ? new Date(ms).toISOString() : null);
  const added = addedCameras();
  return added.map((a) => {
    const cam = cams.find((c) => c.id === a.id);
    const last = lastEvent.get(a.id) ?? {};
    return {
      ...a,
      home: cam?.home ?? a.home ?? null,
      label: labelFor(a, added),
      key: cameraKey(a.id),
      model: cam?.model ?? null,
      isDoorbell: cam?.isDoorbell ?? false,
      offline: cam ? cam.offline : null,
      hasBattery: cam?.hasBattery ?? false,
      lastDingAt: iso(last.ding),
      lastMotionAt: iso(last.motion),
      encrypted: last.encrypted === true,
      latestSnapshot: latestForCamera(cameraKey(a.id)),
    };
  });
}

/** Saves a picture from a Ring camera now. */
export async function takeSnapshot(id: number): Promise<Snapshot> {
  const added = addedCameras().find((c) => c.id === id);
  if (!added) throw new RingError('Camera not found', 404);
  const cam = (await liveCameras()).find((c) => c.id === id);
  if (!cam) throw new RingError(`${added.name} is no longer on your Ring account`, 404);
  let jpeg: Buffer;
  try {
    jpeg = await cam.snapshot();
  } catch (err) {
    logger.warn({ camera: added.name, reason: (err as Error).message }, 'Ring snapshot failed');
    throw new RingError(`No picture from ${added.name}. ${cam.offline ? 'Ring says it\'s offline.' : 'Try again in a moment.'}`, 502);
  }
  return capture({ id: null, alias: labelFor(added), cam: cameraKey(id) }, 'manual', new Date(), jpeg);
}

// ── Live video ───────────────────────────────────────────────────────

interface Live { cameraId: number; session: LiveSession; timer: NodeJS.Timeout }
const lives = new Map<string, Live>();

export interface LiveStart { sessionId: string; answer: string; maxSeconds: number }

/**
 * Starts live video from a Ring camera to the browser that sent `offer`, its
 * WebRTC offer. HomeHub only passes the offer and answer between them: the
 * video goes from Ring to the browser, not through HomeHub.
 */
export async function startLive(id: number, offer: string): Promise<LiveStart> {
  const added = addedCameras().find((c) => c.id === id);
  if (!added) throw new RingError('Camera not found', 404);
  const cam = (await liveCameras()).find((c) => c.id === id);
  if (!cam) throw new RingError(`${added.name} is no longer on your Ring account`, 404);
  if (cam.offline) throw new RingError(`Ring says ${added.name} is offline`, 409);
  let session: LiveSession;
  try {
    session = await cam.startLive(offer);
  } catch (err) {
    const text = (err as Error).message ?? '';
    logger.warn({ camera: added.name, reason: text }, 'Ring live video didn\'t start');
    if (/live view is currently disabled/i.test(text)) {
      throw new RingError(`Live view is turned off for ${added.name} by a mode in the Ring app. Turn it on there to watch here.`, 409);
    }
    throw new RingError(`Ring didn't start live video from ${added.name}. Try again in a moment.`, 502);
  }
  const sessionId = crypto.randomUUID();
  const timer = setTimeout(() => { void endLive(sessionId); }, LIVE_MAX_MS);
  timer.unref();
  lives.set(sessionId, { cameraId: id, session, timer });
  logger.info({ camera: added.name }, 'Ring live video started');
  return { sessionId, answer: session.answer, maxSeconds: Math.round(LIVE_MAX_MS / 1000) };
}

/** Ends live video. Returns false for a session that already ended. */
export async function endLive(sessionId: string): Promise<boolean> {
  const live = lives.get(sessionId);
  if (!live) return false;
  lives.delete(sessionId);
  clearTimeout(live.timer);
  try {
    await live.session.end();
  } catch (err) {
    logger.debug({ reason: (err as Error).message }, 'Ring live video end failed');
  }
  return true;
}

export const liveCount = (): number => lives.size;

// ── Events ───────────────────────────────────────────────────────────

const seen = new Set<string>();
const lastShot = new Map<string, number>();
const clearTimers = new Map<string, NodeJS.Timeout>();

/** For tests. */
export function resetRingState(): void {
  disconnect();
  seen.clear();
  lastShot.clear();
  lastEvent.clear();
  for (const t of clearTimers.values()) clearTimeout(t);
  clearTimers.clear();
  state = { state: 'signed-out' };
  failures = 0;
  retryAt = 0;
  pending = null;
  connecting = null;
}

const isJpeg = (b: Buffer) => b.length > 2 && b[0] === 0xff && b[1] === 0xd8;

/** Ring's picture of the event, or a fresh one. Null if Ring has neither. */
async function eventPicture(cam: RingCam, event: RingEvent): Promise<Buffer | null> {
  for (const uuid of event.snapshotUuid ? [event.snapshotUuid, undefined] : [undefined]) {
    try {
      const jpeg = await cam.snapshot(uuid);
      if (isJpeg(jpeg)) return jpeg;
    } catch (err) {
      logger.debug({ camera: cam.name, reason: (err as Error).message }, 'Ring event picture not ready');
    }
  }
  return null;
}

/** Tells motion rules that name this camera: motion now, clear a minute after the last. */
async function tellMotionRules(cameraId: number): Promise<void> {
  const rules = getDb().prepare('SELECT token FROM motion_rules WHERE ring_camera_id = ?').all(cameraId) as { token: string }[];
  for (const { token } of rules) {
    clearTimeout(clearTimers.get(token));
    clearTimers.set(token, setTimeout(() => {
      clearTimers.delete(token);
      handleMotion(token, false).catch((err) => logger.warn({ err }, 'Ring motion clear failed'));
    }, MOTION_CLEAR_MS).unref());
    await handleMotion(token, true).catch((err) => logger.warn({ err }, 'Ring motion rule failed'));
  }
}

/** One doorbell press or motion. Returns the snapshot it saved, if any, for tests. */
export async function handleEvent(cam: RingCam, event: RingEvent, now = Date.now()): Promise<Snapshot | null> {
  const key = `${cam.id}:${event.kind}:${event.id}`;
  if (seen.has(key)) return null;
  seen.add(key);
  if (seen.size > 500) for (const k of [...seen].slice(0, 200)) seen.delete(k);

  const added = addedCameras().find((c) => c.id === cam.id);
  if (!added) return null;
  const last = lastEvent.get(cam.id) ?? {};
  last[event.kind] = Math.max(last[event.kind] ?? 0, event.at);
  if (event.encrypted !== undefined) last.encrypted = event.encrypted;
  lastEvent.set(cam.id, last);

  const ding = event.kind === 'ding';
  const paused = automationsPaused();
  // Paused automations stop motion, and motion lights, but not the doorbell.
  if (paused && !ding) return null;
  // First, so a light comes on before the picture is taken.
  if (!paused) await tellMotionRules(cam.id);

  const settings = cameraSettings();
  if (!ding && !settings.motionSnapshots) return null;
  const shotKey = `${cam.id}:${event.kind}`;
  const wait = ding ? DOORBELL_REPEAT_MS : settings.cooldownSeconds * 1000;
  const previous = lastShot.get(shotKey);
  if (previous !== undefined && now - previous < wait) return null;
  lastShot.set(shotKey, now);

  const what = (event.detection && DETECTIONS[event.detection]) || 'motion';
  const label = labelFor(added);
  const notify = ding ? notifyDoorbell() : settings.notify;
  const title = ding ? 'Doorbell' : 'Motion';
  const body = ding ? `Someone rang ${label}` : `${label} saw ${what}`;

  const picture = event.encrypted ? null : await eventPicture(cam, event);
  let snap: Snapshot | null = null;
  if (picture) {
    try {
      snap = await capture({ id: null, alias: label, cam: cameraKey(cam.id) }, ding ? 'doorbell' : 'motion', new Date(event.at), picture);
      logger.info({ camera: added.name, event: event.kind, id: snap.id, lagSeconds: Math.round((now - event.at) / 1000) }, 'Ring snapshot saved');
    } catch (err) {
      logger.warn({ err, camera: added.name }, 'Couldn\'t save the Ring snapshot');
    }
  } else {
    logger.info({ camera: added.name, event: event.kind, encrypted: !!event.encrypted }, 'Ring event with no picture');
  }
  // A doorbell press is worth a notification even without a picture.
  if (notify && (snap || ding)) push(title, body, snap ? { url: '/cameras', snapshotId: snap.id } : { url: '/cameras' });
  return snap;
}
