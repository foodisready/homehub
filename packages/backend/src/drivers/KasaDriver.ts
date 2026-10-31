import { DeviceDriver, DiscoveredDevice, EnergyMetrics } from './DeviceDriver';
import {
  discoverDevices,
  getPowerState,
  setPowerState,
  getEnergyMetrics,
} from '../kasa/kasa.service';
import { Client, Plug } from 'tplink-smarthome-api';

const client = new Client({ logLevel: 'silent' });

export class KasaDriver implements DeviceDriver {
  readonly type = 'kasa';

  async setPower(ip: string, on: boolean): Promise<void> {
    await setPowerState(ip, on);
  }

  async getPower(ip: string): Promise<boolean> {
    return getPowerState(ip);
  }

  async getEnergy(ip: string): Promise<EnergyMetrics | null> {
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
      return null;
    }
  }

  async discover(): Promise<DiscoveredDevice[]> {
    const found = await discoverDevices();
    return found.map((d) => ({ ...d, driverType: 'kasa' }));
  }
}
