import { getDb } from '../db';
import { logger } from '../logger';
import { isActiveServer } from '../system/role';
import type { ThermostatMode, ThermostatReading } from '../matter/controller';
import { TccError, TccSession, type TccChange, type TccData, type TccLocation } from './tcc';

/**
 * Honeywell thermostats on Total Connect Comfort, through a RedLINK Internet Gateway.
 *
 * Each thermostat on the account is a HomeHub device: driver_type 'honeywell', ip
 * "honeywell:<DeviceID>", driver_config { kind: 'thermostat', deviceId, locationId }.
 *
 * Total Connect Comfort needs the account's email and password for every new
 * session, so HomeHub keeps both (like a Kasa login) and signs in again when a
 * session ends. A password Honeywell refuses is tried once only: HomeHub stops and
 * Settings asks to sign in again, so it never locks the account with retries.
 *
 * Honeywell limits how often an account may ask, so the active HomeHub reads each
 * thermostat once a minute and everything else uses those readings. A backup
 * HomeHub doesn't ask at all.
 */

const EMAIL = 'honeywell_email';
const PASSWORD = 'honeywell_password';
/** 'rejected' once Honeywell refuses the saved password; cleared by signing in again. */
const STATE = 'honeywell_state';
const MESSAGE = 'honeywell_message';

export const POLL_MS = 60_000;
/** Readings older than this count as no reading: the thermostat shows as offline. */
const STALE_MS = 10 * 60_000;
/** A new session at most this often, however many requests find the old one ended. */
const SIGN_IN_GAP_MS = 60_000;
/** How long a change shows as sent before a reading confirms it, since Honeywell takes a while to hear back. */
const PENDING_MS = 3 * 60_000;

export const honeywellAddress = (deviceId: number) => `honeywell:${deviceId}`;

// ── Saved account ──────────────────────────────────────────────────

