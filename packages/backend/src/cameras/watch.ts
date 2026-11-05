import { getDb } from '../db';
import { logger } from '../logger';
import { sendPushToAll } from '../push/push.service';
import * as bridge from './bridge';
import { signInSavedAt } from './bridge';
import * as cloud from './wyze-cloud';
import { capture, getSettings, pruneSnapshots } from './snapshots';
import { automationsPaused } from '../automation/pause';

/**
 * Watches for motion through the Wyze account: every few seconds HomeHub asks
 * Wyze for the cameras' new events, and saves a snapshot for each motion
 * event, with a phone notification if that's turned on. The picture is
 * Wyze's own of the moment when it can be downloaded, or a frame from the
 * camera bridge otherwise.
 *
 * Only cameras added to HomeHub are watched. Paused cameras report nothing.
 * Each check looks back a few minutes, since Wyze lists an event a little
 * after it happens. Events from before HomeHub started are old news: they
 * update "last motion" but save nothing.
 */

const POLL_MS = 10_000;
const IDLE_POLL_MS = 30_000;          // turned off, signed out, or nothing to watch
const ERROR_POLL_MS = 60_000;
/** Wyze allows an account 300 event requests per 5 minutes, shared with the Wyze app. */
const RATE_LIMITED_POLL_MS = 5 * 60_000;
/** Below this many requests left in Wyze's window, check less often, leaving room for the app. */
const LOW_REQUESTS = 100;
const LOW_REQUESTS_POLL_MS = 30_000;
/** Each check looks back this far, because Wyze lists an event only once its picture is uploaded. */
const LOOKBACK_MS = 3 * 60_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Wyze's kind for sound-only events, which aren't motion. */
const SOUND_EVENT = '2';
const TAGS: Record<number, string> = { 101: 'a person', 102: 'a vehicle', 103: 'a pet', 104: 'a package' };

interface CameraDevice { id: number; alias: string; cam: string; mac: string | null }

/** Event ids already handled, so the overlapping look-back doesn't repeat them. */
const seen = new Set<string>();
/** Last motion per device, and when its last motion snapshot was taken (event time, ms). */
const lastMotion = new Map<number, number>();
const lastShot = new Map<number, number>();
let watchStartedAt = Date.now();
let timer: NodeJS.Timeout | null = null;
let busy = false;
let lastProblem = '';

/** When the camera last saw motion, as Wyze reported it since HomeHub started. */
export function lastMotionFor(deviceId: number): string | null {
  const at = lastMotion.get(deviceId);
  return at ? new Date(at).toISOString() : null;
}

export function cameraDevices(): CameraDevice[] {
  const rows = getDb().prepare("SELECT id, alias, mac, driver_config FROM devices WHERE driver_type = 'wyze'").all() as
    { id: number; alias: string; mac: string | null; driver_config: string | null }[];
  return rows.flatMap((r) => {
    try {
      const cam = JSON.parse(r.driver_config ?? '{}').cam;
      const mac = r.mac ? r.mac.replace(/[^0-9a-f]/gi, '').toUpperCase() : null;
      return typeof cam === 'string' && cam ? [{ id: r.id, alias: r.alias, cam, mac }] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Points cameras added under another bridge name at the bridge's current one,
 * matched by hardware address. The bridge names a camera after its Wyze name
 * (and the bridge before v0.1.16 spelled names differently), so a rename
 * would otherwise lose the camera. Returns how many were updated.
 */
export function relinkCameras(cameras: bridge.BridgeCamera[]): number {
  const names = new Set(cameras.map((c) => c.id));
  const rows = getDb().prepare("SELECT id, mac, driver_config FROM devices WHERE driver_type = 'wyze' AND mac IS NOT NULL").all() as
    { id: number; mac: string; driver_config: string | null }[];
  const update = getDb().prepare('UPDATE devices SET driver_config = ? WHERE id = ?');
  let changed = 0;
  for (const row of rows) {
    let config: Record<string, unknown>;
    try { config = JSON.parse(row.driver_config ?? '{}'); } catch { config = {}; }
    if (typeof config.cam === 'string' && names.has(config.cam)) continue;
    const match = cameras.find((c) => c.mac && c.mac === row.mac.replace(/[^0-9a-f]/gi, '').toUpperCase());
    if (!match) continue;
    update.run(JSON.stringify({ ...config, cam: match.id }), row.id);
    logger.info({ deviceId: row.id, from: config.cam, to: match.id }, 'Camera relinked to its bridge name');
    changed++;
  }
  return changed;
}

/** The bridge's cameras, after relinking any whose name changed. */
export async function liveCameras(): Promise<bridge.BridgeCamera[]> {
  const cameras = await bridge.listCameras();
  relinkCameras(cameras);
  return cameras;
}

/** Wyze's picture of the event, if it downloads and is a JPEG. */
async function eventImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'follow' });
    // A redirect mustn't take it somewhere less safe than where it started.
    if (!res.ok || (res.url && new URL(res.url).protocol !== new URL(url).protocol)) return null;
    const length = Number(res.headers.get('content-length'));
    if (length > MAX_IMAGE_BYTES) return null;
    const body = Buffer.from(await res.arrayBuffer());
    return body.length > 0 && body.length <= MAX_IMAGE_BYTES && body[0] === 0xff && body[1] === 0xd8 ? body : null;
  } catch {
    return null;
  }
}

