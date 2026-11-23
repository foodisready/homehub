/**
 * Alarm.com, through the same web connection its website uses. Alarm.com publishes nothing for
 * homeowners; this follows the open-source pyalarmdotcomajax library (Home Assistant's Alarm.com
 * integration), including the fixes in its maintained fork:
 *
 * - Sign in: GET /login for the page's hidden ASP.NET fields, then POST them with the username
 *   and password to /web/Default.aspx. Alarm.com answers with redirects; a redirect to
 *   "m=login_fail" means a wrong password, "m=LockedOut" a locked account. Redirects are followed
 *   here, one hop at a time, because the cookies that matter (the session, "afg", the trusted
 *   device) are often set on a hop in the middle, which fetch would hide.
 * - Every later request carries the latest "afg" cookie as the Ajaxrequestuniquekey header.
 * - Two-step verification: GET /web/api/identities for the user id, then the
 *   twoFactorAuthentications endpoints to read, send, verify and trust. Trusting sets a
 *   "twoFactorAuthenticationId" cookie; sent on later sign-ins, Alarm.com skips the code.
 * - Everything on the alarm in one request: GET /web/api/settings/manageDevices/deviceCatalogs/{system}.
 * - Keep-alive every minute (GET /web/KeepAlive.aspx, 403 when the session ended), and
 *   POST /web/api/identities/{id}/reloadContext about every 13 minutes; sessions end after 15.
 * - Live changes: a websocket, with a token from /web/api/websockets/token. Alarm.com closes it
 *   about every 5 minutes, so it's renewed every 4½.
 * - Arm and disarm: POST /web/api/devices/partitions/{id}/armStay|armAway|disarm. Alarm.com takes
 *   no PIN; the session is the authority, so HomeHub checks its own PIN before disarming.
 *
 * Each sign-in sends the account a "Successful Login" alert and signs out its browser sessions,
 * so the service signs in as rarely as it can: one at a time, and never in a loop.
 */
import os from 'node:os';
import WsSocket from 'ws';
import {
  AdcError,
  type AdcChallenge, type AdcConnector, type AdcEvent, type AdcPartition, type AdcSensor, type AdcSession, type AdcSignIn,
  type AdcSnapshot, type AdcHistoryEvent, type ArmCommand, type ArmState, type CodeMethod, type SensorKind, type SensorState,
} from './types';

export const ADC_BASE = 'https://www.alarm.com';
const WS_FALLBACK = 'wss://webskt.alarm.com:8443';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
const TIMEOUT_MS = 30_000;
/** Arm and disarm wait for the panel: give them longer. */
const COMMAND_TIMEOUT_MS = Number(process.env.ALARMCOM_COMMAND_TIMEOUT_MS) || 120_000;
const TRUST_COOKIE = 'twoFactorAuthenticationId';
const TWO_FACTOR = '/web/api/engines/twoFactorAuthentication/twoFactorAuthentications';
/** Alarm.com closes its websocket about 5 minutes after the token was issued: renew before. */
const WS_ROTATE_MS = 270_000;
const WS_RETRY_MAX_MS = 5 * 60_000;
/** The first wait after a refused connection, doubling each time. */
const wsRetryMinMs = () => Number(process.env.ALARMCOM_WS_RETRY_MS) || 5_000;

type Fetch = typeof fetch;
type Json = Record<string, unknown>;

const METHOD_BITS: Record<CodeMethod, number> = { app: 1, sms: 2, email: 4 };

// ── Reading Alarm.com's answers ──────────────────────────────────────

const PARTITION_STATES: Record<number, ArmState> = { 1: 'disarmed', 2: 'armed-stay', 3: 'armed-away', 4: 'armed-night' };

/** A sensor's kind, from Alarm.com's deviceType and, for contacts, its name. */
export function sensorKind(deviceType: number, name: string): SensorKind {
  switch (deviceType) {
    case 1: case 52: return /\b(window|wndw|wdw|win)\b/i.test(name) ? 'window' : 'door';
    case 2: case 89: return 'motion';
    case 19: case 83: return 'glass';
    case 5: return 'smoke';
    case 6: return 'co';
    case 8: return 'temperature';
    default: return 'other';
  }
}

