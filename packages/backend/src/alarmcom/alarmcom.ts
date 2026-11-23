import { getDb } from '../db';
import { logger } from '../logger';
import { isActiveServer } from '../system/role';
import { emitAlarmState } from '../socket';
import { ADC_BASE, adcLibrary, devBase } from './adc-client';
import { checkAlarmPin, hasAlarmPin, alarmPinLength } from './alarm-pin';
import {
  AdcError,
  type AdcChallenge, type AdcConnector, type AdcEvent, type AdcPartition, type AdcSensor, type AdcSession, type AdcSnapshot,
  type ArmCommand, type ArmState, type CodeMethod,
} from './types';

/**
 * The alarm system, through Alarm.com: whether it's armed, each sensor (doors, windows, motion),
 * and arming and disarming from the app.
 *
 * - An admin signs in under Settings → Integrations → Alarm.com. Alarm.com usually wants a code
 *   the first time; after that it trusts this HomeHub (a "trusted device" token, kept on this
 *   HomeHub only and left out of backups, like the Ring token).
 * - Alarm.com asks for the password again when a session ends, so HomeHub keeps it, as it does
 *   for Total Connect Comfort. Each sign-in sends the account a "Successful Login" alert, so
 *   HomeHub keeps one session going (Alarm.com's keep-alive every minute) and signs in again
 *   only when it has ended, one at a time, waiting longer after each failure. A password
 *   Alarm.com refuses is tried once only: HomeHub stops and Settings asks to sign in again.
 * - Only the active HomeHub connects. Alarm.com's websocket tells it about changes as they happen;
 *   it also reads everything every POLL_MS (every LIVE_POLL_MS while the websocket is up).
 * - Arming and disarming come from the app only, never from Chat, voice, scenes, schedules or
 *   assistants. Disarming needs the alarm PIN (alarm-pin.ts). A command is sent once: if
 *   Alarm.com doesn't answer, HomeHub reads the alarm rather than sending it again.
 * - The alarm's history (who armed it, doors opening) is kept in alarm_events, pruned with Activity.
 */

const USERNAME = 'alarmcom_username';
const PASSWORD = 'alarmcom_password';
/** The trusted-device token: this HomeHub's alone (json-backup THIS_HOMEHUB_ONLY). */
export const TRUST_KEY = 'alarmcom_trust';
/** 'rejected' once Alarm.com refuses the saved sign-in; cleared by signing in again. */
const STATE = 'alarmcom_state';
const MESSAGE = 'alarmcom_message';

/** Without live updates: how often HomeHub reads everything. */
export const POLL_MS = Number(process.env.ALARMCOM_POLL_MS) || 60_000;
/** With live updates: a safety net, as Home Assistant does. */
export const LIVE_POLL_MS = 5 * 60_000;
const KEEPALIVE_MS = 60_000;
const FIRST_CHECK_MS = 5_000;
/** After a failure, wait this long, doubling each time up to the limit. */
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
/** A sign-in waiting for its code is kept this long. */
const PENDING_MS = 10 * 60_000;
/** Read everything this long after a live change, to settle anything the change didn't say. */
const SETTLE_READ_MS = Number(process.env.ALARMCOM_SETTLE_MS) || 3_000;
/** A read asked for by a browser (the app opened) at most this often. */
const FRESH_MS = 10_000;
/** After a command, read at these times (ms) until the alarm shows the new state. */
const CONFIRM_AT = (process.env.ALARMCOM_CONFIRM_AT ?? '3000,8000,15000,30000,60000,90000,120000,180000').split(',').map(Number);
/** How long the app waits for Alarm.com to take a command before showing it as under way. */
const ANSWER_WAIT_MS = Number(process.env.ALARMCOM_ANSWER_WAIT_MS) || 10_000;
/** An "opened and closed" from the websocket shows as open this long. */
const PULSE_MS = 2_000;

// ── Saved account ──────────────────────────────────────────────────

