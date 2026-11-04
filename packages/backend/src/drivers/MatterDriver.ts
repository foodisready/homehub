import type { DeviceDriver, DiscoveredDevice, EnergyMetrics } from './DeviceDriver';

/**
 * Matter plugs, lights and switches. Each switchable part of a Matter device
 * is its own HomeHub device. Matter devices have no fixed IP address to store,
 * so the ip column holds "matter:<node>:<endpoint>", which keeps it unique.
 *
 * matter.js loads only when a Matter device is used, so homes without one
 * don't pay for it.
 */
const matter = () => import('../matter/controller');

export const matterAddress = (nodeId: string, endpoint: number) => `matter:${nodeId}:${endpoint}`;

function target(ip: string, config?: Record<string, unknown>): { nodeId: string; endpoint: number } {
  const nodeId = config?.['nodeId'];
  const endpoint = config?.['endpoint'];
  if (typeof nodeId === 'string' && typeof endpoint === 'number') return { nodeId, endpoint };
  const m = /^matter:(\d+):(\d+)$/.exec(ip);
  if (m) return { nodeId: m[1], endpoint: Number(m[2]) };
  throw new Error(`Not a Matter device: ${ip}`);
}

export class MatterDriver implements DeviceDriver {
  readonly type = 'matter';

  async setPower(ip: string, on: boolean, config?: Record<string, unknown>): Promise<void> {
    const t = target(ip, config);
    await (await matter()).setOnOff(t.nodeId, t.endpoint, on);
  }

  async getPower(ip: string, config?: Record<string, unknown>): Promise<boolean> {
    const t = target(ip, config);
    return (await matter()).getOnOff(t.nodeId, t.endpoint);
  }

  async getEnergy(): Promise<EnergyMetrics | null> {
    return null;
  }

  /** Matter devices are added with a pairing code, not by address. */
  async probe(): Promise<null> {
    return null;
  }

  /** Not found by scanning: they're added with a pairing code in Settings. */
  async discover(): Promise<DiscoveredDevice[]> {
    return [];
  }
}
