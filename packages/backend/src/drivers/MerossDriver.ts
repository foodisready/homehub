import type { DeviceDriver, DiscoveredDevice, EnergyMetrics } from './DeviceDriver';
import * as meross from '../meross/meross';
import { hostsOf, searchNetworks } from '../discovery/networks';
import { logger } from '../logger';

type Found = Omit<DiscoveredDevice, 'driverType'>;

/** Shorter than a normal request, since most addresses in a search have nothing on them. */
const SCAN_TIMEOUT_MS = 2000;

/**
 * Meross garage door openers (MSG100, MSG200). "On" means open.
 *
 * The door's sensor only reports closed once the door is fully down, so right
 * after a close command it still reads open. `confirmAfterMs` tells the
 * device routes to wait out the door's travel before checking.
 */
export class MerossDriver implements DeviceDriver {
  readonly type = 'meross';
  readonly confirmAfterMs = 25_000;

  private key(): string {
    const key = meross.savedKey();
    if (!key) throw new Error('Sign in to Meross in Settings → Integrations first');
    return key;
  }

  private channel(config?: Record<string, unknown>): number {
    return typeof config?.channel === 'number' ? config.channel : 0;
  }

  async setPower(ip: string, on: boolean, config?: Record<string, unknown>): Promise<void> {
    await meross.moveDoor(ip, this.key(), on, this.channel(config));
  }

  async getPower(ip: string, config?: Record<string, unknown>): Promise<boolean> {
    return meross.isDoorOpen(ip, this.key(), this.channel(config));
  }

  async getEnergy(): Promise<EnergyMetrics | null> {
    return null;
  }

  async probe(ip: string): Promise<Found | null> {
    const found = await this.identify(ip, meross.savedKey() ?? '');
    if (!found || found.needsLogin) return found;
    return this.withName(found, await meross.cloudDevices());
  }

  /**
   * Meross devices don't answer a broadcast, so every address on the networks
   * Discover searches is asked directly.
   */
  async discover(): Promise<DiscoveredDevice[]> {
    const key = meross.savedKey() ?? '';
    const networks = searchNetworks();
    const [results, cloud] = await Promise.all([
      Promise.all(networks.flatMap(hostsOf).map((ip) => this.identify(ip, key, SCAN_TIMEOUT_MS))),
      meross.cloudDevices(),
    ]);
    const found = results.filter((d): d is Found => d !== null);
    logger.info({ networks, count: found.length }, 'Meross scan complete');
    return found.map((d) => ({ ...(d.needsLogin ? d : this.withName(d, cloud)), driverType: this.type }));
  }

  /** A garage door opener at this address, a Meross device HomeHub can't sign in to, or null. */
  private async identify(ip: string, key: string, timeoutMs?: number): Promise<Found | null> {
    try {
      const info = await meross.getSystemAll(ip, key, timeoutMs);
      if (info.garageDoors.length === 0) return null;   // only garage doors are supported so far
      return {
        ip,
        alias: 'Garage door',
        model: info.type.toUpperCase(),
        hasEmeter: false,
        driverConfig: { channel: info.garageDoors[0].channel, ...(info.uuid ? { uuid: info.uuid } : {}) },
        ...(info.mac ? { mac: info.mac } : {}),
      };
    } catch (err) {
      if (err instanceof meross.MerossKeyError) {
        return { ip, alias: 'Meross device', model: 'Meross', hasEmeter: false, needsLogin: true };
      }
      return null;
    }
  }

  /** Uses the name from the Meross app, matched by the device's uuid. */
  private withName(found: Found, cloud: meross.CloudDevice[]): Found {
    const uuid = found.driverConfig?.uuid;
    const match = cloud.find((c) => c.uuid === uuid);
    return match ? { ...found, alias: match.name } : found;
  }
}