const setting = (key: string): string | null =>
  (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value || null;
const put = (key: string, value: string | null) => {
  if (value === null) getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
  else getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
};

export interface AccountStatus {
  username: string | null;
  signedIn: boolean;
  /** Alarm.com refused the saved sign-in since, or wants a code again; sign in again. */
  rejected: boolean;
  message: string | null;
  /** An alarm PIN is set, so disarming from HomeHub is possible. */
  pinSet: boolean;
}

export function accountStatus(): AccountStatus {
  const signedIn = !!setting(USERNAME) && !!setting(PASSWORD);
  return {
    username: setting(USERNAME), signedIn,
    rejected: signedIn && setting(STATE) === 'rejected',
    message: signedIn ? setting(MESSAGE) : null,
    pinSet: hasAlarmPin(),
  };
}

const signedIn = () => !!setting(USERNAME) && !!setting(PASSWORD);

// ── What HomeHub shows ─────────────────────────────────────────────

export type Connection = 'signed-out' | 'standby' | 'connecting' | 'ready' | 'expired' | 'error';

export interface AlarmEvent { at: string; kind: 'arm' | 'sensor'; name: string; state: string; source: 'app' | 'outside'; userName: string | null; detail: string | null }

export interface AlarmView {
  connection: Connection;
  detail: string | null;
  partitions: AdcPartition[];
  sensors: AdcSensor[];
  /** When Alarm.com last answered. */
  updatedAt: string | null;
  /** Alarm.com is telling HomeHub about changes as they happen. */
  live: boolean;
  /** Disarming asks for a PIN this many digits long; null when no PIN is set (so no disarming). */
  pinLength: number | null;
  /** The latest arming, disarming and sensor changes, newest first. */
  recent: AlarmEvent[];
}

let connector: AdcConnector = adcLibrary;
/** For tests: replace Alarm.com with a fake. */
export function setAdcConnectorForTests(c: AdcConnector): void { connector = c; }

let session: AdcSession | null = null;
let stopWatch: (() => void) | null = null;
let live = false;
let connection: Exclude<Connection, 'signed-out' | 'standby'> = 'connecting';
let detail: string | null = null;
let snapshot: AdcSnapshot | null = null;
let updatedAt = 0;
let lastKeepAlive = 0;
let lastPoll = 0;
let failures = 0;
let retryAt = 0;
let busy: Promise<void> | null = null;
let settleTimer: NodeJS.Timeout | null = null;
/** Motion sensors the websocket said went quiet: Alarm.com goes on reporting "active" for a long while after. */
const quiet = new Set<string>();
/** Commands sent from HomeHub and not yet seen through, by partition: who, so the change is logged as theirs. */
const commands = new Map<string, { target: ArmState; userName: string | null; at: number }>();

/** Connects on this HomeHub: the active one, or any pointed at a fake Alarm.com for development. */
const mayConnect = () => isActiveServer() || devBase() !== ADC_BASE;

/** Why HomeHub shouldn't be connected now, or null if it should. */
function holdReason(): Connection | null {
  if (!signedIn()) return 'signed-out';
  if (setting(STATE) === 'rejected') return 'expired';
  if (!mayConnect()) return 'standby';
  return null;
}

function recent(limit = 12): AlarmEvent[] {
  return (getDb().prepare('SELECT at, kind, name, state, source, user_name, detail FROM alarm_events ORDER BY id DESC LIMIT ?').all(limit) as
    { at: string; kind: 'arm' | 'sensor'; name: string; state: string; source: 'app' | 'outside'; user_name: string | null; detail: string | null }[])
    .map((r) => ({ at: r.at, kind: r.kind, name: r.name, state: r.state, source: r.source, userName: r.user_name, detail: r.detail }));
}

export function alarmView(): AlarmView {
  const hold = holdReason();
  const conn = hold ?? connection;
  const out = hold === 'signed-out';
  return {
    connection: conn,
    detail: conn === 'expired' ? setting(MESSAGE) ?? detail : conn === 'error' ? detail : null,
    partitions: out ? [] : (snapshot?.partitions ?? []).map((p) => {
      const cmd = commands.get(p.id);
      return cmd && !p.pending && p.state !== cmd.target ? { ...p, pending: cmd.target } : p;
    }),
    sensors: out ? [] : snapshot?.sensors ?? [],
    updatedAt: updatedAt && !out ? new Date(updatedAt).toISOString() : null,
    live: !hold && live,
    pinLength: alarmPinLength(),
    recent: out ? [] : recent(),
  };
}

/** The view, as last sent to browsers, so an unchanged read sends nothing. */
let lastSent = '';
function publish(): void {
  const view = alarmView();
  const key = JSON.stringify({ ...view, updatedAt: null });
  if (key === lastSent) return;
  lastSent = key;
  emitAlarmState(view);
}

function log(kind: 'arm' | 'sensor', name: string, state: string, source: 'app' | 'outside', userName: string | null = null, detailText: string | null = null): void {
  try {
    getDb().prepare('INSERT INTO alarm_events (kind, name, state, source, user_name, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(kind, name, state, source, userName, detailText);
  } catch (err) {
    logger.warn({ err }, 'Couldn’t save the alarm event');
  }
}

/** Notes an arm state now seen, as HomeHub's command or as from outside (the keypad, the Alarm.com app). */
function sawArmState(p: AdcPartition, from: ArmState | null): void {
  if (p.state === 'unknown' || p.state === from) return;
  const cmd = commands.get(p.id);
  if (cmd && cmd.target === p.state) {
    commands.delete(p.id);
    log('arm', p.name, p.state, 'app', cmd.userName);
  } else {
    log('arm', p.name, p.state, 'outside');
  }
  logger.info({ partition: p.name, from, to: p.state, byHomeHub: !!cmd && cmd.target === p.state }, 'Alarm arm state changed');
}

function sawSensor(s: AdcSensor, from: string): void {
  if (s.kind === 'motion' || s.kind === 'glass') return;   // motion would fill the history; its state shows live
  if (s.state === 'unknown' || from === 'unknown') return;
  log('sensor', s.name, s.state, 'outside');
}

/**
 * Takes a fresh read. Each sensor keeps the time it last changed: Alarm.com's when it gives one,
 * else when HomeHub first saw the change.
 */
function merge(next: AdcSnapshot, now: number): AdcSnapshot {
  const first = !snapshot;
  const before = new Map((snapshot?.sensors ?? []).map((s) => [s.id, s]));
  const sensors = next.sensors.map((s) => {
    let state = s.state;
    if (quiet.has(s.id)) {
      if (state === 'active') state = 'idle';
      else quiet.delete(s.id);
    }
    const old = before.get(s.id);
    const changedAt = s.changedAt ?? (old && old.state === state ? old.changedAt : old ? new Date(now).toISOString() : null);
    if (old && old.state !== state) sawSensor({ ...s, state }, old.state);
    return { ...s, state, changedAt };
  });
  const parts = new Map((snapshot?.partitions ?? []).map((p) => [p.id, p]));
  for (const p of next.partitions) {
    const old = parts.get(p.id);
    if (old && old.state !== p.state) sawArmState(p, old.state);
    else if (first) {
      // HomeHub had no reading: a command it sent may have finished meanwhile.
      const cmd = commands.get(p.id);
      if (cmd && cmd.target === p.state) { commands.delete(p.id); log('arm', p.name, p.state, 'app', cmd.userName); }
    }
  }
  return { partitions: next.partitions, sensors };
}

/** A change Alarm.com announced: shown at once, then everything is read again to settle it. */
function applyEvent(e: AdcEvent): void {
  if (snapshot && e.kind !== 'other') {
    const now = new Date().toISOString();
    if (e.kind === 'partition') {
      snapshot.partitions = snapshot.partitions.map((p) => {
        if (p.id !== e.id || p.state === e.state) return p;
        const next = { ...p, state: e.state, pending: null };
        sawArmState(next, p.state);
        return next;
      });
    } else {
      snapshot.sensors = snapshot.sensors.map((s) => {
        if (s.id !== e.id) return s;
        if (e.kind === 'bypass') return { ...s, bypassed: e.bypassed };
        const activity = s.kind === 'motion' || s.kind === 'glass';
        const on = activity ? 'active' : 'open';
        const off = activity ? 'idle' : 'closed';
        if (e.state === 'open') quiet.delete(s.id);
        if (e.state === 'closed' && activity) quiet.add(s.id);
        const state = e.state === 'closed' ? off : on;
        if (e.state === 'pulse') {
          // Opened and closed again: show it open briefly, then closed, so the change is seen.
          setTimeout(() => {
            if (!snapshot) return;
            snapshot.sensors = snapshot.sensors.map((x) => (x.id === s.id && x.state === on ? { ...x, state: off, changedAt: new Date().toISOString() } : x));
            if (activity) quiet.add(s.id);
            publish();
          }, PULSE_MS).unref();
        }
        if (state === s.state) return s;
        sawSensor({ ...s, state }, s.state);
        return { ...s, state, changedAt: now };
      });
    }
    publish();
  }
  if (settleTimer) return;
  settleTimer = setTimeout(() => { settleTimer = null; void readNow(); }, SETTLE_READ_MS);
  settleTimer.unref();
}

function dropSession(): void {
  stopWatch?.();
  stopWatch = null;
  live = false;
  session?.close();
  session = null;
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = null;
}

function refuse(err: AdcError): void {
  put(STATE, 'rejected');
  put(MESSAGE, err.kind === 'code-needed'
    ? 'Alarm.com wants a new verification code. Sign in again under Settings → Integrations → Alarm.com.'
    : err.message);
  dropSession();
  logger.warn({ reason: err.message, kind: err.kind }, 'Alarm.com refused the saved sign-in; waiting for a new one in Settings');
}

function failed(err: unknown, now: number): void {
  if (err instanceof AdcError && (err.kind === 'rejected' || err.kind === 'code-needed')) {
    refuse(err);
    publish();
    return;
  }
  dropSession();
  failures++;
  retryAt = now + Math.min(RETRY_MIN_MS * 2 ** (failures - 1), RETRY_MAX_MS);
  connection = 'error';
  detail = (err as Error)?.message || String(err);
  logger.warn({ reason: detail, failures, retryInSeconds: Math.round((retryAt - now) / 1000) }, 'Alarm.com read failed');
  publish();
}

async function signInSaved(): Promise<AdcSession> {
  logger.info('Signing in to Alarm.com');
  const result = await connector.signIn(setting(USERNAME)!, setting(PASSWORD)!, setting(TRUST_KEY));
  if (result.kind === 'code') throw new AdcError('Alarm.com wants a verification code', 'code-needed');
  return result.session;
}

function startWatching(s: AdcSession): void {
  lastKeepAlive = Date.now();
  if (!s.watch) return;
  stopWatch = s.watch(
    (e) => { if (session === s) applyEvent(e); },
    (isLive, reason) => {
      if (session !== s || live === isLive) return;
      live = isLive;
      logger.info({ reason }, isLive ? 'Alarm.com live updates on' : 'Alarm.com live updates paused; reading every minute');
      publish();
    },
  );
}

/** A session, signing in if there isn't one. */
async function ensureSession(): Promise<AdcSession> {
  if (session) return session;
  const s = await signInSaved();
  session = s;
  startWatching(s);
  return s;
}

/** Runs fn on the session, signing in again once if the session had ended. */
async function withSession<T>(fn: (s: AdcSession) => Promise<T>): Promise<T> {
  const s = await ensureSession();
  try {
    return await fn(s);
  } catch (err) {
    if (!(err instanceof AdcError) || err.kind !== 'expired') throw err;
    if (session === s) dropSession();
  }
  return fn(await ensureSession());
}

/** One read. */
async function cycle(now: number): Promise<void> {
  if (!snapshot) connection = 'connecting';
  const next = await withSession((s) => s.read());
  snapshot = merge(next, now);
  updatedAt = Date.now();
  connection = 'ready';
  detail = null;
  if (failures) logger.info({ afterFailures: failures }, 'Alarm.com answering again');
  failures = 0;
  retryAt = 0;
  publish();
}

function run(now: number): Promise<void> {
  if (busy) return busy;
  lastPoll = now;
  busy = cycle(now).catch((err) => failed(err, now)).finally(() => { busy = null; });
  return busy;
}

/** Reads now, unless a read is under way (then waits for it) or HomeHub shouldn't connect. */
export async function readNow(now = Date.now()): Promise<void> {
  if (holdReason()) return;
  if (now < retryAt) return;
  return run(now);
}

/** A browser opened the app: read if the last read is older than a few seconds. */
export async function readIfStale(now = Date.now()): Promise<void> {
  if (now - updatedAt < FRESH_MS) return;
  return readNow(now);
}

/** Runs every few seconds: reads when due, keeps the session alive, and lets go when it shouldn't hold on. */
export async function tick(now = Date.now()): Promise<void> {
  const hold = holdReason();
  if (hold) {
    if (session) { dropSession(); logger.info({ reason: hold }, 'Alarm.com disconnected'); }
    publish();
    return;
  }
  if (busy || now < retryAt) return;
  if (now - lastPoll >= (live ? LIVE_POLL_MS : POLL_MS)) return run(now);
  if (session && now - lastKeepAlive >= KEEPALIVE_MS) {
    lastKeepAlive = now;
    const s = session;
    try {
      await s.keepAlive();
    } catch (err) {
      if (err instanceof AdcError && err.kind === 'expired' && session === s) {
        // Read now: that signs in again, once.
        dropSession();
        return run(now);
      }
      logger.debug({ reason: (err as Error).message }, 'Alarm.com keep-alive failed');
    }
  }
}

let timer: NodeJS.Timeout | null = null;

export function startAlarmcom(): void {
  if (timer) return;
  setTimeout(() => { void tick(); }, FIRST_CHECK_MS).unref();
  timer = setInterval(() => { void tick(); }, 5_000);
  timer.unref();
}

export function stopAlarmcom(): void {
  if (timer) clearInterval(timer);
  timer = null;
  dropSession();
}

// ── Arming and disarming ───────────────────────────────────────────

export type ArmMode = 'stay' | 'away' | 'night';
const COMMAND: Record<ArmMode, ArmCommand> = { stay: 'armStay', away: 'armAway', night: 'armNight' };
const TARGET: Record<ArmMode, ArmState> = { stay: 'armed-stay', away: 'armed-away', night: 'armed-night' };

export class AlarmCommandError extends Error {
  constructor(message: string, readonly status = 409, readonly extra: Record<string, unknown> = {}) { super(message); }
}

function partitionFor(id: string | undefined): AdcPartition {
  if (holdReason() || connection !== 'ready' || !snapshot || !session) {
    throw new AlarmCommandError('HomeHub isn’t connected to Alarm.com right now. Use the keypad or the Alarm.com app.', 503);
  }
  const p = id ? snapshot.partitions.find((x) => x.id === id) : snapshot.partitions.length === 1 ? snapshot.partitions[0] : null;
  if (!p) throw new AlarmCommandError(id ? 'That part of the alarm isn’t on the Alarm.com account.' : 'Choose which part of the alarm.', id ? 404 : 400);
  return p;
}

/** Reads until the partition shows the target, then lets go; logs it as not confirmed if it never does. */
function confirm(partitionId: string, target: ArmState, sentAt: number): void {
  for (const ms of CONFIRM_AT) {
    setTimeout(() => {
      const cmd = commands.get(partitionId);
      if (!cmd || cmd.at !== sentAt) return;   // seen through, or replaced by a newer command
      const p = snapshot?.partitions.find((x) => x.id === partitionId);
      if (p && p.state === target) { commands.delete(partitionId); publish(); return; }
      if (ms === CONFIRM_AT[CONFIRM_AT.length - 1]) {
        commands.delete(partitionId);
        log('arm', p?.name ?? 'Alarm', target, 'app', cmd.userName, 'Not confirmed by Alarm.com');
        logger.warn({ partition: p?.name, target }, 'Alarm.com didn’t confirm the alarm command');
        publish();
        return;
      }
      void readNow();
    }, ms).unref();
  }
}

async function send(p: AdcPartition, command: ArmCommand, target: ArmState, bypass: boolean, userName: string | null): Promise<void> {
  const at = Date.now();
  commands.set(p.id, { target, userName, at });
  publish();
  try {
    // Signing in again after an ended session is safe: Alarm.com turned the command away, so it didn't happen.
    await withSession((s) => s.command(p.id, command, { bypass }));
  } catch (err) {
    commands.delete(p.id);
    publish();
    const e = err as AdcError;
    logger.warn({ partition: p.name, command, reason: e?.message, code: e?.code }, 'Alarm command failed');
    if (e instanceof AdcError && e.kind === 'unreachable' && e.code === -1) {
      // Sent, but Alarm.com is slow to answer: it may well be under way. Show it as pending and watch
      // for it, rather than send it again; the history says if it never happens.
      commands.set(p.id, { target, userName, at });
      publish();
      void readNow();
      confirm(p.id, target, at);
      return;
    }
    if (e instanceof AdcError && e.kind === 'unreachable') {
      throw new AlarmCommandError('HomeHub couldn’t reach Alarm.com, so nothing was sent. Use the keypad or the Alarm.com app.', 503);
    }
    if (e instanceof AdcError && e.kind === 'refused') {
      throw new AlarmCommandError(command === 'disarm'
        ? `Alarm.com didn’t disarm it${e.message ? ` (${e.message})` : ''}. Use the keypad or the Alarm.com app.`
        : `Alarm.com didn’t arm it${e.message ? ` (${e.message})` : ''}. A door or window may be open, or this Alarm.com login may not be allowed to arm.`, 422);
    }
    if (e instanceof AdcError && (e.kind === 'rejected' || e.kind === 'code-needed')) {
      refuse(e);
      publish();
      throw new AlarmCommandError('Alarm.com needs signing in again under Settings → Integrations → Alarm.com.', 409);
    }
    throw new AlarmCommandError('Alarm.com didn’t take the command. Use the keypad or the Alarm.com app.', 502);
  }
  logger.info({ partition: p.name, command, bypass, user: userName }, 'Alarm command sent');
  confirm(p.id, target, at);
}

/**
 * Arms the alarm. Doors and windows open on it stop it, with their names, unless `bypass` is set:
 * then the panel bypasses them, as "arm anyway" on the keypad does.
 */
export async function arm(mode: ArmMode, opts: { partitionId?: string; bypass?: boolean; userName: string | null }): Promise<AlarmView> {
  const p = partitionFor(opts.partitionId);
  const target = TARGET[mode];
  if (mode === 'night' && !p.canNight) throw new AlarmCommandError('This alarm doesn’t offer night arming.', 400);
  if (p.state === target && !p.pending) return alarmView();
  const onIt = new Set(p.sensorIds);
  const open = (snapshot?.sensors ?? []).filter((s) => (onIt.size === 0 || onIt.has(s.id)) && s.state === 'open' && !s.bypassed);
  if (open.length && !opts.bypass) {
    throw new AlarmCommandError(`${open.map((s) => s.name).join(', ')} ${open.length === 1 ? 'is' : 'are'} open.`, 409, { open: open.map((s) => s.name), code: 'ALARM_OPEN_SENSORS' });
  }
  await answer(send(p, COMMAND[mode], target, open.length > 0, opts.userName), p, target, opts.userName);
  return alarmView();
}

/**
 * Waits a few seconds for Alarm.com to take the command. Some panels take over a minute to
 * answer: then the app shows it as under way and the history notes it if it fails later.
 */
async function answer(sending: Promise<void>, p: AdcPartition, target: ArmState, userName: string | null): Promise<void> {
  const timer = new Promise<'slow'>((r) => setTimeout(() => r('slow'), ANSWER_WAIT_MS).unref());
  const first = await Promise.race([sending.then(() => 'done' as const), timer]);
  if (first === 'done') return;
  sending.catch((err) => {
    log('arm', p.name, target, 'app', userName, `Failed: ${(err as Error)?.message ?? 'no answer'}`);
    publish();
  });
}

/** Disarms the alarm, with the alarm PIN. */
export async function disarm(pin: unknown, opts: { partitionId?: string; userName: string | null }): Promise<AlarmView> {
  const p = partitionFor(opts.partitionId);
  await checkAlarmPin(pin);
  if (p.state === 'disarmed' && !p.pending) return alarmView();
  await answer(send(p, 'disarm', 'disarmed', false, opts.userName), p, 'disarmed', opts.userName);
  return alarmView();
}

// ── Signing in ─────────────────────────────────────────────────────

let pending: { username: string; password: string; challenge: AdcChallenge; at: number; methods: CodeMethod[]; method: CodeMethod } | null = null;

export type SignInStep =
  | { step: 'done'; account: AccountStatus; partitions: number; sensors: number }
  | { step: 'code'; methods: CodeMethod[]; sentTo: string | null };

export class SignInError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

async function finish(username: string, password: string, s: AdcSession, trust: string | null): Promise<SignInStep> {
  pending = null;
  dropSession();
  getDb().transaction(() => {
    put(USERNAME, username);
    put(PASSWORD, password);
    if (trust) put(TRUST_KEY, trust);
    put(STATE, null);
    put(MESSAGE, null);
  })();
  // A different account's sensors mustn't linger.
  snapshot = null;
  updatedAt = 0;
  failures = 0;
  retryAt = 0;
  quiet.clear();
  commands.clear();
  connection = 'connecting';
  logger.info({ trusted: !!trust }, 'Signed in to Alarm.com');
  if (mayConnect()) {
    session = s;
    startWatching(s);
    await run(Date.now());
  } else {
    s.close();
  }
  publish();
  const read = alarmView();
  return { step: 'done', account: accountStatus(), partitions: read.partitions.length, sensors: read.sensors.length };
}

const words = (err: unknown): never => {
  if (err instanceof AdcError) {
    if (err.kind === 'rejected') throw new SignInError(err.message || 'Alarm.com didn’t accept that username and password.');
    if (err.kind === 'refused') throw new SignInError(err.message);
    if (err.kind === 'unreachable' || err.kind === 'expired') throw new SignInError(err.message || 'Alarm.com isn’t answering. Try again in a minute.', 502);
  }
  throw err;
};

/** First step: username and password. Alarm.com may then want a code. */
export async function startSignIn(username: string, password: string): Promise<SignInStep> {
  pending = null;
  // A saved trust token only counts for the account it was made for.
  const trust = username === setting(USERNAME) ? setting(TRUST_KEY) : null;
  const result = await connector.signIn(username, password, trust).catch(words);
  if (result.kind === 'ok') return finish(username, password, result.session, null);
  pending = { username, password, challenge: result.challenge, at: Date.now(), methods: result.methods, method: result.methods.includes('app') ? 'app' : result.methods[0] };
  return { step: 'code', methods: result.methods, sentTo: result.sentTo };
}

function current(): NonNullable<typeof pending> {
  if (!pending || Date.now() - pending.at > PENDING_MS) {
    pending = null;
    throw new SignInError('That sign-in has expired. Enter your username and password again.', 410);
  }
  return pending;
}

/** Asks Alarm.com to send the code by text or email. */
export async function sendCode(method: CodeMethod): Promise<{ sentTo: string | null }> {
  const p = current();
  if (!p.methods.includes(method)) throw new SignInError('Alarm.com can’t send a code that way for this account.', 400);
  const sentTo = await p.challenge.send(method).catch(words);
  p.method = method;
  return { sentTo };
}

/** Says the code comes from an authenticator app. */
export function useApp(): void {
  const p = current();
  if (!p.methods.includes('app')) throw new SignInError('This Alarm.com account doesn’t use an authenticator app.', 400);
  p.method = 'app';
}

/** Second step: the code. */
export async function submitCode(code: string): Promise<SignInStep> {
  const p = current();
  let out: { session: AdcSession; trust: string | null };
  try {
    out = await p.challenge.verify(code, p.method);
  } catch (err) {
    if (err instanceof AdcError && err.kind === 'rejected') throw new SignInError('That code didn’t work. Check it and try again.');
    return words(err);
  }
  if (!out.trust) logger.warn('Alarm.com accepted the code but didn’t trust this HomeHub; it may ask for a code at the next sign-in');
  return finish(p.username, p.password, out.session, out.trust);
}

export function cancelSignIn(): void { pending = null; }

/** Forgets the account and this HomeHub's trust token. The history stays, until pruned with Activity. */
export function signOut(): void {
  pending = null;
  dropSession();
  for (const key of [USERNAME, PASSWORD, TRUST_KEY, STATE, MESSAGE]) put(key, null);
  snapshot = null;
  updatedAt = 0;
  failures = 0;
  retryAt = 0;
  quiet.clear();
  commands.clear();
  logger.info('Signed out of Alarm.com');
  publish();
}

/** The alarm changed outside HomeHub's knowledge (a PIN set): send browsers the new view. */
export function republish(): void { publish(); }

/** For tests. */
export function resetAlarmcomState(): void {
  dropSession();
  snapshot = null;
  updatedAt = lastKeepAlive = lastPoll = 0;
  failures = 0;
  retryAt = 0;
  busy = null;
  pending = null;
  connection = 'connecting';
  detail = null;
  lastSent = '';
  quiet.clear();
  commands.clear();
}
