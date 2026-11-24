/**
 * How a Wi-Fi Roomba (900, i, s, j and Combo series) talks on the home network,
 * without iRobot's cloud. It's the protocol Home Assistant's Roomba
 * integration and the dorita980 library use:
 *
 * - Finding robots: a UDP "irobotmcs" sent to port 5678 gets a JSON answer
 *   with the robot's name, model and id ("iRobot-<id>" or "Roomba-<id>").
 * - Its password: while someone holds the robot's Home button on the dock
 *   until it chimes, a special packet sent over TLS to port 8883 gets it back.
 *   It's asked for once and saved; nobody types a password.
 * - Control: MQTT over TLS on port 8883, logging in with the id and password.
 *   The robot reports its state as JSON; commands go to the "cmd" topic.
 *
 * The robot takes one local connection at a time. The iRobot app falls back
 * to the cloud while HomeHub holds it, so the app keeps working.
 *
 * Everything here but `discover` and `fetchPassword` is pure, for tests.
 */
import dgram from 'node:dgram';
import tls from 'node:tls';

export const DISCOVERY_PORT = 5678;
export const MQTT_PORT = 8883;

export interface FoundRobot {
  ip:    string;
  /** The robot's id: its MQTT user name. Not a secret, but not shown either. */
  blid:  string;
  /** The name it was given in the iRobot app, e.g. "Roomba i8". */
  name:  string;
  /** e.g. "i855020". */
  sku:   string;
  mac:   string | null;
  /** Only robots that speak MQTT can be controlled. Very old ones don't. */
  mqtt:  boolean;
}

/** A discovery answer, or null if it isn't one from a robot. */
export function parseDiscovery(ip: string, payload: Buffer | string): FoundRobot | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(payload.toString());
  } catch {
    return null;
  }
  const hostname = typeof j.hostname === 'string' ? j.hostname : '';
  const m = hostname.match(/^(?:iRobot|Roomba)-([0-9A-Za-z]+)$/);
  if (!m) return null;
  const mac = typeof j.mac === 'string' && j.mac ? j.mac.replace(/[^0-9a-f]/gi, '').toUpperCase() : null;
  return {
    ip: typeof j.ip === 'string' && j.ip ? j.ip : ip,
    blid: m[1],
    name: typeof j.robotname === 'string' && j.robotname.trim() ? j.robotname.trim() : 'Roomba',
    sku: typeof j.sku === 'string' ? j.sku : '',
    mac,
    mqtt: j.proto === undefined || j.proto === 'mqtt',
  };
}

/**
 * Asks for robots: on each broadcast address, or one robot when `to` is its
 * address. Answers arrive within a second; `waitMs` allows for a slow one.
 */
export function discover(to: string[], waitMs = 4000): Promise<FoundRobot[]> {
  return new Promise((resolve) => {
    const found = new Map<string, FoundRobot>();
    const socket = dgram.createSocket('udp4');
    const done = () => {
      clearInterval(resend);
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve([...found.values()]);
    };
    socket.on('message', (msg, from) => {
      const robot = parseDiscovery(from.address, msg);
      if (robot) found.set(robot.blid, robot);
    });
    socket.on('error', done);
    const ask = () => {
      for (const address of to) socket.send(Buffer.from('irobotmcs'), DISCOVERY_PORT, address, () => undefined);
    };
    // UDP can be lost, and a robot saving power on its dock can miss the first asks: ask five times.
    let resend: ReturnType<typeof setInterval> | undefined;
    const timer = setTimeout(done, waitMs);
    socket.bind(() => {
      socket.setBroadcast(true);
      ask();
      let asked = 1;
      resend = setInterval(() => { if (++asked > 5) clearInterval(resend); else ask(); }, 600);
    });
  });
}

/** The robot's TLS certificate is its own, so it can't be checked against a CA. */
export const TLS_OPTIONS = { rejectUnauthorized: false, minVersion: 'TLSv1.2' as const };

/** The request for the password: a packet type of the robot's own, not MQTT. */
export const PASSWORD_REQUEST = Buffer.from('f005efcc3b2900', 'hex');

