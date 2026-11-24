/**
 * Ties robot connections to HomeHub's devices: a robot's status goes to open
 * screens as it changes, and a job starting or ending updates its on/off at
 * once rather than at the next poll.
 */
import { getDb } from '../db';
import { emitVacuumStatus } from '../socket';
import { getCachedState, pollDeviceNow } from '../kasa/device.cache';
import { onRobotStatus, peekStatus } from './link';
import type { RobotStatus } from './protocol';
import { logger } from '../logger';

/** What the dashboard shows of a robot vacuum. */
export type VacuumView = Omit<RobotStatus, 'name'>;

const view = ({ name: _name, ...rest }: RobotStatus): VacuumView => rest;

const blidOf = (driverConfig: string | null): string | null => {
  try {
    const blid = driverConfig ? JSON.parse(driverConfig)?.blid : null;
    return typeof blid === 'string' ? blid : null;
  } catch {
    return null;
  }
};

/** The robot's status for the device list, or null while HomeHub isn't connected to it. */
export function vacuumViewOf(driverConfig: string | null): VacuumView | null {
  const blid = blidOf(driverConfig);
  const status = blid ? peekStatus(blid) : null;
  return status ? view(status) : null;
}

/** The device for a robot, by its id. */
export function deviceForRobot(blid: string): { id: number; alias: string } | undefined {
  const rows = getDb().prepare("SELECT id, alias, driver_config FROM devices WHERE driver_type = 'roomba'").all() as
    { id: number; alias: string; driver_config: string | null }[];
  return rows.find((r) => blidOf(r.driver_config) === blid);
}

let started = false;

export function startRoombaUpdates(): void {
  if (started) return;
  started = true;
  onRobotStatus((blid, status) => {
    const device = deviceForRobot(blid);
    if (!device) return;
    emitVacuumStatus(device.id, view(status));
    // A job started or ended from the robot, the iRobot app or its schedule: show it now.
    const cached = getCachedState(device.id);
    if (cached && cached.state !== status.cleaning) {
      pollDeviceNow(device.id).catch((err) => logger.debug({ err, id: device.id }, 'Roomba re-read failed'));
    }
  });
}