/** All new events since `since`, across pages of 20. */
async function newEvents(macs: string[], since: number, now: number): Promise<cloud.WyzeEvent[]> {
  const all: cloud.WyzeEvent[] = [];
  let from = since;
  for (let page = 0; page < 5; page++) {
    const batch = await cloud.getEvents(macs, from, now);
    all.push(...batch);
    if (batch.length < 20) break;
    from = Math.max(...batch.map((e) => e.at)) + 1;   // Wyze lists oldest first
  }
  return all;
}

/** One check. Returns the snapshots it took, for tests. */
export async function checkMotion(now = Date.now()): Promise<number> {
  const devices = cameraDevices().filter((d) => d.mac);
  if (!devices.length) return 0;
  const byMac = new Map(devices.map((d) => [d.mac!, d]));
  const settings = getSettings();
  const since = Math.max(now - LOOKBACK_MS, watchStartedAt - 60_000);
  const events = (await newEvents([...byMac.keys()], since, now))
    .filter((e) => !seen.has(e.id) && e.kind !== SOUND_EVENT)
    .sort((a, b) => a.at - b.at);
  let taken = 0;

  for (const event of events) {
    seen.add(event.id);
    const device = byMac.get(event.mac);
    if (!device) continue;
    lastMotion.set(device.id, Math.max(lastMotion.get(device.id) ?? 0, event.at));
    // From before HomeHub started watching: old news.
    if (event.at < watchStartedAt) continue;
    if (!settings.motionSnapshots) continue;
    const last = lastShot.get(device.id);
    if (last !== undefined && event.at - last < settings.cooldownSeconds * 1000) continue;
    lastShot.set(device.id, event.at);

    const what = event.tags.map((t) => TAGS[t]).find(Boolean);
    try {
      const picture = event.imageUrl ? await eventImage(event.imageUrl) : null;
      // Wyze's picture is of the moment itself; a frame from the bridge is of now.
      const snap = await capture(device, 'motion', new Date(picture ? event.at : now), picture ?? undefined);
      taken++;
      logger.info({ camera: device.alias, id: snap.id, picture: picture ? 'wyze' : 'bridge', lagSeconds: Math.round((now - event.at) / 1000) }, 'Motion snapshot saved');
      if (settings.notify) {
        sendPushToAll('Motion', `${device.alias} saw ${what ?? 'motion'}`, { url: '/cameras', snapshotId: snap.id });
      }
    } catch (err) {
      bridge.logBridgeError(err, `Motion snapshot from ${device.alias} failed`);
    }
  }
  // Forget ids that have left the look-back window.
  if (seen.size > 500) for (const id of [...seen].slice(0, seen.size - 300)) seen.delete(id);
  return taken;
}

/** For tests: forget everything, as if HomeHub had just started at `startedAt`. */
export function resetMotionState(startedAt = Date.now()): void {
  seen.clear();
  lastMotion.clear();
  lastShot.clear();
  watchStartedAt = startedAt;
  lastProblem = '';
}

/** Logs a problem once, not on every check, and logs when it clears. */
function note(problem: string): void {
  if (problem === lastProblem) return;
  if (problem) logger.warn({ reason: problem }, 'Camera motion watch paused');
  else if (lastProblem) logger.info('Camera motion watch working again');
  lastProblem = problem;
}

export function startCameraWatch(): void {
  if (!process.env.WYZE_BRIDGE_API_KEY) {
    logger.info('Camera bridge not part of this install; camera watch off');
    return;
  }
  const loop = async () => {
    let delay = POLL_MS;
    if (!busy) {
      busy = true;
      try {
        // Nothing to do: turned off, paused, snapshots off, or not signed in. Keep checking in case that changes.
        const s = getSettings();
        if (!s.enabled || !s.motionSnapshots || automationsPaused() || signInSavedAt() === null) delay = IDLE_POLL_MS;
        else {
          await checkMotion();
          note('');
          // Wyze says the account is running low on requests: slow down so the Wyze app, and pausing, still work.
          const left = cloud.wyzeRequestsLeft();
          if (left !== null && left < LOW_REQUESTS) delay = LOW_REQUESTS_POLL_MS;
        }
      } catch (err) {
        const rateLimited = err instanceof cloud.WyzeCloudError && (err.status === 429);
        delay = rateLimited ? RATE_LIMITED_POLL_MS : ERROR_POLL_MS;
        note((err as Error).message);
      } finally {
        busy = false;
      }
    }
    timer = setTimeout(loop, delay);
  };
  watchStartedAt = Date.now();
  timer = setTimeout(loop, POLL_MS);

  pruneSnapshots();
  setInterval(() => {
    try { pruneSnapshots(); } catch (err) { logger.error({ err }, 'Snapshot prune failed'); }
  }, 6 * 60 * 60 * 1000);
  logger.info('Camera motion watch started');
}

export function stopCameraWatch(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