/**
 * The password from the robot's answer, once all of it has arrived; undefined
 * while more is to come; null if the robot answered without one (it wasn't in
 * pairing mode). The answer is f0, a length, ef cc 3b 29 00, then the password
 * and a trailing 00.
 */
export function decodePassword(data: Buffer): string | null | undefined {
  if (data.length < 2) return undefined;
  if (data[0] !== 0xf0) return null;
  // The length is MQTT's: 7 bits per byte, the top bit meaning another follows.
  let length = 0;
  let i = 1;
  for (let shift = 0; i < data.length && i < 5; i++, shift += 7) {
    length += (data[i] & 0x7f) << shift;
    if (!(data[i] & 0x80)) break;
  }
  if (i >= data.length) return undefined;
  const start = i + 1;
  if (data.length < start + length) return undefined;
  const body = data.subarray(start, start + length);
  if (body.length <= 5 || body.subarray(0, 5).compare(PASSWORD_REQUEST.subarray(2)) !== 0) return null;
  const password = body.subarray(5).toString('utf8').replace(/\0+$/, '');
  return password || null;
}

/**
 * The robot's password, or null if it didn't give one: nobody was holding its
 * Home button, or it hadn't chimed yet.
 */
export function fetchPassword(ip: string, timeoutMs = 6000): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let got = Buffer.alloc(0);
    let settled = false;
    const finish = (result: string | null, err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err); else resolve(result);
    };
    const socket = tls.connect({ host: ip, port: MQTT_PORT, ...TLS_OPTIONS }, () => socket.write(PASSWORD_REQUEST));
    socket.on('data', (chunk: Buffer) => {
      got = Buffer.concat([got, chunk]);
      const password = decodePassword(got);
      if (password !== undefined) finish(password);
    });
    // Not in pairing mode, a robot just closes the connection.
    socket.on('end', () => finish(null));
    socket.on('close', () => finish(null));
    socket.on('error', (err) => finish(null, err));
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

// ── State ──────────────────────────────────────────────────────────

export type Activity =
  | 'cleaning' | 'paused' | 'stuck'
  /** Gone back to recharge part way, and will carry on. */
  | 'recharging'
  | 'returning' | 'emptying' | 'docked' | 'idle';

export interface RobotStatus {
  activity: Activity;
  /** Out on a cleaning job, paused or recharging part way included: "on" to the rest of HomeHub. */
  cleaning: boolean;
  battery:  number | null;
  binFull:  boolean;
  /** In words, when the robot reports a problem. */
  error:    string | null;
  /** The name it was given in the iRobot app. */
  name:     string | null;
}

/** The robot's state as it reports it: only what HomeHub reads. */
export interface Reported {
  name?: string;
  batPct?: number;
  bin?: { present?: boolean; full?: boolean };
  cleanMissionStatus?: { cycle?: string; phase?: string; error?: number; notReady?: number };
  /** The last job it was given, from any app: a room clean names its map and rooms. */
  lastCommand?: { command?: string; pmap_id?: string; user_pmapv_id?: string; regions?: { region_id?: unknown; type?: unknown }[] };
}

/** A room on the robot's map: its id there, and "rid" for a room ("zid" is a zone drawn in the app). */
export interface Region { id: string; type: string }

/** A job for particular rooms: which map, which version of it, and the rooms in order. */
export interface RoomJob { pmapId: string; versionId: string; regions: Region[] }

/**
 * The rooms the robot was last sent to, from its reported lastCommand. The robot knows rooms
 * only by number; their names live in iRobot's cloud, so HomeHub learns each from a job run once.
 */
export function roomJobOf(r: Reported): RoomJob | null {
  const c = r.lastCommand;
  if (!c || c.command !== 'start' || typeof c.pmap_id !== 'string' || !c.pmap_id || !Array.isArray(c.regions)) return null;
  const regions = c.regions
    .map((x) => ({ id: typeof x?.region_id === 'string' || typeof x?.region_id === 'number' ? String(x.region_id) : '', type: typeof x?.type === 'string' ? x.type : 'rid' }))
    .filter((x) => x.id);
  if (!regions.length) return null;
  return { pmapId: c.pmap_id, versionId: typeof c.user_pmapv_id === 'string' ? c.user_pmapv_id : '', regions };
}

