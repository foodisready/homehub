/**
 * One connection per TV, kept open while it's on, and what HomeHub asks of a TV through it. A TV
 * that's off doesn't answer, which is how HomeHub knows it's off.
 */
import { TvConnection, TvError, isOnState, normalMac } from './protocol';
import { logger } from '../logger';

export interface TvLogin { key: string }

/** A TV that turned HomeHub away isn't asked again for this long: each try can flash a question on its screen. */
const NOT_PAIRED_PAUSE_MS = 10 * 60_000;

const links = new Map<string, Promise<TvConnection>>();
const refused = new Map<string, number>();

const linkKey = (ip: string, key: string) => `${ip}|${key}`;

/** The open connection to this TV, opening one if needed. */
export async function linkTo(ip: string, login: TvLogin): Promise<TvConnection> {
  const id = linkKey(ip, login.key);
  const pausedUntil = refused.get(id) ?? 0;
  if (Date.now() < pausedUntil) throw new TvError('The TV doesn’t know HomeHub any more', 'NOT_PAIRED');
  const existing = links.get(id);
  if (existing) {
    const connection = await existing.catch(() => null);
    if (connection && !connection.closed) return connection;
    if (links.get(id) === existing) links.delete(id);
  }
  const opening = TvConnection.open(ip, { key: login.key }).then(({ connection }) => {
    connection.onClose(() => { if (links.get(id) === opening) links.delete(id); });
    return connection;
  });
  links.set(id, opening);
  try {
    return await opening;
  } catch (err) {
    if (links.get(id) === opening) links.delete(id);
    if (err instanceof TvError && err.code === 'NOT_PAIRED') {
      refused.set(id, Date.now() + NOT_PAIRED_PAUSE_MS);
      logger.warn({ ip }, 'LG TV no longer knows HomeHub: pair it again from Discover');
    }
    throw err;
  }
}

/** Drops this TV's connection, and forgets that it refused: after pairing again, or when it's removed. */
export function closeLink(ip: string): void {
  for (const [id, opening] of links) {
    if (id.startsWith(`${ip}|`)) { links.delete(id); opening.then((c) => c.close(), () => undefined); }
  }
  for (const id of refused.keys()) if (id.startsWith(`${ip}|`)) refused.delete(id);
}

/** On, off, or null when HomeHub can't reach it (also off, for a TV: off TVs don't answer). */
export async function powerOf(ip: string, login: TvLogin): Promise<boolean> {
  let connection: TvConnection;
  try {
    connection = await linkTo(ip, login);
  } catch (err) {
    if (err instanceof TvError && err.code === 'NOT_PAIRED') throw err;
    return false;
  }
  try {
    return isOnState(await connection.request('ssap://com.webos.service.tvpower/power/getPowerState'));
  } catch (err) {
    // Older TVs have no power state to give: answering at all means on.
    if (err instanceof TvError && err.code === 'FAILED') return true;
    return false;
  }
}

/** The TV's own addresses, wired and Wi-Fi, for waking it. */
export async function macsOf(connection: TvConnection): Promise<string[]> {
  const macs: string[] = [];
  try {
    const info = await connection.request<{ wiredInfo?: { macAddress?: string }; wifiInfo?: { macAddress?: string } }>(
      'ssap://com.webos.service.connectionmanager/getinfo');
    for (const m of [info.wiredInfo?.macAddress, info.wifiInfo?.macAddress]) { const n = normalMac(m); if (n) macs.push(n); }
  } catch { /* some firmware doesn't say */ }
  if (!macs.length) {
    try {
      const sw = await connection.request<{ device_id?: string }>('ssap://com.webos.service.update/getCurrentSWInformation');
      const n = normalMac(sw.device_id);
      if (n) macs.push(n);
    } catch { /* nor this */ }
  }
  return [...new Set(macs)];
}

export async function modelOf(connection: TvConnection): Promise<string | null> {
  try {
    const info = await connection.request<{ modelName?: string }>('ssap://system/getSystemInfo');
    return info.modelName ? `LG ${info.modelName}` : null;
  } catch {
    return null;
  }
}

// ── The remote ─────────────────────────────────────────────────

export interface TvChoice { id: string; label: string }
export interface TvRemote {
  on: boolean;
  /** 0–100, or null when the sound goes to a soundbar or receiver whose volume the TV can't say. */
  volume: number | null;
  muted: boolean | null;
  input: string | null;
  app: string | null;
  inputs: TvChoice[];
  apps: TvChoice[];
}

/** The TV's inputs and apps change rarely: kept for a while. */
const LISTS_MS = 10 * 60_000;
const lists = new Map<string, { at: number; inputs: TvChoice[]; apps: TvChoice[] }>();

