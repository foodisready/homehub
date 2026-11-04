import { DeviceDriver } from './DeviceDriver';
import { KasaDriver }   from './KasaDriver';
import { ShellyDriver } from './ShellyDriver';
import { TuyaDriver }   from './TuyaDriver';
import { MerossDriver } from './MerossDriver';
import { WyzeDriver }   from './WyzeDriver';
import { MatterDriver } from './MatterDriver';

const drivers = new Map<string, DeviceDriver>([
  ['kasa',   new KasaDriver()],
  ['shelly', new ShellyDriver()],
  ['tuya',   new TuyaDriver()],
  ['meross', new MerossDriver()],
  ['wyze',   new WyzeDriver()],
  ['matter', new MatterDriver()],
]);

export function getDriver(driverType: string): DeviceDriver {
  const d = drivers.get(driverType);
  if (!d) throw new Error(`Unknown device driver: "${driverType}". Valid types: ${[...drivers.keys()].join(', ')}`);
  return d;
}

export function getAllDrivers(): DeviceDriver[] {
  return Array.from(drivers.values());
}
