/**
 * One connection per robot, kept open: the robot pushes its state as it
 * changes, so HomeHub knows at once when it starts, gets stuck or docks.
 *
 * The robot takes a single local connection, so only the active HomeHub
 * connects (a backup would take it from the active one), and a robot nothing
 * has asked about for a while is let go.
 */
import mqtt, { type MqttClient } from 'mqtt';
import { logger } from '../logger';
import {
  MQTT_PORT, TLS_OPTIONS, commandPayload, mergeReported, roomJobOf, roomsPayload, statusOf,
  type Command, type Reported, type RobotStatus, type RoomJob,
} from './protocol';

export interface RobotLogin { blid: string; password: string }

/** How long a reader waits for a robot that's connecting to say what it's doing. */
const FIRST_STATE_MS = 10_000;
/** Between tries when the robot can't be reached. */
const RECONNECT_MS = 15_000;
/** A robot nothing has asked about for this long is let go. Polling asks every 30 s. */
const IDLE_MS = 10 * 60_000;

type Listener = (blid: string, status: RobotStatus) => void;
const listeners: Listener[] = [];

/** Runs when a robot's status changes: what it's doing, its battery, bin or error. */
export function onRobotStatus(listener: Listener): void {
  listeners.push(listener);
}

type JobListener = (blid: string, job: RoomJob) => void;
const jobListeners: JobListener[] = [];

/** Runs when the robot reports a room job it was given, from HomeHub, the iRobot app or its own schedule. */
export function onRoomJob(listener: JobListener): void {
  jobListeners.push(listener);
}

/** For tests: replaces how a connection is made. */
let connect: (url: string, options: mqtt.IClientOptions) => MqttClient = (url, options) => mqtt.connect(url, options);
export function setConnectForTests(fn: typeof connect): void { connect = fn; }

class Link {
  private client: MqttClient | null = null;
  private reported: Record<string, unknown> = {};
  private status: RobotStatus | null = null;
  private waiting: (() => void)[] = [];
  /** The last try to connect failed: say so at once rather than wait for the next. */
  private down = false;
  /** The last room job reported, so one seen again on reconnecting isn't news. */
  private lastJob = '';
  lastUsed = Date.now();

  constructor(readonly ip: string, readonly login: RobotLogin) {}

  get connected(): boolean {
    return !!this.client?.connected;
  }

