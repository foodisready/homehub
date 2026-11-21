/**
 * Honeywell Total Connect Comfort (mytotalconnectcomfort.com), the service a
 * RedLINK Internet Gateway connects Honeywell thermostats to.
 *
 * Honeywell publishes no API for it. This speaks to the same web portal the
 * Total Connect Comfort website uses, as the open-source somecomfort library
 * (Home Assistant's Honeywell integration) does:
 *
 * - Sign in: POST /portal with the email and password as a form. Success sets
 *   a non-empty .ASPXAUTH_TRUEHOME cookie; a wrong password returns the sign-in
 *   page again with "The email or password provided is incorrect." and empty
 *   cookies.
 * - A signed-out or expired session gets 401 on every request.
 * - Locations and their thermostats: POST /portal/Location/GetLocationListData.
 * - A thermostat now: GET /portal/Device/CheckDataSession/<id>.
 * - Changes: POST /portal/Device/SubmitControlScreenChanges, null meaning "leave as is".
 *
 * Temperatures are in the thermostat's own display unit (DisplayUnits 'F' or 'C').
 * Honeywell limits how often an account may ask, so callers poll gently.
 */

export const TCC_BASE = 'https://mytotalconnectcomfort.com';
const AUTH_COOKIE = '.ASPXAUTH_TRUEHOME';
const TIMEOUT_MS = 20_000;

export type TccFailure =
  /** The email or password was refused, or the account can't sign in (locked, say). */
  | 'rejected'
  /** The session ended; signing in again fixes it. */
  | 'expired'
  /** No answer, or Honeywell's servers are having trouble. */
  | 'unreachable'
  /** Honeywell answered, but didn't do what was asked. */
  | 'refused';

export class TccError extends Error {
  constructor(message: string, readonly kind: TccFailure) { super(message); }
}

export interface TccThermostat { id: number; name: string; mac: string | null }
export interface TccLocation { id: number; name: string; thermostats: TccThermostat[] }

/** What CheckDataSession says about a thermostat. `ui` is the portal's uiData, as is. */
export interface TccData {
  /** The thermostat is talking to Honeywell through its gateway. */
  live: boolean;
  ui: Record<string, unknown>;
  fan: { running: boolean } | null;
}

/** The fields SubmitControlScreenChanges takes; anything left out is sent as null, "leave as is". */
export interface TccChange {
  SystemSwitch?: number;
  HeatSetpoint?: number;
  CoolSetpoint?: number;
  StatusHeat?: number;
  StatusCool?: number;
  HeatNextPeriod?: number;
  CoolNextPeriod?: number;
}

type Fetch = typeof fetch;

/** One signed-in session: its cookies, kept in memory only. */
export class TccSession {
  private cookies = new Map<string, string>();

  constructor(private readonly fetchImpl: Fetch = fetch, private readonly base = TCC_BASE) {}

  get signedIn(): boolean { return !!this.cookies.get(AUTH_COOKIE); }