/** Volume from either shape firmware answers with: {volume, muted} or {volumeStatus: {volume, muteStatus}}. */
export function volumeOf(payload: Record<string, unknown>): { volume: number | null; muted: boolean | null } {
  const status = (payload.volumeStatus ?? {}) as Record<string, unknown>;
  const v = Number(payload.volume ?? status.volume);
  const m = payload.muted ?? payload.mute ?? status.muteStatus;
  return { volume: Number.isFinite(v) && v >= 0 ? v : null, muted: typeof m === 'boolean' ? m : null };
}

async function listsOf(ip: string, connection: TvConnection): Promise<{ inputs: TvChoice[]; apps: TvChoice[] }> {
  const kept = lists.get(ip);
  if (kept && Date.now() - kept.at < LISTS_MS) return kept;
  const [inputs, apps] = await Promise.all([
    connection.request<{ devices?: { id: string; label?: string }[] }>('ssap://tv/getExternalInputList')
      .then((r) => (r.devices ?? []).map((d) => ({ id: d.id, label: d.label || d.id })))
      .catch(() => [] as TvChoice[]),
    connection.request<{ launchPoints?: { id: string; title?: string }[] }>('ssap://com.webos.applicationManager/listLaunchPoints')
      .then((r) => (r.launchPoints ?? [])
        // The inputs have their own list.
        .filter((p) => p.id && p.title && !/^com\.webos\.app\.(hdmi|externalinput)/.test(p.id))
        .map((p) => ({ id: p.id, label: p.title! }))
        .sort((a, b) => a.label.localeCompare(b.label)))
      .catch(() => [] as TvChoice[]),
  ]);
  const fresh = { at: Date.now(), inputs, apps };
  if (inputs.length || apps.length) lists.set(ip, fresh);
  return fresh;
}

/** Everything the remote shows: on, volume, what's on screen, and the inputs and apps to pick from. */
export async function remoteOf(ip: string, login: TvLogin): Promise<TvRemote> {
  const off: TvRemote = { on: false, volume: null, muted: null, input: null, app: null, inputs: [], apps: [] };
  if (!(await powerOf(ip, login))) return off;
  const connection = await linkTo(ip, login);
  const [volume, foreground, choices] = await Promise.all([
    connection.request('ssap://audio/getVolume').then(volumeOf).catch(() => ({ volume: null, muted: null })),
    connection.request<{ appId?: string }>('ssap://com.webos.applicationManager/getForegroundAppInfo').then((r) => r.appId ?? null).catch(() => null),
    listsOf(ip, connection),
  ]);
  // An input shows as its app ("com.webos.app.hdmi2"): say which input that is.
  const input = foreground ? inputForApp(foreground, choices.inputs) : null;
  return { on: true, ...volume, input, app: input ? null : foreground, inputs: choices.inputs, apps: choices.apps };
}

/** "com.webos.app.hdmi2" → "HDMI_2", when that's one of the inputs. */
export function inputForApp(appId: string, inputs: TvChoice[]): string | null {
  const m = /^com\.webos\.app\.hdmi(\d+)$/.exec(appId);
  if (!m) return null;
  return inputs.find((i) => i.id.replace(/\D/g, '') === m[1] && /hdmi/i.test(i.id))?.id ?? null;
}

export type RemoteAction =
  | { kind: 'volume'; level: number }
  | { kind: 'step'; up: boolean }
  | { kind: 'mute'; on: boolean }
  | { kind: 'input'; id: string }
  | { kind: 'app'; id: string }
  | { kind: 'message'; text: string };

export async function press(ip: string, login: TvLogin, action: RemoteAction): Promise<void> {
  if (!(await powerOf(ip, login))) throw new TvError('The TV is off', 'UNREACHABLE');
  const connection = await linkTo(ip, login);
  switch (action.kind) {
    case 'volume': await connection.request('ssap://audio/setVolume', { volume: action.level }); return;
    case 'step': await connection.request(action.up ? 'ssap://audio/volumeUp' : 'ssap://audio/volumeDown'); return;
    case 'mute': await connection.request('ssap://audio/setMute', { mute: action.on }); return;
    case 'input': await connection.request('ssap://tv/switchInput', { inputId: action.id }); return;
    case 'app': await connection.request('ssap://system.launcher/launch', { id: action.id }); return;
    case 'message': await connection.request('ssap://system.notifications/createToast', { message: action.text }); return;
  }
}

export async function turnOff(ip: string, login: TvLogin): Promise<void> {
  const connection = await linkTo(ip, login);
  await connection.request('ssap://system/turnOff');
}