/** A sensor's state. Motion and glass-break sensors are idle or active, whatever number Alarm.com uses. */
export function sensorState(state: number, kind: SensorKind): SensorState {
  const activity = kind === 'motion' || kind === 'glass';
  switch (state) {
    case 1: return activity ? 'idle' : 'closed';
    case 2: return activity ? 'active' : 'open';
    case 3: return 'idle';
    case 4: return 'active';
    case 5: return 'dry';
    case 6: return 'wet';
    case 9: return activity ? 'idle' : 'closed';   // opened and closed again
    default: return 'unknown';
  }
}

const flat = (v: unknown): number[] => (Array.isArray(v) ? v.flat(3).map(Number).filter(Number.isFinite) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** The partitions and sensors in a device catalog. */
export function parseCatalog(body: unknown): AdcSnapshot {
  const included = Array.isArray((body as Json)?.included) ? (body as Json).included as Json[] : [];
  const partitions: AdcPartition[] = [];
  const sensors: AdcSensor[] = [];
  for (const item of included) {
    const a = (item.attributes ?? {}) as Json;
    const id = str(item.id);
    if (!id) continue;
    if (item.type === 'devices/partition') {
      const state = PARTITION_STATES[Number(a.state)] ?? 'unknown';
      const desired = PARTITION_STATES[Number(a.desiredState)] ?? null;
      const rel = ((item.relationships as Json)?.sensors as Json)?.data;
      partitions.push({
        id,
        name: str(a.description).trim() || 'Alarm',
        state,
        pending: desired && desired !== state ? desired : null,
        canNight: flat(((a.extendedArmingOptions ?? {}) as Json).ArmedNight).includes(3),
        sensorIds: Array.isArray(rel) ? rel.map((r) => str((r as Json).id)).filter(Boolean) : [],
      });
    } else if (item.type === 'devices/sensor') {
      const name = str(a.description).trim() || `Sensor ${id}`;
      const kind = sensorKind(Number(a.deviceType), name);
      sensors.push({
        id,
        name,
        kind,
        state: sensorState(Number(a.state), kind),
        bypassed: a.isBypassed === true,
        lowBattery: a.lowBattery === true || a.criticalBattery === true
          || (typeof a.batteryLevelClassification === 'number' && a.batteryLevelClassification <= 1),
        changedAt: null,
        label: str(a.displayStateText).trim().slice(0, 40) || null,
      });
    }
  }
  return { partitions, sensors };
}

/** The events in an activity-history answer (its `included` "activity/history-event" items), oldest first. */
export function parseHistory(body: unknown): AdcHistoryEvent[] {
  const included = Array.isArray((body as Json)?.included) ? (body as Json).included as Json[] : [];
  const out: AdcHistoryEvent[] = [];
  for (const item of included) {
    if (item.type !== 'activity/history-event') continue;
    const a = (item.attributes ?? {}) as Json;
    const id = str(item.id);
    const at = str(a.eventDate ?? a.date);
    if (!id || !at || !Number.isFinite(Date.parse(at))) continue;
    let who: string | null = null;
    try { who = new URLSearchParams(str(a.extraData)).get('ew')?.trim() || null; } catch { who = null; }
    out.push({
      id,
      at: new Date(Date.parse(at)).toISOString(),
      deviceId: str(a.globalDeviceId) || (a.unitId !== undefined && a.deviceId !== undefined ? `${str(a.unitId)}-${str(a.deviceId)}` : ''),
      deviceName: str(a.deviceDescription).trim(),
      type: str(a.eventTypeName),
      description: str(a.description).trim(),
      who,
    });
  }
  return out.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
}

/** The error code in a JSON:API error body ({"errors":[{"code":409}]}), if there is one. */
export function errorCode(body: unknown): number | null {
  const errors = (body as Json)?.errors;
  if (!Array.isArray(errors) || !errors.length) return null;
  for (const e of errors as Json[]) {
    const n = Number(e.code ?? e.status);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function errorDetail(body: unknown): string | null {
  const errors = (body as Json)?.errors;
  if (!Array.isArray(errors)) return null;
  const d = (errors as Json[]).map((e) => str(e.detail).trim()).find(Boolean);
  return d || null;
}

/** One websocket message, as HomeHub needs it; null for messages that change nothing shown. */
export function parseEvent(text: string): AdcEvent | null {
  let m: Json;
  try { m = JSON.parse(text) as Json; } catch { return null; }
  if (!m || typeof m !== 'object' || !('EventType' in m)) return null;
  if (!('QstringForExtraData' in m) && 'CorrelatedId' in m) return null;   // monitoring station chatter
  const id = `${str(m.UnitId)}-${str(m.DeviceId)}`;
  switch (Number(m.EventType)) {
    case 15: return { kind: 'sensor', id, state: 'open' };
    case 0: case 103: return { kind: 'sensor', id, state: 'closed' };
    case 100: return { kind: 'sensor', id, state: 'pulse' };
    case 13: return { kind: 'bypass', id, bypassed: true };
    case 35: return { kind: 'bypass', id, bypassed: false };
    case 8: return { kind: 'partition', id, state: 'disarmed' };
    case 9: return { kind: 'partition', id, state: 'armed-stay' };
    case 10: return { kind: 'partition', id, state: 'armed-away' };
    case 113: return { kind: 'partition', id, state: 'armed-night' };
    case 101: return null;   // "left open": the sensor already says open
    default: return { kind: 'other' };
  }
}

/** The value of a hidden field on the sign-in page, by its id. */
export function hiddenField(html: string, id: string): string | null {
  const tag = new RegExp(`<input[^>]*\\bid="${id.replace(/\$/g, '\\$')}"[^>]*>`, 'i').exec(html)?.[0];
  if (!tag) return null;
  const v = /\bvalue="([^"]*)"/i.exec(tag)?.[1];
  return v === undefined ? null : v.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// ── The connection ───────────────────────────────────────────────────

/** Cookies for alarm.com, kept by name: every cookie is alarm.com's own. */
class Jar {
  private readonly cookies = new Map<string, string>();
  get(name: string): string | null { return this.cookies.get(name) ?? null; }
  set(name: string, value: string): void { this.cookies.set(name, value); }
  header(): string { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  take(res: Response): void {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expires = attrs.map((a) => a.trim()).find((a) => /^expires=/i.test(a));
      const gone = !value || attrs.some((a) => /^max-age=0$/i.test(a.trim())) || (expires ? Date.parse(expires.slice(8)) < Date.now() : false);
      if (gone) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

type Accept = 'html' | 'jsonapi' | 'json';
const ACCEPT: Record<Accept, string> = {
  html: 'text/html,application/xhtml+xml,application/xml',
  jsonapi: 'application/vnd.api+json',
  json: 'application/json',
};

interface Answer { status: number; url: string; body: unknown; text: string }

export class AdcConnection {
  readonly jar = new Jar();
  userId = '';
  systemId = '';
  private keepAlivePath = '/web/KeepAlive.aspx';
  private reloadEveryMs = 780_000;
  private lastReload = Date.now();

  constructor(private readonly fetchImpl: Fetch = fetch, readonly base = ADC_BASE) {}

  /** One request, following redirects a hop at a time so no cookie is missed. */
  async request(method: string, path: string, opts: { accept?: Accept; json?: unknown; form?: URLSearchParams; timeoutMs?: number } = {}): Promise<Answer> {
    let url = new URL(path, this.base).toString();
    let m = method;
    let body: string | undefined = opts.form ? opts.form.toString() : opts.json !== undefined ? JSON.stringify(opts.json) : undefined;
    for (let hop = 0; hop < 10; hop++) {
      const afg = this.jar.get('afg');
      const headers: Record<string, string> = {
        'User-Agent': UA,
        Referer: `${this.base}/web/system/home`,
        Accept: ACCEPT[opts.accept ?? 'jsonapi'],
        ...(afg ? { Ajaxrequestuniquekey: afg } : {}),
        ...(this.jar.header() ? { Cookie: this.jar.header() } : {}),
        ...(body !== undefined ? { 'Content-Type': opts.form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
      };
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method: m, headers, body, redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS) });
      } catch (err) {
        const timedOut = (err as Error)?.name === 'TimeoutError';
        // Code -1: sent, but no answer in time, so it may have arrived.
        throw new AdcError(`Couldn’t reach Alarm.com (${timedOut ? 'no answer' : 'no connection'})`, 'unreachable', timedOut ? -1 : undefined);
      }
      this.jar.take(res);
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url).toString();
        // A redirect after a POST is fetched with GET, as browsers do.
        if (res.status !== 307 && res.status !== 308) { m = 'GET'; body = undefined; }
        continue;
      }
      const text = await res.text().catch(() => '');
      let parsed: unknown = null;
      if (text && /json/i.test(res.headers.get('content-type') ?? '') || /^\s*[{[]/.test(text)) {
        try { parsed = JSON.parse(text); } catch { parsed = null; }
      }
      return { status: res.status, url, body: parsed, text };
    }
    throw new AdcError('Alarm.com redirected too many times', 'unreachable');
  }

  /** A JSON request on the signed-in session; throws an AdcError for Alarm.com's error codes. */
  async api(method: string, path: string, opts: { accept?: Accept; json?: unknown; timeoutMs?: number } = {}): Promise<Json> {
    const r = await this.request(method, path, opts);
    if (new URL(r.url).pathname.toLowerCase().startsWith('/login')) throw new AdcError('The Alarm.com session ended', 'expired');
    const code = errorCode(r.body) ?? (r.status >= 400 ? r.status : null);
    if (code !== null) {
      const detail = errorDetail(r.body);
      if (code === 401 || code === 403) throw new AdcError('The Alarm.com session ended', 'expired', code);
      if (code === 409) throw new AdcError('Alarm.com wants a verification code', 'code-needed', code);
      if (code === 406 || code === 423) throw new AdcError(detail ?? 'Alarm.com doesn’t allow that for this login', 'refused', code);
      if (code === 422) throw new AdcError(detail ?? 'Alarm.com didn’t accept that', 'refused', code);
      if (code === 429 || code >= 500) throw new AdcError(`Alarm.com isn’t working right now (error ${code})`, 'unreachable', code);
      throw new AdcError(detail ?? `Alarm.com answered with error ${code}`, 'unreachable', code);
    }
    if (!r.body || typeof r.body !== 'object') throw new AdcError(`Alarm.com sent something HomeHub doesn’t understand (status ${r.status})`, 'unreachable');
    return r.body as Json;
  }

  /** Steps 1 and 2: the sign-in page, then the username and password. */
  async submitPassword(username: string, password: string, trust: string | null): Promise<void> {
    if (trust) this.jar.set(TRUST_COOKIE, trust);
    const page = await this.request('GET', '/login', { accept: 'html' });
    if (page.status >= 500 || page.status === 429) throw new AdcError(`Alarm.com isn’t working right now (error ${page.status})`, 'unreachable');
    const fields: Record<string, string> = {};
    for (const id of ['__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION', '__PREVIOUSPAGE']) {
      const v = hiddenField(page.text, id);
      if (v === null) throw new AdcError('Alarm.com’s sign-in page has changed, so HomeHub can’t sign in. HomeHub needs an update.', 'unreachable');
      fields[id] = v;
    }
    const form = new URLSearchParams({
      ctl00$ContentPlaceHolder1$loginform$txtUserName: username,
      txtPassword: password,
      ...fields,
      __EVENTTARGET: '',
      __EVENTARGUMENT: '',
      __VIEWSTATEENCRYPTED: '',
      IsFromNewSite: '1',
    });
    // Redirects are followed by hand so each landing can be checked.
    let url = new URL('/web/Default.aspx', this.base).toString();
    let method = 'POST';
    let body: string | undefined = form.toString();
    for (let hop = 0; hop < 10; hop++) {
      if (/[?&]m=login_fail\b/i.test(url)) throw new AdcError('Alarm.com didn’t accept that username and password.', 'rejected');
      if (/[?&]m=LockedOut\b/i.test(url)) throw new AdcError('Alarm.com says the account is locked. Unlock it in the Alarm.com app or website, then sign in again.', 'rejected');
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: {
            'User-Agent': UA,
            Referer: `${this.base}/login`,
            Accept: ACCEPT.html,
            ...(this.jar.header() ? { Cookie: this.jar.header() } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          },
        });
      } catch (err) {
        throw new AdcError(`Couldn’t reach Alarm.com (${(err as Error)?.name === 'TimeoutError' ? 'no answer' : 'no connection'})`, 'unreachable');
      }
      this.jar.take(res);
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url).toString();
        method = 'GET';
        body = undefined;
        continue;
      }
      await res.text().catch(() => '');
      if (res.status === 429 || res.status >= 500) throw new AdcError(`Alarm.com isn’t working right now (error ${res.status})`, 'unreachable');
      if (new URL(url).pathname.toLowerCase().startsWith('/login')) {
        throw new AdcError('Alarm.com didn’t finish signing in. Try again in a few minutes.', 'unreachable');
      }
      return;
    }
    throw new AdcError('Alarm.com redirected too many times', 'unreachable');
  }

  /** Step 3: who signed in, and how to keep the session going. */
  async identify(): Promise<void> {
    const r = await this.api('GET', '/web/api/identities');
    const first = Array.isArray(r.data) ? (r.data as Json[])[0] : null;
    this.userId = str(first?.id);
    if (!this.userId) throw new AdcError('Alarm.com didn’t say who signed in', 'unreachable');
    const props = ((first?.attributes as Json)?.applicationSessionProperties ?? {}) as Json;
    if (typeof props.keepAliveUrl === 'string' && props.keepAliveUrl.startsWith('/')) this.keepAlivePath = props.keepAliveUrl;
    const warn = Number(props.inactivityWarningTimeoutMs);
    if (Number.isFinite(warn) && warn >= 60_000) this.reloadEveryMs = warn;
    this.lastReload = Date.now();
    this.systemId = str((((first?.relationships as Json)?.selectedSystem as Json)?.data as Json)?.id);
  }

  /** Step 4: what two-step verification wants: nothing (trusted, or off) or a code. */
  async twoFactor(): Promise<{ methods: CodeMethod[]; sentTo: string | null } | null> {
    const r = await this.api('GET', `${TWO_FACTOR}/${this.userId}`);
    const a = ((r.data as Json)?.attributes ?? {}) as Json;
    if (a.showSuggestedSetup === true) {
      throw new AdcError('Alarm.com wants two-step verification set up first. Set it up in the Alarm.com app or website, then sign in here again.', 'rejected');
    }
    const mask = Number(a.enabledTwoFactorTypes);
    if (!Number.isFinite(mask) || mask <= 0 || a.isCurrentDeviceTrusted === true) return null;
    const methods = (['sms', 'email', 'app'] as CodeMethod[]).filter((k) => mask & METHOD_BITS[k]);
    return methods.length ? { methods, sentTo: null } : null;
  }

  async sendCode(method: CodeMethod): Promise<string | null> {
    if (method === 'app') return null;
    await this.api('POST', `${TWO_FACTOR}/${this.userId}/sendTwoFactorAuthenticationCodeVia${method === 'sms' ? 'Sms' : 'Email'}`, { accept: 'json' });
    return null;
  }

  /** Checks the code, then asks Alarm.com to trust this HomeHub. Returns the trust cookie. */
  async verify(code: string, method: CodeMethod): Promise<string | null> {
    try {
      await this.api('POST', `${TWO_FACTOR}/${this.userId}/verifyTwoFactorCode`, { accept: 'json', json: { code, typeOf2FA: METHOD_BITS[method] } });
    } catch (err) {
      if (err instanceof AdcError && err.code === 422) throw new AdcError('That code didn’t work.', 'rejected', 422);
      throw err;
    }
    // Best effort: without it, Alarm.com asks for a code at every sign-in.
    try {
      await this.api('POST', `${TWO_FACTOR}/${this.userId}/trustTwoFactorDevice`, { accept: 'json', json: { deviceName: `HomeHub (${os.hostname().slice(0, 40)})` } });
    } catch { /* checked below */ }
    return this.jar.get(TRUST_COOKIE);
  }

  /** Step 5: the alarm system to read. */
  async findSystem(): Promise<void> {
    try {
      const r = await this.api('GET', '/web/api/systems/availableSystemItems');
      const list = Array.isArray(r.data) ? r.data as Json[] : [];
      const picked = list.find((s) => (s.attributes as Json)?.isSelected === true) ?? (list.length === 1 ? list[0] : null);
      if (picked) this.systemId = str(picked.id);
    } catch (err) {
      if (!this.systemId || (err instanceof AdcError && err.kind === 'expired')) throw err;
    }
    if (!this.systemId) throw new AdcError('Alarm.com shows no alarm system on this login', 'refused');
  }

  async read(): Promise<AdcSnapshot> {
    return parseCatalog(await this.api('GET', `/web/api/settings/manageDevices/deviceCatalogs/${this.systemId}`));
  }

  async keepAlive(now = Date.now()): Promise<void> {
    const r = await this.request('GET', `${this.keepAlivePath}?timestamp=${Math.round(now / 1000)}`, { accept: 'json' });
    if (r.status === 403 || r.status === 401 || new URL(r.url).pathname.toLowerCase().startsWith('/login')) throw new AdcError('The Alarm.com session ended', 'expired', r.status);
    if (r.status >= 500) throw new AdcError(`Alarm.com isn’t working right now (error ${r.status})`, 'unreachable', r.status);
    if (now - this.lastReload >= this.reloadEveryMs) {
      this.lastReload = now;
      await this.api('POST', `/web/api/identities/${this.userId}/reloadContext`, { json: { included: [], meta: { transformer_version: '1.1' } } });
    }
  }

  async command(partitionId: string, command: ArmCommand, opts: { bypass: boolean }): Promise<void> {
    const action = command === 'armNight' ? 'armStay' : command;
    const body = {
      statePollOnly: false,
      forceBypass: command !== 'disarm' && opts.bypass,
      noEntryDelay: false,
      silentArming: false,
      nightArming: command === 'armNight',
      selectiveBypass: false,
      forceArm: false,
    };
    // Alarm.com answers once the panel has: over a minute on some panels (an NX-6, 2026-11-22).
    await this.api('POST', `/web/api/devices/partitions/${encodeURIComponent(partitionId)}/${action}`, { json: body, timeoutMs: COMMAND_TIMEOUT_MS });
  }

  /** The activity history since `since`, a page of 100 at a time (at most 5 pages), oldest first. */
  async history(since: Date): Promise<AdcHistoryEvent[]> {
    const all: AdcHistoryEvent[] = [];
    for (let page = 1; page <= 5; page++) {
      const q = new URLSearchParams({
        debounceTimeMs: '1000', startTime: since.toISOString(), endTime: '', page: String(page), pageSize: '100',
        searchString: '', showOnlyOpenEyeEvents: 'false',
      });
      const events = parseHistory(await this.api('GET', `/web/api/activity/activityDays?${q}`));
      all.push(...events);
      if (events.length < 100) break;
    }
    const seen = new Set<string>();
    return all.filter((e) => !seen.has(e.id) && seen.add(e.id)).sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  }

  /** What the websocket needs to be let in: the session's cookies, as a browser on alarm.com would send. */
  socketHeaders(): Record<string, string> {
    return { 'User-Agent': UA, Origin: this.base, ...(this.jar.header() ? { Cookie: this.jar.header() } : {}) };
  }

  async wsToken(): Promise<{ token: string; endpoint: string }> {
    const r = await this.api('GET', '/web/api/websockets/token', { accept: 'json' });
    const token = str(r.value);
    if (!token) throw new AdcError('Alarm.com gave no live-update token', 'unreachable');
    const endpoint = str((r.metaData as Json)?.endpoint).replace(/\/+$/, '');
    return { token, endpoint: /^wss:\/\//.test(endpoint) ? endpoint : WS_FALLBACK };
  }
}