  /** The robot's status; waits for the first report when just connecting. */
  async read(): Promise<RobotStatus> {
    this.lastUsed = Date.now();
    this.open();
    if (this.connected && this.status) return this.status;
    if (this.down) throw new Error(`Roomba at ${this.ip} isn't answering`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, FIRST_STATE_MS);
      function done() { clearTimeout(timer); resolve(); }
      this.waiting.push(done);
    });
    if (!this.connected || !this.status) throw new Error(`Roomba at ${this.ip} isn't answering`);
    return this.status;
  }

  async send(command: Command): Promise<void> {
    await this.publish(commandPayload(command));
    logger.info({ ip: this.ip, command }, 'Roomba command sent');
  }

  async sendRooms(job: RoomJob): Promise<void> {
    await this.publish(roomsPayload(job));
    logger.info({ ip: this.ip, rooms: job.regions.map((r) => r.id) }, 'Roomba room clean sent');
  }

  private async publish(payload: string): Promise<void> {
    this.lastUsed = Date.now();
    await this.read();   // connected, or throws
    await new Promise<void>((resolve, reject) => {
      this.client!.publish('cmd', payload, { qos: 0 }, (err) => (err ? reject(err) : resolve()));
    });
  }

  private open(): void {
    if (this.client) return;
    const { blid, password } = this.login;
    const client = connect(`mqtts://${this.ip}:${MQTT_PORT}`, {
      ...TLS_OPTIONS,
      clientId: blid,
      username: blid,
      password,
      protocolVersion: 4,
      clean: true,
      keepalive: 60,
      connectTimeout: 10_000,
      reconnectPeriod: RECONNECT_MS,
    });
    this.client = client;
    let warned = false;
    client.on('connect', () => {
      warned = false;
      this.down = false;
      logger.info({ ip: this.ip }, 'Connected to Roomba');
      client.subscribe('#', { qos: 0 }, () => undefined);
    });
    client.on('message', (_topic, payload) => this.onMessage(payload));
    client.on('error', (err) => {
      // Said once per outage: the client keeps trying every RECONNECT_MS.
      if (!warned) logger.warn({ ip: this.ip, reason: err.message }, 'Roomba connection failed');
      warned = true;
      // A wrong password won't come right by trying again.
      if (/not authorized|bad user ?name or password/i.test(err.message)) this.wake();
    });
    client.on('close', () => {
      this.down = true;
      this.wake();
    });
  }

  private onMessage(payload: Buffer): void {
    let update: unknown;
    try {
      update = JSON.parse(payload.toString());
    } catch {
      return;
    }
    const reported = (update as { state?: { reported?: unknown } })?.state?.reported;
    if (!reported || typeof reported !== 'object') return;
    mergeReported(this.reported, reported as Record<string, unknown>);
    // lastCommand is replaced whole, not merged: a whole-house job has no rooms to keep from the last.
    if ('lastCommand' in (reported as Record<string, unknown>)) this.reported.lastCommand = (reported as Record<string, unknown>).lastCommand;
    const job = 'lastCommand' in (reported as Record<string, unknown>) ? roomJobOf(this.reported as Reported) : null;
    if (job) {
      const key = JSON.stringify(job);
      if (key !== this.lastJob) {
        this.lastJob = key;
        for (const listener of jobListeners) listener(this.login.blid, job);
      }
    }
    const next = statusOf(this.reported as Reported);
    if (!next) return;
    const changed = !this.status || (Object.keys(next) as (keyof RobotStatus)[]).some((k) => next[k] !== this.status![k]);
    this.status = next;
    this.wake();
    if (changed) for (const listener of listeners) listener(this.login.blid, next);
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = [];
    waiting.forEach((done) => done());
  }

  /** The last status, without asking: null before the first report or while it can't be reached. */
  peek(): RobotStatus | null {
    return this.connected ? this.status : null;
  }

  close(): void {
    this.client?.end(true);
    this.client = null;
    this.status = null;
    this.reported = {};
    this.wake();
  }
}

const links = new Map<string, Link>();

/** The robot's connection, opened when first asked for. A new address or password starts it again. */
function linkFor(ip: string, login: RobotLogin): Link {
  const link = links.get(login.blid);
  if (link && link.ip === ip && link.login.password === login.password) return link;
  link?.close();
  const fresh = new Link(ip, login);
  links.set(login.blid, fresh);
  return fresh;
}

export const readStatus = (ip: string, login: RobotLogin): Promise<RobotStatus> => linkFor(ip, login).read();

export const sendCommand = (ip: string, login: RobotLogin, command: Command): Promise<void> => linkFor(ip, login).send(command);

export const sendRoomJob = (ip: string, login: RobotLogin, job: RoomJob): Promise<void> => linkFor(ip, login).sendRooms(job);

/** The robot's status as last reported, or null if HomeHub isn't connected to it. */
export const peekStatus = (blid: string): RobotStatus | null => links.get(blid)?.peek() ?? null;

/** Lets go of robots nothing has asked about lately, e.g. one that was removed from HomeHub. */
export function closeIdle(now = Date.now()): void {
  for (const [blid, link] of links) {
    if (now - link.lastUsed < IDLE_MS) continue;
    link.close();
    links.delete(blid);
    logger.info({ ip: link.ip }, 'Let go of Roomba nothing asked about');
  }
}

/** Lets go of one robot now: it was removed, or is being paired again. */
export function closeLink(blid: string): void {
  links.get(blid)?.close();
  links.delete(blid);
}

/** For tests and shutdown. */
export function closeAll(): void {
  for (const link of links.values()) link.close();
  links.clear();
}

setInterval(() => closeIdle(), 60_000).unref();
