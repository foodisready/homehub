import { DeviceDriver, DiscoveredDevice, EnergyMetrics } from './DeviceDriver';
import {
  discoverDevices,
  getPowerState,
  setPowerState,
  getEnergyMetrics,
  normalizeRealtime,
} from '../kasa/kasa.service';
import * as klap from '../kasa/klap';
import { logger } from '../logger';
import { Client, Plug } from 'tplink-smarthome-api';

const client = new Client({ logLevel: 'silent' });

/** Marks a plug that needs a TP-Link login. Older plugs have no config. */
const KLAP_CONFIG = { protocol: 'klap' };

const usesKlap = (config?: Record<string, unknown>) => config?.protocol === 'klap';

export class KasaDriver implements DeviceDriver {
  readonly type = 'kasa';

  async setPower(ip: string, on: boolean, config?: Record<string, unknown>): Promise<void> {
    if (usesKlap(config)) return klap.setPower(ip, on);
    await setPowerState(ip, on);
  }

  async getPower(ip: string, config?: Record<string, unknown>): Promise<boolean> {
    if (usesKlap(config)) return (await klap.getSysInfo(ip)).isOn;
    return getPowerState(ip);
  }

  async getEnergy(ip: string, config?: Record<string, unknown>): Promise<EnergyMetrics | null> {
    if (usesKlap(config)) {
      const info = await klap.getSysInfo(ip);
      return info.hasEmeter ? normalizeRealtime(await klap.getRealtime(ip)) : null;
    }
    return getEnergyMetrics(ip);
  }

  async probe(ip: string): Promise<Omit<DiscoveredDevice, 'driverType'> | null> {
    try {
      const device = await client.getDevice({ host: ip });
      if (!(device instanceof Plug)) return null;
      return {
        ip,
        alias:    device.alias,
        model:    device.model,
        hasEmeter: device.supportsEmeter,
        mac:      device.macNormalized,
      };
    } catch {
      return this.probeKlap(ip);
    }
  }

  private async probeKlap(ip: string): Promise<Omit<DiscoveredDevice, 'driverType'> | null> {
    try {
      return { ip, ...toDevice(await klap.getSysInfo(ip)), driverConfig: KLAP_CONFIG };
    } catch (err) {
      if (err instanceof klap.KlapAuthError) logger.warn(err.message);
      return null;
    }
  }

  async discover(): Promise<DiscoveredDevice[]> {
    const [open, locked] = await Promise.all([discoverDevices(), klap.discoverKlap()]);
    const openIps = new Set(open.map((d) => d.ip));

    const loginPlugs: DiscoveredDevice[] = [];
    for (const plug of locked.filter((d) => !openIps.has(d.ip))) {
      loginPlugs.push(await describeLoginPlug(plug));
    }
    return [...open.map((d) => ({ ...d, driverType: 'kasa' })), ...loginPlugs];
  }
}

function toDevice({ alias, model, hasEmeter, mac }: klap.KlapSysInfo) {
  return { alias, model, hasEmeter, mac };
}

/** Lists a found plug even if the login fails, so it can be seen and registered. */
async function describeLoginPlug(plug: klap.KlapDiscovered): Promise<DiscoveredDevice> {
  const base = { ip: plug.ip, driverType: 'kasa', driverConfig: KLAP_CONFIG };
  try {
    return { ...base, ...toDevice(await klap.getSysInfo(plug.ip)) };
  } catch (err) {
    logger.warn({ ip: plug.ip, reason: (err as Error).message }, 'Found a Kasa plug HomeHub cannot log in to');
    return {
      ...base,
      alias: `Kasa plug ${plug.mac.slice(-4)}`,
      model: plug.model,
      hasEmeter: false,
      mac: plug.mac,
      needsLogin: true,
    };
  }
}
