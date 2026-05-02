/**
 * Production wiring for the shutoff coordinator.
 * - `realInvoker` calls the existing DeviceDriver registry to actuate a valve.
 * - `realNotifier` plumbs failures/successes into the notification router.
 *
 * Kept separate from `shutoff.ts` so that pure logic stays testable with stubs.
 */

import { getDb } from '../db';
import { getDriver } from '../drivers/registry';
import { logger } from '../logger';
import { emitDeviceState } from '../socket';
import { getCachedState } from '../kasa/device.cache';
import { notifyShutoffFailure, notifyShutoffSuccess } from '../notifications/router';
import type { ShutoffInvoker, ShutoffNotifier } from './shutoff';

interface DeviceRow {
  id:            number;
  alias:         string;
  ip:            string;
  driver_type:   string;
  driver_config: string | null;
}

export const realInvoker: ShutoffInvoker = {
  async closeValve(deviceId: number): Promise<void> {
    const db = getDb();
    const device = db.prepare(
      'SELECT id, alias, ip, driver_type, driver_config FROM devices WHERE id = ?',
    ).get(deviceId) as DeviceRow | undefined;

    if (!device) {
      throw new Error(`Shutoff device ${deviceId} not found`);
    }

    const config = device.driver_config ? JSON.parse(device.driver_config) : undefined;
    await getDriver(device.driver_type ?? 'kasa').setPower(device.ip, false, config);

    // Update local state so the dashboard reflects the close.
    db.prepare("UPDATE devices SET turned_on_at = NULL WHERE id = ?").run(device.id);
    emitDeviceState(device.id, device.alias, false, getCachedState(device.id)?.wattage ?? null);
    logger.info({ deviceId, alias: device.alias }, 'Shutoff valve closed');
  },
};

export const realNotifier: ShutoffNotifier = {
  notifyFailure(eventId, sensorRowId, sensorAlias): void {
    notifyShutoffFailure({ eventId, sensorRowId, sensorAlias });
  },
  notifySuccess(eventId, sensorRowId, sensorAlias): void {
    notifyShutoffSuccess({ eventId, sensorRowId, sensorAlias });
  },
};