// ── Sessions ─────────────────────────────────────────────────────────

type SocketLike = {
  close(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number; reason?: string }) => void) | null;
  onopen: (() => void) | null;
  onerror: ((e?: { message?: string }) => void) | null;
};
type SocketMaker = (url: string, headers: Record<string, string>) => SocketLike;
/**
 * The ws package rather than Node's own WebSocket, which can't send headers: Alarm.com's websocket
 * server turns a connection away without the session's cookies and its website's Origin.
 */
const makeSocket: SocketMaker = (url, headers) => new WsSocket(url, { headers, handshakeTimeout: 15_000 }) as unknown as SocketLike;

/**
 * The live-update address. The token goes in as Alarm.com issued it, as the Python library sends
 * it; escaping its "+", "/" or "=" is the likeliest reason Alarm.com turned every connection away
 * at once (1008, seen 2026-11-22). Only a token with characters that would break the address is escaped.
 */
export function socketUrl(endpoint: string, token: string): string {
  const safe = /^[A-Za-z0-9._~+/=:-]+$/.test(token);
  return `${endpoint}/?f=1&auth=${safe ? token : encodeURIComponent(token)}`;
}

/** A connection that ends sooner than this after opening counts as refused. */
const WS_STABLE_MS = 30_000;
/** After this many refused connections in a row, live updates rest this long (polling carries on). */
const WS_GIVE_UP_AFTER = 6;
const WS_REST_MS = 4 * 60 * 60_000;
/** Open this long before it counts as live, and HomeHub reads once to catch up. */
const wsSettledMs = () => Number(process.env.ALARMCOM_WS_SETTLED_MS) || 5_000;

