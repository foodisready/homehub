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
import { onRobotStatus, onRoomJob, peekStatus, readStatus, sendCommand, sendRoomJob, type RobotLogin } from './link';
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

/** Thrown when the robot was sent a job and didn't set off. */
export class VacuumDidNotStartError extends RoomError {
  constructor(alias: string) { super(`${alias} didn’t start. Check it in the iRobot app.`, 502); }
}

/** Doing something it would have to drop for a new job. Paused, at home or not, it isn't. */
const BUSY = new Set(['cleaning', 'returning', 'emptying', 'recharging']);
export const vacuumBusy = (s: Pick<RobotStatus, 'activity'>) => BUSY.has(s.activity);

const waits = { endMs: 10_000, startMs: 20_000, stepMs: 500 };
export function setWaitsForTests(w: Partial<typeof waits>): void { Object.assign(waits, w); }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reads the robot until it's as wanted, or the time's up. True if it got there. */
async function waitFor(ip: string, login: RobotLogin, ok: (s: RobotStatus) => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (ok(await readStatus(ip, login))) return true;
    if (Date.now() >= until) return false;
    await sleep(waits.stepMs);
  }
}

/**
 * Starts the robot on these named rooms, in this order, or with none, the whole house: recorded as
 * switching it on once it has set off. Refused while it's busy on a job, as the iRobot app does.
 * A job it holds paused is ended first: a robot ignores a new job while it has one open.
 */
export async function cleanRooms(deviceId: number, keys: string[]): Promise<{ alias: string; names: string[] }> {
  const device = getDb().prepare("SELECT id, alias, ip, driver_config FROM devices WHERE id = ? AND driver_type = 'roomba'").get(deviceId) as
    { id: number; alias: string; ip: string; driver_config: string | null } | undefined;
  if (!device) throw new RoomError('Robot vacuum not found', 404);
  const { job, names } = keys.length ? jobFor(device.id, keys) : { job: null, names: [] };
  const login = loginOf(device.driver_config ? JSON.parse(device.driver_config) : undefined);
  const status = await readStatus(device.ip, login);
  if (vacuumBusy(status)) throw new VacuumBusyError(device.alias);
  if (status.jobOpen) {
    await sendCommand(device.ip, login, 'stop');
    if (!(await waitFor(device.ip, login, (s) => !s.jobOpen, waits.endMs))) {
      throw new RoomError(`${device.alias} is holding on to its last job. End it in the iRobot app, then try again.`, 502);
    }
  }
  if (job) await sendRoomJob(device.ip, login, job);
  else await sendCommand(device.ip, login, 'start');
  const off = await waitFor(device.ip, login, (s) => s.cleaning && s.activity !== 'paused', waits.startMs);
  if (!off) {
    logger.warn({ id: device.id, rooms: job?.regions.map((r) => r.id) ?? 'all' }, 'Roomba didn’t take the job');
    throw new VacuumDidNotStartError(device.alias);
  }
  noteState(device.id, true);
  getDb().prepare("UPDATE devices SET turned_on_at = datetime('now') WHERE id = ?").run(device.id);
  cancelPowerTimer(device.id);
  emitDeviceState(device.id, device.alias, true, null);
  return { alias: device.alias, names };
}

/** Ends the job it holds, running or paused, leaving it where it is: the iRobot app's "End now". */
export async function endJob(deviceId: number): Promise<{ alias: string }> {
  const device = getDb().prepare("SELECT id, alias, ip, driver_config FROM devices WHERE id = ? AND driver_type = 'roomba'").get(deviceId) as
    { id: number; alias: string; ip: string; driver_config: string | null } | undefined;
  if (!device) throw new RoomError('Robot vacuum not found', 404);
  const login = loginOf(device.driver_config ? JSON.parse(device.driver_config) : undefined);
  const status = await readStatus(device.ip, login);
  if (!status.jobOpen) throw new RoomError(`${device.alias} has no job to end`, 409);
  await sendCommand(device.ip, login, 'stop');
  if (!(await waitFor(device.ip, login, (s) => !s.jobOpen, waits.endMs))) {
    throw new RoomError(`${device.alias} didn’t end its job. Try the iRobot app.`, 502);
  }
  return { alias: device.alias };
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