  /** Signs in, replacing any earlier session. Throws a TccError: 'rejected' for a refused email or password. */
  async signIn(email: string, password: string): Promise<void> {
    this.cookies.clear();
    const body = new URLSearchParams({
      timeOffset: String(new Date().getTimezoneOffset()),
      UserName: email,
      Password: password,
      RememberMe: 'false',
    }).toString();
    const res = await this.send('/portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (this.signedIn) return;
    if (res.status >= 500) throw new TccError(`Total Connect Comfort isn’t working right now (error ${res.status}). Try again later.`, 'unreachable');
    const page = await res.text().catch(() => '');
    const said = pageError(page);
    if (said) throw new TccError(`Total Connect Comfort said: ${said}`, 'rejected');
    if (res.status === 200 && /UserName/.test(page)) throw new TccError('Total Connect Comfort didn’t accept that email and password.', 'rejected');
    throw new TccError(`Total Connect Comfort answered in a way HomeHub doesn’t understand (status ${res.status}).`, 'unreachable');
  }

  /** Every location on the account and its thermostats. */
  async locations(): Promise<TccLocation[]> {
    const out: TccLocation[] = [];
    // The portal pages its list; a home has one page, but read on until one comes back empty.
    for (let page = 1; page <= 4; page++) {
      const list = await this.json(`/portal/Location/GetLocationListData?page=${page}&filter=`, { method: 'POST', body: '' });
      if (!Array.isArray(list) || !list.length) break;
      for (const loc of list as Record<string, unknown>[]) {
        const id = Number(loc.LocationID);
        if (!Number.isFinite(id)) continue;
        const devices = Array.isArray(loc.Devices) ? loc.Devices as Record<string, unknown>[] : [];
        out.push({
          id,
          name: typeof loc.Name === 'string' ? loc.Name.trim() : '',
          thermostats: devices
            .filter((d) => Number.isFinite(Number(d.DeviceID)))
            .map((d) => ({
              id: Number(d.DeviceID),
              name: typeof d.Name === 'string' && d.Name.trim() ? d.Name.trim() : `Thermostat ${d.DeviceID}`,
              mac: typeof d.MacID === 'string' ? d.MacID : null,
            })),
        });
      }
    }
    return out;
  }

  /** A thermostat now. */
  async thermostat(deviceId: number): Promise<TccData> {
    const r = await this.json(`/portal/Device/CheckDataSession/${deviceId}?_=${Date.now()}`, { method: 'GET' }) as Record<string, unknown> | null;
    const latest = (r?.latestData ?? null) as Record<string, unknown> | null;
    const ui = latest?.uiData as Record<string, unknown> | undefined;
    if (!r || !ui || typeof ui !== 'object') throw new TccError('Total Connect Comfort sent no readings for that thermostat.', 'refused');
    const fanData = latest?.fanData as Record<string, unknown> | undefined;
    return {
      live: r.deviceLive !== false && r.communicationLost !== true,
      ui,
      fan: latest?.hasFan && fanData ? { running: fanData.fanIsRunning === true } : null,
    };
  }

  /** Sends a change. Throws 'refused' if Honeywell says no. */
  async change(deviceId: number, change: TccChange): Promise<void> {
    const body = {
      DeviceID: deviceId,
      SystemSwitch: null, HeatSetpoint: null, CoolSetpoint: null, HeatNextPeriod: null, CoolNextPeriod: null,
      StatusHeat: null, StatusCool: null, FanMode: null,
      ...change,
    };
    const r = await this.json('/portal/Device/SubmitControlScreenChanges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    }) as { success?: unknown } | null;
    if (!r || Number(r.success) !== 1) throw new TccError('Total Connect Comfort didn’t accept the change.', 'refused');
  }

  /** A JSON request on the signed-in session. */
  private async json(path: string, init: RequestInit): Promise<unknown> {
    const res = await this.send(path, { ...init, headers: { Accept: 'application/json, text/javascript, */*', ...(init.headers ?? {}) } });
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400 && /\/portal(\/Home)?/i.test(res.headers.get('location') ?? ''))) {
      this.cookies.delete(AUTH_COOKIE);
      throw new TccError('The Total Connect Comfort session ended.', 'expired');
    }
    if (res.status >= 500) throw new TccError(`Total Connect Comfort isn’t working right now (error ${res.status}).`, 'unreachable');
    const type = res.headers.get('content-type') ?? '';
    if (res.status !== 200 || !/json/i.test(type)) {
      const page = await res.text().catch(() => '');
      // A sign-in page instead of data: the session is gone.
      if (/UserName/.test(page) && /Password/.test(page)) { this.cookies.delete(AUTH_COOKIE); throw new TccError('The Total Connect Comfort session ended.', 'expired'); }
      throw new TccError(`Total Connect Comfort answered in a way HomeHub doesn’t understand (status ${res.status}).`, 'refused');
    }
    try { return await res.json(); } catch { throw new TccError('Total Connect Comfort sent something that isn’t JSON.', 'refused'); }
  }

  /** One request with the session's cookies, keeping any it sets. Redirects aren't followed. */
  private async send(path: string, init: RequestInit): Promise<Response> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'Mozilla/5.0 (HomeHub)',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      throw new TccError(`Couldn’t reach Total Connect Comfort (${(err as Error)?.name === 'TimeoutError' ? 'no answer' : 'no connection'}). Check HomeHub has internet access.`, 'unreachable');
    }
    for (const line of res.headers.getSetCookie?.() ?? []) this.keepCookie(line);
    return res;
  }

  private keepCookie(line: string): void {
    const [pair, ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expires = attrs.map((a) => a.trim()).find((a) => /^expires=/i.test(a));
    const past = expires ? Date.parse(expires.slice(8)) < Date.now() : false;
    const maxAge0 = attrs.some((a) => /^max-age=0$/i.test(a.trim()));
    // Honeywell clears a cookie by sending it empty with an expiry in 1999.
    if (!value || past || maxAge0) this.cookies.delete(name);
    else this.cookies.set(name, value);
  }
}

/** The error message on a portal page, if it shows one. */
export function pageError(html: string): string | null {
  const m = /validation-summary-errors[^>]*>[\s\S]*?<li>([\s\S]*?)<\/li>/i.exec(html);
  if (!m) return null;
  const text = m[1].replace(/<[^>]+>/g, '').replace(/&#39;/g, '’').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return text || null;
}