const setting = (key: string): string | null =>
  (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value || null;
const put = (key: string, value: string | null) => {
  if (value === null) getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
  else getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
};

export interface AccountStatus {
  email: string | null;
  signedIn: boolean;
  /** Honeywell refused the saved password since; sign in again. */
  rejected: boolean;
  /** Why, in Honeywell's or HomeHub's words. */
  message: string | null;
}

export function accountStatus(): AccountStatus {
  const signedIn = !!setting(EMAIL) && !!setting(PASSWORD);
  return { email: setting(EMAIL), signedIn, rejected: signedIn && setting(STATE) === 'rejected', message: setting(MESSAGE) };
}

// ── Session ────────────────────────────────────────────────────────

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
/** For tests. */
export function setFetch(f: Fetch | null): void { fetchImpl = f ?? ((...a) => fetch(...a)); session = null; lastSignIn = 0; turnedAway = 0; }

let session: TccSession | null = null;
let lastSignIn = 0;
/**
 * Times in a row a brand-new session was turned away at once. Honeywell does that when the
 * account needs attention on its website (new terms, say); each time, the next sign-in waits
 * twice as long, up to half an hour, rather than signing in every minute.
 */
let turnedAway = 0;
const signInGap = () => Math.min(SIGN_IN_GAP_MS * 2 ** turnedAway, 30 * 60_000);
let signingIn: Promise<TccSession> | null = null;

function refuse(err: TccError): void {
  put(STATE, 'rejected');
  put(MESSAGE, err.message);
  session = null;
  logger.warn({ reason: err.message }, 'Total Connect Comfort refused the saved sign-in; waiting for a new one in Settings');
}

/** A signed-in session, signing in if needed. One sign-in at a time, and not more than once a minute. */
async function ensureSession(): Promise<TccSession> {
  if (session?.signedIn) return session;
  if (signingIn) return signingIn;
  const email = setting(EMAIL);
  const password = setting(PASSWORD);
  if (!email || !password) throw new TccError('HomeHub isn’t signed in to Total Connect Comfort. Sign in under Settings → Integrations.', 'rejected');
  if (setting(STATE) === 'rejected') throw new TccError(setting(MESSAGE) ?? 'Total Connect Comfort refused the saved password. Sign in again under Settings → Integrations.', 'rejected');
  if (Date.now() - lastSignIn < signInGap()) throw new TccError('Waiting a moment before signing in to Total Connect Comfort again.', 'unreachable');
  lastSignIn = Date.now();
  signingIn = (async () => {
    const s = new TccSession(fetchImpl);
    try {
      await s.signIn(email, password);
    } catch (err) {
      if (err instanceof TccError && err.kind === 'rejected') refuse(err);
      throw err;
    }
    session = s;
    return s;
  })().finally(() => { signingIn = null; });
  return signingIn;
}

/** Runs a request, signing in again once if the session had ended. */
async function withSession<T>(fn: (s: TccSession) => Promise<T>): Promise<T> {
  const s = await ensureSession();
  try {
    const out = await fn(s);
    turnedAway = 0;
    return out;
  } catch (err) {
    if (!(err instanceof TccError) || err.kind !== 'expired') throw err;
    if (session === s) session = null;
    if (turnedAway === 0) lastSignIn = 0;   // an ended session is expected, so this sign-in needn't wait
  }
  const fresh = await ensureSession();
  try {
    const out = await fn(fresh);
    turnedAway = 0;
    return out;
  } catch (err) {
    if (!(err instanceof TccError) || err.kind !== 'expired') throw err;
    if (session === fresh) session = null;
    turnedAway++;
    logger.warn({ nextTryMinutes: Math.round(signInGap() / 60_000) }, 'Total Connect Comfort signed HomeHub in but turned its requests away');
    throw new TccError('Total Connect Comfort signs HomeHub in but won’t answer. Sign in at mytotalconnectcomfort.com to check for a notice there.', 'unreachable');
  }
}

/**
 * Signs in with a new email and password, saved as soon as Honeywell accepts them. Returns the
 * account's locations and thermostats, or null if Honeywell accepted the sign-in but didn't list
 * them in time: the next poll lists them and adds the thermostats then.
 */
export async function signIn(email: string, password: string): Promise<{ locations: TccLocation[] | null; listError?: string }> {
  const s = new TccSession(fetchImpl);
  await s.signIn(email, password);
  getDb().transaction(() => {
    put(EMAIL, email);
    put(PASSWORD, password);
    put(STATE, null);
    put(MESSAGE, null);
  })();
  session = s;
  lastSignIn = Date.now();
  turnedAway = 0;
  account = null;
  lastListTry = 0;
  try {
    const locations = await s.locations();
    account = { at: Date.now(), locations };
    return { locations };
  } catch (err) {
    logger.warn({ err: String((err as Error)?.message ?? err) }, 'Signed in to Total Connect Comfort, but it didn’t list the thermostats yet');
    return { locations: null, listError: (err as Error)?.message ?? String(err) };
  }
}

let lastListTry = 0;

/**
 * Signed in but no Honeywell thermostats in HomeHub yet (the list was slow at sign-in):
 * lists the account and adds them, at most every 5 minutes. Thermostats someone deleted
 * aren't added back while any other Honeywell thermostat is still in HomeHub.
 */
async function addIfNone(): Promise<void> {
  if (honeywellRows().length || Date.now() - lastListTry < 5 * 60_000) return;
  lastListTry = Date.now();
  try {
    addThermostats(await accountThermostats());
  } catch (err) {
    logger.debug({ err: String((err as Error)?.message ?? err) }, 'Total Connect Comfort thermostats not listed yet');
  }
}

/** Forgets the account. Its thermostats stay in HomeHub, offline, until signed in again. */
export function signOut(): void {
  for (const key of [EMAIL, PASSWORD, STATE, MESSAGE]) put(key, null);
  session = null;
  account = null;
  readings.clear();
  pending.clear();
}

// ── The account's thermostats ──────────────────────────────────────

let account: { at: number; locations: TccLocation[] } | null = null;

/** The account's locations and thermostats, asked again at most every 10 minutes. */
export async function accountThermostats(): Promise<TccLocation[]> {
  if (account && Date.now() - account.at < 10 * 60_000) return account.locations;
  const locations = await withSession((s) => s.locations());
  account = { at: Date.now(), locations };
  return locations;
}

interface Row { id: number; alias: string; driver_config: string | null }

const configOf = (r: Pick<Row, 'driver_config'>): { deviceId?: number; locationId?: number } => {
  try { return r.driver_config ? JSON.parse(r.driver_config) : {}; } catch { return {}; }
};

export function honeywellRows(): (Row & { deviceId: number })[] {
  return (getDb().prepare("SELECT id, alias, driver_config FROM devices WHERE driver_type = 'honeywell'").all() as Row[])
    .map((r) => ({ ...r, deviceId: Number(configOf(r).deviceId) }))
    .filter((r) => Number.isFinite(r.deviceId));
}

/** "BASEMENT" → "Basement Thermostat": Honeywell's names are often capitals, and a bare room name would clash with the room. */
export function aliasFor(name: string): string {
  const words = name.trim().replace(/\s+/g, ' ');
  const titled = words === words.toUpperCase() ? words.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : words;
  return /thermostat/i.test(titled) ? titled : `${titled} Thermostat`;
}

/** Adds thermostats from the account that HomeHub doesn't have yet. `only` limits it to one. */
export function addThermostats(locations: TccLocation[], only?: number): { id: number; alias: string }[] {
  const db = getDb();
  const have = new Set(honeywellRows().map((r) => r.deviceId));
  const taken = (name: string) => !!db.prepare('SELECT 1 FROM devices WHERE alias = ? COLLATE NOCASE').get(name);
  const insert = db.prepare(`
    INSERT INTO devices (alias, ip, model, has_emeter, driver_type, driver_config)
    VALUES (?, ?, 'Honeywell thermostat', 0, 'honeywell', ?)
    ON CONFLICT (ip) DO NOTHING
  `);
  const added: { id: number; alias: string }[] = [];
  for (const loc of locations) {
    for (const t of loc.thermostats) {
      if (have.has(t.id) || (only !== undefined && t.id !== only)) continue;
      const base = aliasFor(t.name);
      let alias = base;
      for (let n = 2; taken(alias); n++) alias = `${base} ${n}`;
      const config = JSON.stringify({ kind: 'thermostat', deviceId: t.id, locationId: loc.id });
      const r = insert.run(alias, honeywellAddress(t.id), config);
      if (r.changes) added.push({ id: Number(r.lastInsertRowid), alias });
    }
  }
  if (added.length) logger.info({ devices: added.map((d) => d.alias) }, 'Honeywell thermostats added');
  return added;
}

// ── Readings ───────────────────────────────────────────────────────

const readings = new Map<number, { data: TccData; at: number }>();
/** What HomeHub last sent, in the thermostat's units, until a reading shows it or it's too old. */
const pending = new Map<number, { ui: Record<string, number>; until: number }>();

export type Hold = 'schedule' | 'temporary' | 'permanent';
export type HoneywellReading = ThermostatReading & { hold: Hold | null };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const unitOf = (ui: Record<string, unknown>): 'F' | 'C' => (ui.DisplayUnits === 'C' ? 'C' : 'F');

/** From the thermostat's unit to °C, to a hundredth. */
export function toC(v: number, unit: 'F' | 'C'): number {
  return unit === 'C' ? v : Math.round(((v - 32) * 5 / 9) * 100) / 100;
}
/** From °C to what the thermostat takes: whole °F, or half °C. */
export function fromC(c: number, unit: 'F' | 'C'): number {
  return unit === 'C' ? Math.round(c * 2) / 2 : Math.round(c * 9 / 5 + 32);
}

// SystemSwitchPosition: 0 emergency heat, 1 heat, 2 off, 3 cool, 4 auto, 5 auto (the portal sends either).
const MODE_AT: Record<number, ThermostatMode> = { 1: 'heat', 2: 'off', 3: 'cool', 4: 'auto', 5: 'auto' };
const SWITCH_FOR: Record<ThermostatMode, number> = { heat: 1, off: 2, cool: 3, auto: 4 };
const ALLOWED_KEY: Record<ThermostatMode, string> = { heat: 'SwitchHeatAllowed', off: 'SwitchOffAllowed', cool: 'SwitchCoolAllowed', auto: 'SwitchAutoAllowed' };
// StatusHeat / StatusCool: 0 following its schedule, 1 held until the next schedule period, 2 held until changed.
const HOLD_AT: Record<number, Hold> = { 0: 'schedule', 1: 'temporary', 2: 'permanent' };

/** A portal reading as HomeHub's, in °C. `ui` should already include anything still pending. */
export function toReading(data: TccData): HoneywellReading {
  const ui = data.ui;
  const unit = unitOf(ui);
  const c = (v: unknown) => { const n = num(v); return n === null ? null : toC(n, unit); };
  const modes: ThermostatMode[] = (['off', 'heat', 'cool', 'auto'] as ThermostatMode[]).filter((m) => ui[ALLOWED_KEY[m]] === true);
  if (!modes.includes('off')) modes.unshift('off');
  const heats = modes.includes('heat') || modes.includes('auto');
  const cools = modes.includes('cool') || modes.includes('auto');
  const pos = num(ui.SystemSwitchPosition);
  const status = num(ui.EquipmentOutputStatus);
  const running = status === 1 ? 'heating' : status === 2 ? 'cooling'
    : data.fan?.running ? 'fan' : status === 0 ? 'idle' : null;
  const limits = (lo: unknown, hi: unknown): [number, number] | null => {
    const a = c(lo); const b = c(hi);
    return a !== null && b !== null && a < b ? [a, b] : null;
  };
  const dead = num(ui.Deadband);
  const statusHeat = num(ui.StatusHeat);
  return {
    temperature: c(ui.DispTemperature),
    heat: heats ? c(ui.HeatSetpoint) : null,
    cool: cools ? c(ui.CoolSetpoint) : null,
    mode: pos !== null && MODE_AT[pos] ? MODE_AT[pos] : 'other',
    modes,
    running,
    heatLimits: heats ? limits(ui.HeatLowerSetptLimit, ui.HeatUpperSetptLimit) ?? [4.5, 32] : null,
    coolLimits: cools ? limits(ui.CoolLowerSetptLimit, ui.CoolUpperSetptLimit) ?? [10, 37] : null,
    deadband: dead !== null && dead > 0 ? (unit === 'C' ? dead : Math.round(dead * 5 / 9 * 100) / 100) : 0,
    hold: statusHeat !== null && HOLD_AT[statusHeat] ? HOLD_AT[statusHeat] : null,
  };
}

/** The reading with HomeHub's own recent change laid over it, until Honeywell's readings catch up. */
function withPending(deviceId: number, data: TccData): TccData {
  const p = pending.get(deviceId);
  if (!p) return data;
  if (Date.now() > p.until || Object.entries(p.ui).every(([k, v]) => data.ui[k] === v)) {
    pending.delete(deviceId);
    return data;
  }
  return { ...data, ui: { ...data.ui, ...p.ui } };
}

/** The thermostat as last read. Throws if there's no recent reading or it has lost touch with Honeywell. */
export function readThermostat(deviceId: number): HoneywellReading {
  const r = readings.get(deviceId);
  if (!r || Date.now() - r.at > STALE_MS) throw new TccError('No recent reading from Total Connect Comfort.', 'unreachable');
  if (!r.data.live) throw new TccError('The thermostat has lost touch with its gateway.', 'unreachable');
  return toReading(withPending(deviceId, r.data));
}

/** Reads one thermostat from Honeywell now. True if anything HomeHub shows changed. */
async function readNow(deviceId: number): Promise<boolean> {
  const before = readings.get(deviceId);
  const data = await withSession((s) => s.thermostat(deviceId));
  readings.set(deviceId, { data, at: Date.now() });
  if (!before) return true;
  return JSON.stringify(toReading(withPending(deviceId, before.data))) !== JSON.stringify(toReading(withPending(deviceId, data)))
    || before.data.live !== data.live;
}

// ── Changes ────────────────────────────────────────────────────────

/**
 * What to send for a change in °C. The other target moves when the two would come
 * closer than the thermostat's deadband, as the thermostat itself requires. A new
 * target holds: until changed for `permanent`, else until the thermostat's next
 * schedule period (as at the wall), unless it was already held until changed.
 */
export function buildChange(
  ui: Record<string, unknown>,
  change: { mode?: ThermostatMode; heat?: number; cool?: number },
  hold: 'temporary' | 'permanent',
): TccChange {
  const unit = unitOf(ui);
  const out: TccChange = {};
  if (change.mode !== undefined) {
    if (ui[ALLOWED_KEY[change.mode]] !== true && change.mode !== 'off') throw new TccError(`That thermostat can’t be set to ${change.mode}.`, 'refused');
    out.SystemSwitch = SWITCH_FOR[change.mode];
  }
  const fit = (v: number, lo: unknown, hi: unknown) => {
    const a = num(lo); const b = num(hi);
    return Math.min(Math.max(v, a ?? -Infinity), b ?? Infinity);
  };
  const dead = num(ui.Deadband) ?? 0;
  const heatNow = num(ui.HeatSetpoint);
  const coolNow = num(ui.CoolSetpoint);
  if (change.heat !== undefined) out.HeatSetpoint = fit(fromC(change.heat, unit), ui.HeatLowerSetptLimit, ui.HeatUpperSetptLimit);
  if (change.cool !== undefined) out.CoolSetpoint = fit(fromC(change.cool, unit), ui.CoolLowerSetptLimit, ui.CoolUpperSetptLimit);
  if (dead > 0) {
    if (out.HeatSetpoint !== undefined && out.CoolSetpoint === undefined && coolNow !== null && coolNow - dead < out.HeatSetpoint) {
      out.CoolSetpoint = out.HeatSetpoint + dead;
    } else if (out.CoolSetpoint !== undefined && out.HeatSetpoint === undefined && heatNow !== null && heatNow + dead > out.CoolSetpoint) {
      out.HeatSetpoint = out.CoolSetpoint - dead;
    }
  }
  if (out.HeatSetpoint !== undefined || out.CoolSetpoint !== undefined) {
    const status = num(ui.StatusHeat) === 2 || hold === 'permanent' ? 2 : 1;
    out.StatusHeat = status;
    out.StatusCool = status;
  }
  return out;
}

/** Sends a change and shows it straight away; Honeywell's readings confirm it a minute or two later. */
async function send(deviceId: number, out: TccChange): Promise<void> {
  if (!Object.keys(out).length) return;
  await withSession((s) => s.change(deviceId, out));
  const shown: Record<string, number> = {};
  if (out.SystemSwitch !== undefined) shown.SystemSwitchPosition = out.SystemSwitch;
  if (out.HeatSetpoint !== undefined) shown.HeatSetpoint = out.HeatSetpoint;
  if (out.CoolSetpoint !== undefined) shown.CoolSetpoint = out.CoolSetpoint;
  if (out.StatusHeat !== undefined) shown.StatusHeat = out.StatusHeat;
  if (out.StatusCool !== undefined) shown.StatusCool = out.StatusCool;
  pending.set(deviceId, { ui: { ...(pending.get(deviceId)?.ui ?? {}), ...shown }, until: Date.now() + PENDING_MS });
  // Read it back once Honeywell has had time to pass it on.
  setTimeout(() => { void pollOne(deviceId); }, 20_000).unref?.();
}

/** Changes the mode or targets (°C). `hold` says how long a new target lasts. */
export async function setThermostat(deviceId: number, change: { mode?: ThermostatMode; heat?: number; cool?: number }, hold: 'temporary' | 'permanent'): Promise<void> {
  const r = readings.get(deviceId);
  if (!r || Date.now() - r.at > STALE_MS) throw new TccError('No recent reading from Total Connect Comfort.', 'unreachable');
  const ui = withPending(deviceId, r.data).ui;
  await send(deviceId, buildChange(ui, change, hold));
}

/** Ends any hold, so the thermostat follows its own schedule again. */
export async function resumeSchedule(deviceId: number): Promise<void> {
  await send(deviceId, { StatusHeat: 0, StatusCool: 0 });
}

// ── Polling ────────────────────────────────────────────────────────

async function tellPages(deviceId: number): Promise<void> {
  const row = honeywellRows().find((r) => r.deviceId === deviceId);
  if (!row) return;
  const [{ refresh }, { pollDeviceNow }] = await Promise.all([import('../thermostat/thermostat'), import('../kasa/device.cache')]);
  await refresh(row.id);
  pollDeviceNow(row.id).catch(() => undefined);
}

async function pollOne(deviceId: number): Promise<void> {
  try {
    if (await readNow(deviceId)) await tellPages(deviceId);
  } catch (err) {
    logger.debug({ deviceId, err: String((err as Error)?.message ?? err) }, 'Honeywell thermostat not read');
  }
}

let polling = false;

/** Reads every Honeywell thermostat once, one after another. */
export async function pollAll(): Promise<void> {
  if (polling) return;
  const st = accountStatus();
  if (!st.signedIn || st.rejected || !isActiveServer()) return;
  polling = true;
  try {
    await addIfNone();
    for (const r of honeywellRows()) {
      try {
        if (await readNow(r.deviceId)) await tellPages(r.deviceId);
      } catch (err) {
        if (err instanceof TccError && (err.kind === 'rejected' || err.kind === 'unreachable')) {
          logger.debug({ err: err.message }, 'Honeywell polling paused this round');
          break;
        }
        logger.debug({ deviceId: r.deviceId, err: String((err as Error)?.message ?? err) }, 'Honeywell thermostat not read');
      }
    }
  } finally {
    polling = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startHoneywell(): void {
  if (timer) return;
  setTimeout(() => { void pollAll(); }, 5_000).unref?.();
  timer = setInterval(() => { void pollAll(); }, POLL_MS);
  timer.unref?.();
}

export function stopHoneywell(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** For tests: forget readings, pending changes and the session. */
export function resetForTests(): void {
  readings.clear();
  pending.clear();
  session = null;
  account = null;
  lastSignIn = 0;
  lastListTry = 0;
  turnedAway = 0;
}
