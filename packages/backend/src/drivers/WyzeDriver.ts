import type { DeviceDriver, DiscoveredDevice, EnergyMetrics } from './DeviceDriver';
import * as bridge from '../cameras/bridge';
import { liveCameras } from '../cameras/watch';

/**
 * Wyze cameras, through the camera bridge. driver_config is { cam: "<bridge name>" }.
 *
 * "On" means the camera is watching. The current bridge can't pause a camera
 * (Wyze's power-off), so a camera on the bridge reads as on, one the bridge
 * doesn't know as offline, and pausing is refused with an explanation.
 * Pausing will come back through the Wyze account.
 *
 * The camera list is cached for a moment, because device polling asks about
 * each camera in turn.
 */

const LIST_CACHE_MS = 10_000;
let listCache: { at: number; cameras: Promise<bridge.BridgeCamera[]> } | null = null;

export const PAUSE_UNAVAILABLE = 'Pausing Wyze cameras isn\'t available with the current camera bridge yet.';

export function cameraName(config?: Record<string, unknown>): string {
  const cam = config?.cam;
  if (typeof cam !== 'string' || !cam) throw new Error('This camera has no bridge name; add it again from Cameras');
  return cam;
}

/** For tests and after a bridge sign-in. */
export function clearPowerCache(): void { listCache = null; }

function cameras(): Promise<bridge.BridgeCamera[]> {
  if (!listCache || Date.now() - listCache.at > LIST_CACHE_MS) {
    const pending = liveCameras();
    listCache = { at: Date.now(), cameras: pending };
    pending.catch(() => { if (listCache?.cameras === pending) listCache = null; });
  }
  return listCache.cameras;
}

export class WyzeDriver implements DeviceDriver {
  readonly type = 'wyze';

  async setPower(_ip: string, _on: boolean, config?: Record<string, unknown>): Promise<void> {
    cameraName(config);
    throw new bridge.BridgeError(PAUSE_UNAVAILABLE, 501);
  }

  async getPower(_ip: string, config?: Record<string, unknown>): Promise<boolean> {
    const cam = cameraName(config);
    const found = (await cameras()).find((c) => c.id === cam);
    if (!found) throw new Error('The camera bridge doesn\'t have this camera');
    return found.enabled;
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
