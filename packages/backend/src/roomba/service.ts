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
import { onJobStart, onRobotStatus, onRoomJob, peekStatus, readStatus, sendCommand, sendRoomJob, type RobotLogin } from './link';
import type { RobotStatus } from './protocol';
import { RoomError, autoResumeOn, jobFor, keepStart, keptRoomsFor, learnFromJob, roomsOf, roomsView } from './rooms';
import { withActivity } from '../activity/activity';
import { sendPushToUsers } from '../push/push.service';
import type { RoomJob } from './protocol';
import { logger } from '../logger';

/** What the dashboard shows of a robot vacuum: its job's rooms by name. */
export type VacuumView = Omit<RobotStatus, 'name' | 'jobRooms' | 'jobBegan' | 'wentHomeFor'> & {
  /** HomeHub carries on a job the robot stopped at home, once it's charged. */
  autoResume: boolean;
  /** The job it holds: the whole house, or these rooms in order (one not named yet as null). */
  job: { whole: boolean; rooms: (string | null)[] } | null;
};

function view(deviceId: number, status: RobotStatus): VacuumView {
  let autoResume = true;
  try { autoResume = autoResumeOn(deviceId); } catch { /* removed meanwhile */ }
  return { ...jobView(deviceId, status), autoResume };
}

function jobView(deviceId: number, { name: _name, jobRooms: reported, jobBegan, wentHomeFor: _why, ...rest }: RobotStatus): Omit<VacuumView, 'autoResume'> {
  // The robot names the job's rooms only until its next command; after a restart, the start kept then does.
  let jobRooms = reported;
  if (!jobRooms && rest.jobOpen) { try { jobRooms = keptRoomsFor(deviceId, jobBegan); } catch { /* removed meanwhile */ } }
  if (!jobRooms) return { ...rest, job: null };
  if (jobRooms === 'all') return { ...rest, job: { whole: true, rooms: [] } };
  let known: { id: string; name: string | null }[] = [];
  try { known = roomsOf(deviceId); } catch { /* removed meanwhile */ }
  return { ...rest, job: { whole: false, rooms: jobRooms.map((id) => known.find((r) => r.id === id)?.name ?? null) } };
}

const blidOf = (driverConfig: string | null): string | null => {
  try {
    const blid = driverConfig ? JSON.parse(driverConfig)?.blid : null;
    return typeof blid === 'string' ? blid : null;
  } catch {
    return null;
  }
};

/** The robot's status for the device list, or null while HomeHub isn't connected to it. */
export function vacuumViewOf(deviceId: number, driverConfig: string | null): VacuumView | null {
  const blid = blidOf(driverConfig);
  const status = blid ? peekStatus(blid) : null;
  return status ? view(deviceId, status) : null;
}

/** Robots HomeHub is starting: their setting off is HomeHub's, recorded once it's seen, not "outside". */
const starting = new Set<number>();

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
  starting.add(device.id);
  try {
    await startJob(device, login, status, job);
  } finally {
    starting.delete(device.id);
  }
  noteState(device.id, true);
  getDb().prepare("UPDATE devices SET turned_on_at = datetime('now') WHERE id = ?").run(device.id);
  cancelPowerTimer(device.id);
  emitDeviceState(device.id, device.alias, true, null);
  return { alias: device.alias, names };
}

