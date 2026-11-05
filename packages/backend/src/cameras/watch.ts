import { getDb } from '../db';
import { logger } from '../logger';
import { sendPushToAll } from '../push/push.service';
import * as bridge from './bridge';
import { capture, getSettings, pruneSnapshots } from './snapshots';
import { automationsPaused } from '../automation/pause';

/**
 * Watches the cameras for motion: each reports the time of its last motion,
 * and a newer time than last seen means new motion, so HomeHub saves a
 * snapshot. Only cameras added to HomeHub are watched.
 *
 * The current camera bridge doesn't report motion (motionTs stays null), so
 * for now this only keeps camera names linked and old snapshots pruned. Motion
 * will come from the Wyze account's events.
 */

const POLL_MS = 15_000;
const IDLE_POLL_MS = 30_000;   // when the bridge is down or signed out

interface CameraDevice { id: number; alias: string; cam: string }

/** Last motion time seen per camera, and when its last motion snapshot was taken. */
const lastMotion = new Map<string, number>();
const lastShot = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;
let busy = false;

export function cameraDevices(): CameraDevice[] {
  const rows = getDb().prepare("SELECT id, alias, driver_config FROM devices WHERE driver_type = 'wyze'").all() as
    { id: number; alias: string; driver_config: string | null }[];
  return rows.flatMap((r) => {
    try {
      const cam = JSON.parse(r.driver_config ?? '{}').cam;
      return typeof cam === 'string' && cam ? [{ id: r.id, alias: r.alias, cam }] : [];
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

/** One check. Returns the snapshots it took, for tests. */
export async function checkMotion(now = Date.now()): Promise<number> {
  if (!cameraDevices().length) return 0;
  const cameras = await liveCameras();
  const devices = cameraDevices();
  const settings = getSettings();
  let taken = 0;

  for (const cam of cameras) {
    const device = devices.find((d) => d.cam === cam.id);
    if (!device) continue;

    // No motion yet counts as time 0, so the camera's first motion is still new.
    const ts = cam.motionTs ?? 0;
    const seen = lastMotion.get(cam.id);
    lastMotion.set(cam.id, ts);
    // The first reading after a start is old news, not new motion.
    if (seen === undefined || ts <= seen) continue;
    if (!settings.motionSnapshots) continue;
    const last = lastShot.get(cam.id);
    if (last !== undefined && now - last < settings.cooldownSeconds * 1000) continue;

    lastShot.set(cam.id, now);
    try {
      const snap = await capture(device, 'motion', new Date(now));
      taken++;
      logger.info({ camera: device.alias, id: snap.id }, 'Motion snapshot saved');
      if (settings.notify) {
        sendPushToAll('Motion', `${device.alias} saw motion`, { url: '/cameras', snapshotId: snap.id });
      }
    } catch (err) {
      bridge.logBridgeError(err, `Motion snapshot from ${device.alias} failed`);
    }
  }
  return taken;
}

/** For tests. */
export function resetMotionState(): void {
  lastMotion.clear();
  lastShot.clear();
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
        // Turned off in Settings: nothing to watch, but keep checking in case it's turned back on.
        if (getSettings().enabled && !automationsPaused()) await checkMotion(); else delay = IDLE_POLL_MS;
      } catch {
        delay = IDLE_POLL_MS;   // bridge down or signed out; check back later, quietly
      } finally {
        busy = false;
      }
    }
    timer = setTimeout(loop, delay);
  };
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
