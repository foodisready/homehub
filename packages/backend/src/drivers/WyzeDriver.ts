import type { DeviceDriver, DiscoveredDevice, EnergyMetrics } from './DeviceDriver';
import * as bridge from '../cameras/bridge';

/**
 * Wyze cameras, through docker-wyze-bridge. "On" means the camera is
 * watching; "off" pauses it (Wyze's own power-off, which also tucks a Pan's
 * lens away). driver_config is { cam: "<bridge name>" }.
 *
 * Reading the power state asks Wyze's cloud, so answers are cached for a few
 * minutes; a switch from HomeHub updates the cache at once.
 */

const POWER_CACHE_MS = 5 * 60 * 1000;
const powerCache = new Map<string, { on: boolean; at: number }>();

export function cameraName(config?: Record<string, unknown>): string {
  const cam = config?.cam;
  if (typeof cam !== 'string' || !cam) throw new Error('This camera has no bridge name; add it again from Discover');
  return cam;
}

/** For tests and after a bridge sign-in. */
export function clearPowerCache(): void { powerCache.clear(); }

export class WyzeDriver implements DeviceDriver {
  readonly type = 'wyze';
  /** Wyze takes a few seconds to apply a power change. */
  readonly confirmAfterMs = 8000;

  async setPower(_ip: string, on: boolean, config?: Record<string, unknown>): Promise<void> {
    const cam = cameraName(config);
    await bridge.setPower(cam, on);
    powerCache.set(cam, { on, at: Date.now() });
  }

  async getPower(_ip: string, config?: Record<string, unknown>): Promise<boolean> {
    const cam = cameraName(config);
    const cached = powerCache.get(cam);
    if (cached && Date.now() - cached.at < POWER_CACHE_MS) return cached.on;
    const on = await bridge.getPower(cam);
    powerCache.set(cam, { on, at: Date.now() });
    return on;
  }

  async getEnergy(): Promise<EnergyMetrics | null> {
    return null;
  }

  /** Accepts a camera's IP address or its bridge name. */
  async probe(ipOrName: string): Promise<Omit<DiscoveredDevice, 'driverType'> | null> {
    const cameras = await bridge.listCameras().catch(() => []);
    const cam = cameras.find((c) => c.ip === ipOrName || c.id === ipOrName);
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