/** Ends a job it holds paused, sends the new one and waits to see it set off. */
async function startJob(device: { id: number; alias: string; ip: string }, login: RobotLogin, status: RobotStatus, job: RoomJob | null): Promise<void> {
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

// ── Carrying on a job the robot stopped at home ──────────────────
// A robot that went home part way, to recharge or empty its bin, sometimes sits there with a full
// battery instead of carrying on. HomeHub resumes it then, but only when it saw the robot go home by
// itself (never when someone sent it), after giving it a while to carry on unaided, and only twice a
// job: a robot that keeps stopping needs a person, so HomeHub says so instead.

const auto = { waitMs: 5 * 60_000, maxTries: 2, fullAt: 95, checkMs: 60_000 };
export function setAutoResumeForTests(w: Partial<typeof auto>): void { Object.assign(auto, w); watches.clear(); }

interface Watch { since: number; job: number | null; tries: number; gaveUp: boolean }
const watches = new Map<number, Watch>();

/** Stopped at home, by its own choice, ready to go again. */
export function readyToCarryOn(s: RobotStatus): boolean {
  return s.activity === 'paused' && s.onDock && s.jobOpen
    && (s.wentHomeFor === 'recharge' || s.wentHomeFor === 'empty')
    && (s.battery ?? 0) >= auto.fullAt && !s.binFull && !s.error;
}

export async function checkAutoResume(now = Date.now()): Promise<void> {
  const rows = getDb().prepare("SELECT id, alias, ip, driver_config FROM devices WHERE driver_type = 'roomba'").all() as
    { id: number; alias: string; ip: string; driver_config: string | null }[];
  for (const d of rows) {
    const blid = blidOf(d.driver_config);
    const s = blid ? peekStatus(blid) : null;
    if (!s || !autoResumeOn(d.id)) { watches.delete(d.id); continue; }
    let w = watches.get(d.id);
    if (w && w.job !== s.jobBegan) { watches.delete(d.id); w = undefined; }
    if (!readyToCarryOn(s)) { if (w) w.since = 0; continue; }
    if (!w) { w = { since: now, job: s.jobBegan, tries: 0, gaveUp: false }; watches.set(d.id, w); }
    if (!w.since) w.since = now;
    if (now - w.since < auto.waitMs) continue;
    if (w.tries >= auto.maxTries) {
      if (!w.gaveUp) {
        w.gaveUp = true;
        logger.warn({ id: d.id }, 'Roomba keeps stopping at home; not carrying on again');
        const admins = (getDb().prepare("SELECT id FROM users WHERE role = 'admin'").all() as { id: number }[]).map((u) => u.id);
        sendPushToUsers(admins, `${d.alias} keeps stopping`, 'It went home part way and stopped again. Check its bin, the bin’s sensors and the Clean Base’s bag.', { url: '/dashboard', deviceId: d.id });
      }
      continue;
    }
    w.tries++;
    w.since = 0;
    const why = s.wentHomeFor === 'empty' ? 'after emptying its bin' : 'after recharging';
    try {
      const login = loginOf(d.driver_config ? JSON.parse(d.driver_config) : undefined);
      starting.add(d.id);
      try {
        await sendCommand(d.ip, login, 'resume');
        if (!(await waitFor(d.ip, login, (x) => x.cleaning && x.activity !== 'paused', waits.startMs))) throw new Error('didn’t set off');
      } finally {
        starting.delete(d.id);
      }
      withActivity({ source: 'homehub', detail: `HomeHub carried on the job ${why}` }, () => noteState(d.id, true));
      emitDeviceState(d.id, d.alias, true, null);
      logger.info({ id: d.id, try: w.tries, why }, 'Roomba job carried on');
    } catch (err) {
      logger.warn({ id: d.id, reason: (err as Error).message }, 'Could not carry on the Roomba’s job');
    }
  }
}

let started = false;

export function startRoombaUpdates(): void {
  if (started) return;
  started = true;
  setInterval(() => { checkAutoResume().catch((err) => logger.warn({ err }, 'Roomba carry-on check failed')); }, auto.checkMs).unref();
  onRobotStatus((blid, status) => {
    const device = deviceForRobot(blid);
    if (!device) return;
    emitVacuumStatus(device.id, view(device.id, status));
    // A job started or ended from the robot, the iRobot app or its schedule: show it now.
    const cached = getCachedState(device.id);
    if (cached && cached.state !== status.cleaning && !starting.has(device.id)) {
      pollDeviceNow(device.id).catch((err) => logger.debug({ err, id: device.id }, 'Roomba re-read failed'));
    }
  });
  // Every start, kept, so the job's rooms are still known after the robot's next command or a restart.
  onJobStart((blid, start) => {
    const device = deviceForRobot(blid);
    if (!device) return;
    try { keepStart(device.id, start); } catch (err) { logger.warn({ err, id: device.id }, 'Could not keep the Roomba’s start'); }
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
