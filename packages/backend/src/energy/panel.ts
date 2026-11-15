import crypto from 'node:crypto';
import { getDb } from '../db';
import { logger } from '../logger';
import { isActiveServer } from '../system/role';

/**
 * A panel monitor: a Shelly Pro 3EM in the breaker panel, read over the home network (no cloud).
 * It measures the whole home on the mains, and a circuit or two (the dryer, the furnace) on its
 * other clamps, so the Energy page can show what the home really used, not only estimates for the
 * devices HomeHub switches.
 *
 * The meter keeps its own running totals (watt-hours that survive restarts), so HomeHub adds up the
 * difference between readings. Time HomeHub was off is still counted: the difference covers it, and
 * is spread over the hours it spans.
 *
 * Two layouts (the meter's "profile"): triphase, three phases A, B and C on one meter (em:0); and
 * monophase, three separate channels 0, 1 and 2 (em1:0..2). In a North American panel the two mains
 * legs are two of the three, and the third clamp can go on one circuit.
 */

export type Role = 'main' | 'circuit' | 'off';
export interface ChannelSetting { name: string; role: Role }
export interface PanelSettings { ip: string; password: string | null; channels: Record<string, ChannelSetting> }
export interface Reading { key: string; watts: number | null; wh: number | null; volts: number | null }
export interface PanelRead { model: string | null; profile: 'triphase' | 'monophase'; channels: Reading[]; errors: string[] }

