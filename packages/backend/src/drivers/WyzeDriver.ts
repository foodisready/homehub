import type { DeviceDriver, DiscoveredDevice, EnergyMetrics } from './DeviceDriver';
import * as bridge from '../cameras/bridge';
import * as cloud from '../cameras/wyze-cloud';
import { liveCameras } from '../cameras/watch';

/**
 * Wyze cameras: video through the camera bridge, on/off through the Wyze
 * cloud. driver_config is { cam: "<bridge name>" }.
 *
 * "On" means the camera is watching; "off" pauses it with Wyze's own power
 * switch, which stops it streaming, recording and detecting motion (a Pan
 * also tucks its lens away). It stays on Wi-Fi, so it can be resumed.
 *
 * A camera the bridge doesn't know reads as offline. Asking Wyze whether a
 * camera is on is slow and rate-limited, so the answer is cached for a few
 * minutes; a switch from HomeHub updates the cache at once.
 */

const LIST_CACHE_MS = 10_000;
/** A resumed camera takes a few seconds to come back; then the bridge connects to it afresh. */
const RECONNECT_AFTER_RESUME_MS = Number(process.env.WYZE_RECONNECT_AFTER_MS) || 15_000;
const POWER_CACHE_MS = 5 * 60 * 1000;
let listCache: { at: number; cameras: Promise<bridge.BridgeCamera[]> } | null = null;
const powerCache = new Map<string, { on: boolean; at: number }>();

export function cameraName(config?: Record<string, unknown>): string {
  const cam = config?.cam;
  if (typeof cam !== 'string' || !cam) throw new Error('This camera has no bridge name; add it again from Cameras');
  return cam;
}

/** For tests and after a Wyze sign-in. */
export function clearPowerCache(): void {
  listCache = null;
  powerCache.clear();
}

function cameras(): Promise<bridge.BridgeCamera[]> {
  if (!listCache || Date.now() - listCache.at > LIST_CACHE_MS) {
    const pending = liveCameras();
    listCache = { at: Date.now(), cameras: pending };
    pending.catch(() => { if (listCache?.cameras === pending) listCache = null; });
  }
  return listCache.cameras;
}

async function find(cam: string): Promise<bridge.BridgeCamera & { mac: string; model: string }> {
  const found = (await cameras()).find((c) => c.id === cam);
  if (!found) throw new Error('The camera bridge doesn\'t have this camera');
  if (!found.mac || !found.model) throw new Error('The camera bridge doesn\'t know this camera\'s hardware address');
  return found as bridge.BridgeCamera & { mac: string; model: string };
}

export class WyzeDriver implements DeviceDriver {
  readonly type = 'wyze';
  /** Wyze takes a few seconds to apply a power change. */
  readonly confirmAfterMs = 8000;

  async setPower(_ip: string, on: boolean, config?: Record<string, unknown>): Promise<void> {
    const name = cameraName(config);
    const cam = await find(name);
    await cloud.setCameraPower(cam, on);
    powerCache.set(name, { on, at: Date.now() });
    // go2rtc can stay stuck on the connection that died when the camera went off.
    if (on) {
      setTimeout(() => {
        bridge.restartStream(name).catch((err) => bridge.logBridgeError(err, `Couldn't reconnect ${cam.name} after resuming it`));
      }, RECONNECT_AFTER_RESUME_MS).unref();
    }
  }

  async getPower(_ip: string, config?: Record<string, unknown>): Promise<boolean> {
    const name = cameraName(config);
    const cam = await find(name);
    const cached = powerCache.get(name);
    if (cached && Date.now() - cached.at < POWER_CACHE_MS) return cached.on;
    try {
      const on = await cloud.getCameraPower(cam);
      powerCache.set(name, { on, at: Date.now() });
      return on;
    } catch (err) {
      // Wyze unreachable or not signed in: the bridge having the camera is the best answer there is.
      if (cached) return cached.on;
      bridge.logBridgeError(err, `Couldn't ask Wyze whether ${cam.name} is on`);
      return cam.enabled;
    }
  }

  async getEnergy(): Promise<EnergyMetrics | null> {
    return null;
  }

  /** Accepts a camera's IP address or its bridge name. */
  async probe(ipOrName: string): Promise<Omit<DiscoveredDevice, 'driverType'> | null> {
    const list = await bridge.listCameras().catch(() => []);
    const cam = list.find((c) => c.ip === ipOrName || c.id === ipOrName);
    return cam ? toDiscovered(cam) : null;
  }

  /** The cameras on the Wyze account, wherever they are on the network. */
  async discover(): Promise<DiscoveredDevice[]> {
    if ((await bridge.getState()).state !== 'ready') return [];
    return (await bridge.listCameras()).map((c) => ({ ...toDiscovered(c), driverType: this.type }));
  }
}

function toDiscovered(cam: bridge.BridgeCamera): Omit<DiscoveredDevice, 'driverType'> {
  return {
    // devices.ip must be unique; a camera the bridge hasn't seen on the network yet gets a placeholder.
    ip: cam.ip ?? `wyze:${cam.id}`,
    alias: cam.name,
    model: cam.modelName ?? cam.model ?? 'Wyze camera',
    hasEmeter: false,
    driverConfig: { cam: cam.id },
    ...(cam.mac ? { mac: cam.mac } : {}),
  };
}
