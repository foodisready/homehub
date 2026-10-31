import { getDb } from '../db';
import { DiscoveredDevice } from './DeviceDriver';

export interface MovedDevice {
  deviceId:   number;
  alias:      string;
  previousIp: string;
}

export type ReconciledDevice = DiscoveredDevice & { moved?: MovedDevice };

interface RegisteredRow {
  id:    number;
  alias: string;
  ip:    string;
}

/**
 * Match scan results to registered devices by MAC address, which survives an
 * IP change. Devices registered before MACs were stored have none, so they
 * fall back to the name: an exact name and IP match links the MAC, and a name
 * match at another IP is offered as a move for the user to confirm.
 */
export function reconcileDiscovered(found: DiscoveredDevice[]): ReconciledDevice[] {
  const db = getDb();
  const byMac = db.prepare('SELECT id, alias, ip FROM devices WHERE driver_type = ? AND mac = ?');
  const unlinkedByName = db.prepare(
    'SELECT id, alias, ip FROM devices WHERE driver_type = ? AND alias = ? AND mac IS NULL',
  );
  const linkMac = db.prepare('UPDATE devices SET mac = ? WHERE id = ?');

  return found.map((device) => {
    if (!device.mac) return device;

    const registered = byMac.get(device.driverType, device.mac) as RegisteredRow | undefined;
    const row = registered ?? unlinkedByName.get(device.driverType, device.alias) as RegisteredRow | undefined;
    if (!row) return device;

    if (row.ip !== device.ip) {
      return { ...device, moved: { deviceId: row.id, alias: row.alias, previousIp: row.ip } };
    }
    if (!registered) linkMac.run(device.mac, row.id);
    return device;
  });
}