export class AdcLiveSession implements AdcSession {
  private closed = false;
  private stops = new Set<() => void>();

  constructor(readonly conn: AdcConnection, private readonly socket: SocketMaker = makeSocket) {}

  read(): Promise<AdcSnapshot> { return this.conn.read(); }
  keepAlive(): Promise<void> { return this.conn.keepAlive(); }
  history(since: Date): Promise<AdcHistoryEvent[]> { return this.conn.history(since); }
  command(partitionId: string, command: ArmCommand, opts: { bypass: boolean }): Promise<void> {
    return this.conn.command(partitionId, command, opts);
  }

  watch(changed: (e: AdcEvent) => void, status: (live: boolean, reason?: string) => void): () => void {
    let stopped = false;
    let ws: SocketLike | null = null;
    let rotate: NodeJS.Timeout | null = null;
    let settled: NodeJS.Timeout | null = null;
    let retry: NodeJS.Timeout | null = null;
    /** Connections in a row that were refused or ended at once. */
    let refused = 0;
    let isLive = false;
    const setLive = (on: boolean, reason?: string) => {
      if (on === isLive) return;
      isLive = on;
      status(on, reason);
    };
    const clear = () => {
      if (rotate) clearTimeout(rotate);
      if (settled) clearTimeout(settled);
      rotate = settled = null;
      if (ws) { ws.onclose = null; ws.onmessage = null; ws.onerror = null; ws.onopen = null; try { ws.close(); } catch { /* already closed */ } }
      ws = null;
    };
    const again = (reason: string, quick: boolean) => {
      clear();
      if (stopped || this.closed) return;
      refused = quick ? refused + 1 : 0;
      if (isLive) setLive(false, reason);
      else status(false, reason);   // each failed try, so the log says why
      let wait = Math.min(WS_RETRY_MAX_MS, wsRetryMinMs() * 2 ** Math.min(refused, 6));
      if (refused >= WS_GIVE_UP_AFTER) {
        // Alarm.com keeps turning it away: stop asking for a while rather than hammer it.
        wait = WS_REST_MS;
        refused = 0;
        status(false, `refused ${WS_GIVE_UP_AFTER} times (${reason}); trying again in ${WS_REST_MS / 3_600_000} h`);
      }
      retry = setTimeout(() => { retry = null; void open(); }, wait);
      retry.unref();
    };
    const open = async () => {
      if (stopped || this.closed) return;
      let t: { token: string; endpoint: string };
      try {
        t = await this.conn.wsToken();
      } catch (err) {
        again((err as Error).message, true);
        return;
      }
      if (stopped || this.closed) return;
      let next: SocketLike;
      try {
        next = this.socket(socketUrl(t.endpoint, t.token), this.conn.socketHeaders());
      } catch (err) {
        again((err as Error).message, true);
        return;
      }
      ws = next;
      let openedAt = 0;
      let error = '';
      next.onopen = () => {
        openedAt = Date.now();
        settled = setTimeout(() => {
          settled = null;
          if (ws !== next) return;
          setLive(true);
          changed({ kind: 'other' });   // events in the gap are lost: read everything once
        }, wsSettledMs());
        settled.unref();
      };
      next.onmessage = (e) => {
        const text = typeof e.data === 'string' ? e.data : Buffer.isBuffer(e.data) ? e.data.toString('utf8') : null;
        if (!text) return;
        const ev = parseEvent(text);
        if (ev) changed(ev);
      };
      next.onerror = (e) => { error = String(e?.message ?? '').slice(0, 120); };   // onclose follows
      next.onclose = (e) => {
        if (ws !== next) return;
        const lived = openedAt ? Date.now() - openedAt : 0;
        const why = `closed ${e.code}${e.reason ? ` (${String(e.reason).slice(0, 80)})` : ''}${openedAt ? ` after ${Math.round(lived / 1000)} s` : ' before opening'}${error ? `: ${error}` : ''} (token: ${t.token.length} characters${/[+/=]/.test(t.token) ? ', with + / or =' : ''})`;
        again(why, lived < WS_STABLE_MS);
      };
      // Renew before Alarm.com closes it: a fresh connection, then the old one goes.
      rotate = setTimeout(() => {
        if (ws !== next) return;
        const old = next;
        ws = null;
        old.onclose = null;
        try { old.close(); } catch { /* gone */ }
        void open();
      }, WS_ROTATE_MS);
      rotate.unref();
    };
    void open();
    const stop = () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      clear();
      this.stops.delete(stop);
    };
    this.stops.add(stop);
    return stop;
  }

  close(): void {
    this.closed = true;
    for (const stop of [...this.stops]) stop();
  }
}