const KEY = 'panel_monitor';
/** Its own row, so a backup viewed on screen hides it like other passwords. */
const PASSWORD_KEY = 'panel_monitor_password';
const setting = (key: string) => (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
const put = (key: string, value: string | null) => value === null
  ? getDb().prepare('DELETE FROM settings WHERE key = ?').run(key)
  : getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
const POLL_MS = 10_000;
/** A jump bigger than this between two readings is a counter reset or a bad reading, not use. */
const MAX_WH_PER_HOUR = 30_000;

export class PanelError extends Error {}

// ── Settings ────────────────────────────────────────────────────

export function getPanel(): PanelSettings | null {
  try {
    const raw = setting(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return typeof v?.ip === 'string' && v.ip ? { ip: v.ip, password: setting(PASSWORD_KEY), channels: v.channels ?? {} } : null;
  } catch {
    return null;
  }
}

const IP = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(:\d{1,5})?$/;

export function savePanel(input: unknown): PanelSettings | null {
  const b = (input ?? {}) as Record<string, unknown>;
  if (b.ip === null || b.ip === '') {
    put(KEY, null);
    put(PASSWORD_KEY, null);
    return null;
  }
  const now = getPanel();
  const ip = typeof b.ip === 'string' ? b.ip.trim() : now?.ip;
  if (!ip || !IP.test(ip) || ip.split(':')[0].split('.').some((n) => Number(n) > 255)) throw new PanelError('Enter the meter’s address, such as 192.168.86.60');
  // The password is kept unless a new one is given; '' clears it.
  const password = 'password' in b ? (typeof b.password === 'string' && b.password ? b.password : null) : now?.password ?? null;
  const channels: Record<string, ChannelSetting> = { ...(now?.channels ?? {}) };
  if (b.channels && typeof b.channels === 'object') {
    for (const [k, c] of Object.entries(b.channels as Record<string, unknown>)) {
      if (!/^(a|b|c|0|1|2)$/.test(k) || !c || typeof c !== 'object') continue;
      const { name, role } = c as Record<string, unknown>;
      if (role !== 'main' && role !== 'circuit' && role !== 'off') throw new PanelError('Each clamp is the main, a circuit, or not used');
      const n = typeof name === 'string' ? name.trim().slice(0, 40) : '';
      channels[k] = { name: n || defaultName(k, role), role };
    }
  }
  const next: PanelSettings = { ip, password, channels };
  put(KEY, JSON.stringify({ ip, channels }));
  put(PASSWORD_KEY, password);
  return next;
}

const defaultName = (k: string, role: Role) => role === 'main' ? `Main ${k.toUpperCase()}` : role === 'circuit' ? `Circuit ${k.toUpperCase()}` : `Clamp ${k.toUpperCase()}`;

/** What each clamp is: as set, or main for A and B (or 0 and 1) and a circuit for the third. */
export function channelSetting(s: PanelSettings, key: string): ChannelSetting {
  if (s.channels[key]) return s.channels[key];
  const role: Role = key === 'c' || key === '2' ? 'circuit' : 'main';
  return { name: defaultName(key, role), role };
}

// ── Reading the meter ───────────────────────────────────────────

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Shelly Gen2+ digest login (SHA-256): the first request is refused with a challenge, the second answers it. */
async function rpc(ip: string, path: string, password: string | null, fetchImpl: typeof fetch): Promise<unknown> {
  const url = `http://${ip}${path}`;
  const first = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
  if (first.status !== 401) {
    if (!first.ok) throw new PanelError(`The meter answered ${first.status}`);
    return first.json();
  }
  await first.arrayBuffer().catch(() => undefined);
  if (!password) throw new PanelError('The meter has a password: enter it');
  const header = first.headers.get('www-authenticate') ?? '';
  const field = (k: string) => header.match(new RegExp(`${k}="?([^",]+)"?`))?.[1] ?? '';
  const realm = field('realm'), nonce = field('nonce');
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  const ha1 = sha256(`admin:${realm}:${password}`);
  const ha2 = sha256(`GET:${path}`);
  const response = sha256(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
  const auth = `Digest username="admin", realm="${realm}", nonce="${nonce}", uri="${path}", algorithm=SHA-256, response="${response}", qop=auth, nc=${nc}, cnonce="${cnonce}"`;
  const second = await fetchImpl(url, { headers: { Authorization: auth }, signal: AbortSignal.timeout(5000) });
  if (second.status === 401) throw new PanelError('The meter refused the password');
  if (!second.ok) throw new PanelError(`The meter answered ${second.status}`);
  return second.json();
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One reading of every clamp: power now, and the meter's running total. */
export async function readPanel(ip: string, password: string | null, fetchImpl: typeof fetch = fetch): Promise<PanelRead> {
  let info: Record<string, unknown> = {};
  try { info = (await rpc(ip, '/shelly', null, fetchImpl)) as Record<string, unknown>; } catch (err) {
    if (err instanceof PanelError) throw err;
    throw new PanelError(`Nothing answered at ${ip}. Check the address, and that the meter is on the home Wi-Fi or network.`);
  }
  const status = (await rpc(ip, '/rpc/Shelly.GetStatus', password, fetchImpl)) as Record<string, Record<string, unknown> | undefined>;
  const errors: string[] = [];
  const channels: Reading[] = [];
  const em = status['em:0'];
  if (em) {
    const data = status['emdata:0'] ?? {};
    for (const p of ['a', 'b', 'c']) {
      channels.push({ key: p, watts: num(em[`${p}_act_power`]), wh: num(data[`${p}_total_act_energy`]), volts: num(em[`${p}_voltage`]) });
    }
    errors.push(...((em.errors as string[] | undefined) ?? []));
  } else {
    for (const i of [0, 1, 2]) {
      const e = status[`em1:${i}`];
      if (!e) continue;
      const data = status[`em1data:${i}`] ?? {};
      channels.push({ key: String(i), watts: num(e.act_power), wh: num(data.total_act_energy), volts: num(e.voltage) });
      errors.push(...((e.errors as string[] | undefined) ?? []));
    }
  }
  if (!channels.length) throw new PanelError('That device isn’t an energy meter HomeHub knows (a Shelly Pro 3EM)');
  return { model: typeof info.model === 'string' ? info.model : null, profile: em ? 'triphase' : 'monophase', channels, errors: [...new Set(errors)] };
}

// ── Adding it up ────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
/** The home's local hour, "YYYY-MM-DDTHH". */
export const hourKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`; };

/** Adds one reading: the difference from the last, spread over the hours between them. */
export function record(read: PanelRead, now = Date.now()): void {
  const db = getDb();
  const last = new Map((db.prepare('SELECT channel, wh, at FROM panel_counters').all() as { channel: string; wh: number; at: string }[]).map((r) => [r.channel, r]));
  const add = db.prepare('INSERT INTO panel_hours (hour, channel, wh) VALUES (?, ?, ?) ON CONFLICT(hour, channel) DO UPDATE SET wh = wh + excluded.wh');
  const keep = db.prepare('INSERT INTO panel_counters (channel, wh, at) VALUES (?, ?, ?) ON CONFLICT(channel) DO UPDATE SET wh = excluded.wh, at = excluded.at');
  db.transaction(() => {
    for (const c of read.channels) {
      if (c.wh === null) continue;
      const prev = last.get(c.key);
      keep.run(c.key, c.wh, new Date(now).toISOString());
      if (!prev) continue;
      const from = Date.parse(prev.at);
      const delta = c.wh - prev.wh;
      const hours = Math.max((now - from) / 3_600_000, 1 / 3600);
      if (delta < 0 || delta / Math.max(hours, 1) > MAX_WH_PER_HOUR) continue;   // reset, or a bad reading
      if (delta === 0) continue;
      // Spread over the hours it covers, in proportion to the time in each.
      let t = from;
      while (t < now) {
        const d = new Date(t); d.setMinutes(60, 0, 0);   // the start of the next hour
        const end = Math.min(d.getTime(), now);
        add.run(hourKey(t), c.key, delta * (end - t) / (now - from));
        t = end;
      }
    }
  })();
}

export interface PanelMonth {
  /** kWh in the month for each clamp in use. */
  channels: { key: string; name: string; role: Role; kwh: number }[];
  /** The mains added up; null with no main clamp. */
  wholeKwh: number | null;
  /** The first hour recorded in the month, so a part month can say so. */
  since: string | null;
}

export function panelMonth(month: string): PanelMonth | null {
  const s = getPanel();
  if (!s) return null;
  const rows = getDb().prepare("SELECT channel, SUM(wh) wh, MIN(hour) first FROM panel_hours WHERE hour LIKE ? GROUP BY channel").all(`${month}-%`) as { channel: string; wh: number; first: string }[];
  const channels = rows.map((r) => ({ key: r.channel, ...channelSetting(s, r.channel), kwh: Math.round(r.wh / 10) / 100 }))
    .filter((c) => c.role !== 'off').sort((a, b) => a.key.localeCompare(b.key));
  const mains = channels.filter((c) => c.role === 'main');
  return {
    channels,
    wholeKwh: mains.length ? Math.round(mains.reduce((n, c) => n + c.kwh, 0) * 100) / 100 : null,
    since: rows.length ? rows.map((r) => r.first).sort()[0] : null,
  };
}

// ── Running ─────────────────────────────────────────────────────

let live: (PanelRead & { at: number }) | null = null;
let lastError: string | null = null;

export function panelLive(): { read: (PanelRead & { at: string }) | null; error: string | null } {
  return { read: live ? { ...live, at: new Date(live.at).toISOString() } : null, error: lastError };
}

export async function pollPanel(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<void> {
  const s = getPanel();
  if (!s) { live = null; lastError = null; return; }
  try {
    const read = await readPanel(s.ip, s.password, fetchImpl);
    record(read, now);
    live = { ...read, at: now };
    if (lastError) logger.info('Panel monitor answering again');
    lastError = null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== lastError) logger.warn({ err: msg }, 'Panel monitor not read');
    lastError = msg;
  }
}

let timer: NodeJS.Timeout | undefined;
export function startPanel(): void {
  if (timer) return;
  timer = setInterval(() => { if (isActiveServer()) pollPanel().catch(() => undefined); }, POLL_MS);
  timer.unref();
}
export function stopPanel(): void { if (timer) clearInterval(timer); timer = undefined; }