/** Starts a job for these rooms, in this order, as the iRobot app does. */
export const roomsPayload = (job: RoomJob, now = Date.now()): string => JSON.stringify({
  command: 'start',
  ordered: 1,
  pmap_id: job.pmapId,
  regions: job.regions.map((r) => ({ region_id: r.id, type: r.type })),
  ...(job.versionId ? { user_pmapv_id: job.versionId } : {}),
  time: Math.floor(now / 1000),
  initiator: 'localApp',
});

/**
 * The common problems, in words. Codes from iRobot's app as Home Assistant
 * lists them; anything else is "Error N", which the iRobot app explains.
 */
const ERRORS: Record<number, string> = {
  1: 'Left wheel off the floor',
  2: 'Main brushes stuck',
  3: 'Right wheel off the floor',
  4: 'Left wheel stuck',
  5: 'Right wheel stuck',
  6: 'Stuck near a drop',
  7: 'Left wheel problem',
  8: 'Bin problem',
  9: 'Bumper stuck',
  10: 'Right wheel problem',
  11: 'Bin problem',
  12: 'Cliff sensor problem',
  13: 'Both wheels off the floor',
  14: 'Bin missing',
  15: 'Needs a restart',
  16: 'Bumped unexpectedly',
  17: 'Path blocked',
  18: 'Docking problem',
  19: 'Undocking problem',
  20: 'Docking problem',
  21: 'Navigation problem',
  22: 'Navigation problem',
  23: 'Battery problem',
  24: 'Navigation problem',
  25: 'Needs a restart',
  26: 'Vacuum problem',
  27: 'Vacuum problem',
  36: 'Bin full',
  46: 'Battery low',
};

export const errorText = (code: number): string => ERRORS[code] ?? `Error ${code}`;

/** Cycles that aren't a cleaning job: none, going home, emptying the bin by hand. */
const NOT_A_JOB = new Set(['none', 'dock', 'evac', '']);

/** Merges a state update into what's known. Updates carry only what changed. */
export function mergeReported(into: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(update)) {
    const old = into[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && old && typeof old === 'object' && !Array.isArray(old)) {
      mergeReported(old as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      into[k] = v;
    }
  }
  return into;
}

/** What the robot is doing, from what it reported; null until it has said. */
export function statusOf(r: Reported): RobotStatus | null {
  const mission = r.cleanMissionStatus;
  if (!mission || typeof mission.phase !== 'string') return null;
  const cycle = mission.cycle ?? 'none';
  const phase = mission.phase;
  const job = !NOT_A_JOB.has(cycle);
  const code = typeof mission.error === 'number' && mission.error > 0 ? mission.error : 0;

  let activity: Activity;
  if (phase === 'stuck') activity = 'stuck';
  else if (phase === 'run') activity = 'cleaning';
  else if (phase === 'hmMidMsn') activity = 'recharging';
  else if (phase === 'hmUsrDock' || phase === 'hmPostMsn') activity = 'returning';
  else if (phase === 'evac') activity = 'emptying';
  else if (phase === 'charge') activity = job ? 'recharging' : 'docked';
  else if (phase === 'stop' || phase === 'pause') activity = job ? 'paused' : 'idle';
  else activity = 'idle';

  // On a job unless it's heading home for good. Emptying part way is still the job.
  const cleaning = job && activity !== 'returning';
  return {
    activity,
    cleaning,
    battery: typeof r.batPct === 'number' ? r.batPct : null,
    binFull: r.bin?.full === true,
    error: code ? errorText(code) : null,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : null,
  };
}

export type Command = 'start' | 'pause' | 'resume' | 'stop' | 'dock';

/** A command as the robot takes it on the "cmd" topic. */
export const commandPayload = (command: Command, now = Date.now()): string =>
  JSON.stringify({ command, time: Math.floor(now / 1000), initiator: 'localApp' });