/** Signs in: password, then two-step verification if Alarm.com wants it, then the system to read. */
export async function signIn(username: string, password: string, trust: string | null, fetchImpl: Fetch = fetch, base = ADC_BASE, socket: SocketMaker = makeSocket): Promise<AdcSignIn> {
  const conn = new AdcConnection(fetchImpl, base);
  await conn.submitPassword(username, password, trust);
  try {
    await conn.identify();
  } catch (err) {
    // Signed in but turned away at once: the password worked, but the session didn't.
    if (err instanceof AdcError && err.kind === 'expired') throw new AdcError('Alarm.com signed HomeHub in, then turned it away. Try again in a few minutes.', 'unreachable');
    throw err;
  }
  const wants = await conn.twoFactor();
  if (!wants) {
    await conn.findSystem();
    return { kind: 'ok', session: new AdcLiveSession(conn, socket) };
  }
  const challenge: AdcChallenge = {
    send: (method) => conn.sendCode(method),
    async verify(code, method) {
      const trusted = await conn.verify(code, method);
      await conn.findSystem();
      return { session: new AdcLiveSession(conn, socket), trust: trusted };
    },
  };
  return { kind: 'code', methods: wants.methods, sentTo: wants.sentTo, challenge };
}

/**
 * For development only: ALARMCOM_BASE_URL points HomeHub at a fake Alarm.com on this computer.
 * Anything not on localhost is ignored, so a stray setting can never send a password elsewhere.
 */
export function devBase(env = process.env.ALARMCOM_BASE_URL): string {
  if (!env) return ADC_BASE;
  try {
    const u = new URL(env);
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return u.origin;
  } catch { /* ignored */ }
  return ADC_BASE;
}

export const adcLibrary: AdcConnector = {
  signIn: (username, password, trust) => signIn(username, password, trust, fetch, devBase()),
};
