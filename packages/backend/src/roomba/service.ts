/**
 * Ties robot connections to HomeHub's devices: a robot's status goes to open
 * screens as it changes, and a job starting or ending updates its on/off at
 * once rather than at the next poll.
 */
import { getDb } from '../db';
import { emitDeviceState, emitVacuumRooms, emitVacuumStatus } from '../socket';
import { getCachedState, noteState, pollDeviceNow } from '../kasa/device.cache';
import { cancelPowerTimer } from '../devices/power';
import { loginOf } from '../drivers/RoombaDriver';
import { onRobotStatus, onRoomJob, peekStatus, readStatus, sendRoomJob } from './link';
import type { RobotStatus } from './protocol';
import { RoomError, jobFor, learnFromJob, roomsView } from './rooms';
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

/** Thrown when a robot is asked to clean rooms while it's out on a job. */
export class VacuumBusyError extends RoomError {
  constructor(alias: string) { super(`${alias} is already cleaning. Send it home first, then start the rooms.`, 409); }
}

/**
 * Starts the robot on these named rooms, in this order, recorded as switching it on. Refused while
 * it's out on a job, as the iRobot app does: a new job would quietly replace the one it's on.
 */
export async function cleanRooms(deviceId: number, keys: string[]): Promise<{ alias: string; names: string[] }> {
  const device = getDb().prepare("SELECT id, alias, ip, driver_config FROM devices WHERE id = ? AND driver_type = 'roomba'").get(deviceId) as
    { id: number; alias: string; ip: string; driver_config: string | null } | undefined;
  if (!device) throw new RoomError('Robot vacuum not found', 404);
  const { job, names } = jobFor(device.id, keys);
  const login = loginOf(device.driver_config ? JSON.parse(device.driver_config) : undefined);
  const status = await readStatus(device.ip, login);
  if (status.cleaning) throw new VacuumBusyError(device.alias);
  await sendRoomJob(device.ip, login, job);
  noteState(device.id, true);
  getDb().prepare("UPDATE devices SET turned_on_at = datetime('now') WHERE id = ?").run(device.id);
  cancelPowerTimer(device.id);
  emitDeviceState(device.id, device.alias, true, null);
  return { alias: device.alias, names };
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
  // A job for one room, from anywhere: its room is learned, for someone to name.
  onRoomJob((blid, job) => {
    const device = deviceForRobot(blid);
    if (!device) return;
    try {
      if (!learnFromJob(device.id, job)) return;
      logger.info({ id: device.id, rooms: job.regions.map((r) => r.id) }, 'Roomba room job seen');
      const row = getDb().prepare('SELECT driver_config FROM devices WHERE id = ?').get(device.id) as { driver_config: string | null };
      emitVacuumRooms(device.id, roomsView(row.driver_config));
    } catch (err) {
      logger.warn({ err, id: device.id }, 'Could not keep the Roomba’s room');
    }
  });
}
