import { Client, Plug, type AnyDevice, type RealtimeNormalized } from 'tplink-smarthome-api';
import { logger } from '../logger';

export interface DiscoveredDevice {
  ip: string;
  alias: string;
  model: string;
  hasEmeter: boolean;
}

export interface EnergyMetrics {
  wattage: number | null;
  voltage: number | null;
  current: number | null;
}

const client = new Client({ logLevel: 'silent' });

/** Broadcast discovery — collects for `timeoutMs` then resolves.
 *  Uses a fresh Client each call so previously-seen devices still fire events. */
export async function discoverDevices(timeoutMs = 7000): Promise<DiscoveredDevice[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredDevice>(); // keyed by IP to dedupe
    const scanner = new Client({ logLevel: 'silent' });

    const onDevice = (device: AnyDevice) => {
      if (found.has(device.host)) return;
      const plug = device instanceof Plug ? device : null;
      found.set(device.host, {
        ip:        device.host,
        alias:     device.alias,
        model:     device.model,
        hasEmeter: plug?.supportsEmeter ?? false,
      });
      logger.debug({ ip: device.host, alias: device.alias }, 'Discovered device');
    };

    scanner.on('device-new',    onDevice);
    scanner.on('device-online', onDevice);
    scanner.startDiscovery({ deviceTypes: ['plug'] });

    setTimeout(() => {
      scanner.stopDiscovery();
      scanner.removeAllListeners();
      const result = Array.from(found.values());
      logger.info({ count: result.length }, 'Discovery complete');
      resolve(result);
    }, timeoutMs);
  });
}

/** Get a Plug instance — throws if unreachable. */
async function getPlug(ip: string): Promise<Plug> {
  const device = await client.getDevice({ host: ip });
  if (!(device instanceof Plug)) throw new Error(`Device at ${ip} is not a plug`);
  return device;
}

export async function getPowerState(ip: string): Promise<boolean> {
  const plug = await getPlug(ip);
  return plug.getPowerState();
}

export async function setPowerState(ip: string, state: boolean): Promise<void> {
  const plug = await getPlug(ip);
  await plug.setPowerState(state);
  logger.info({ ip, state }, 'Power state set');
}

export async function getEnergyMetrics(ip: string): Promise<EnergyMetrics | null> {
  const plug = await getPlug(ip);
  if (!plug.supportsEmeter) return null;

  const raw = (await plug.emeter.getRealtime()) as RealtimeNormalized;

  // Normalise: v1 uses `power`, `voltage`, `current`; v2 uses `*_mw`, `*_mv`, `*_ma`
  const wattage = raw.power  ?? (raw.power_mw  != null ? raw.power_mw  / 1000 : null);
  const voltage = raw.voltage ?? (raw.voltage_mv != null ? raw.voltage_mv / 1000 : null);
  const current = raw.current ?? (raw.current_ma != null ? raw.current_ma / 1000 : null);

  return { wattage: wattage ?? null, voltage: voltage ?? null, current: current ?? null };
}
