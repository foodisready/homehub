import { Cam, Discovery } from 'onvif';

/**
 * Everything HomeHub asks of an IP camera over ONVIF, the standard most IP
 * cameras speak (Reolink, Amcrest, Axis, UniFi with ONVIF on, and others):
 * where its video and pictures are, whether it turns, motion events, and
 * finding cameras on the network. The rest of HomeHub uses this interface
 * only, so tests replace the camera with a fake.
 */

export interface CameraLogin { host: string; port: number; username: string; password: string }

export interface ProbeResult {
  /** The ONVIF port that answered. */
  port: number;
  maker: string | null;
  model: string | null;
  /** The camera's main stream, RTSP, without the login. */
  mainUrl: string;
  /** A smaller second stream, when the camera has one. */
  subUrl: string | null;
  /** Where to get a JPEG now, without the login. */
  snapshotUrl: string | null;
  canPan: boolean;
}

export type Detection = 'person' | 'vehicle' | 'animal';
export interface MotionEvent { active: boolean; detection: Detection | null }

export interface FoundCamera { host: string; port: number; name: string | null; model: string | null }

export interface MotionWatch { stop(): void }

export type PanAction = 'left' | 'right' | 'up' | 'down' | 'stop';

export interface OnvifConnector {
  /** Connects with the login and reads what the camera offers. */
  probe(login: CameraLogin): Promise<ProbeResult>;
  /** Calls onEvent for each motion change until stopped; onError when the watch stops working. */
  watchMotion(login: CameraLogin, onEvent: (e: MotionEvent) => void, onError: (err: Error) => void): MotionWatch;
  /** A move keeps going for about a second and a half unless repeated, so a lost "stop" can't leave it turning. */
  pan(login: CameraLogin, action: PanAction): Promise<void>;
  /** Cameras that answer an ONVIF search on HomeHub's network. */
  discover(timeoutMs: number): Promise<FoundCamera[]>;
}

export type OnvifProblem = 'login' | 'unreachable' | 'not-onvif' | 'other';

export class OnvifError extends Error {
  constructor(message: string, readonly problem: OnvifProblem) { super(message); }
}

/** The ports cameras usually answer ONVIF on: Amcrest and most others 80, Reolink 8000, Tapo 2020. */
export const ONVIF_PORTS = [80, 8000, 2020, 8080, 8899];

const TIMEOUT_MS = 8_000;
const MOVE_SECONDS = 1.5;
const SPEED = 0.5;

/** The library's errors, sorted into what a person can act on. */
export function classify(err: unknown): OnvifError {
  if (err instanceof OnvifError) return err;
  const text = `${(err as { code?: string })?.code ?? ''} ${(err as Error)?.message ?? String(err)}`;
  if (/NotAuthorized|not authori[sz]ed|Unauthori[sz]ed|\b401\b|Sender not Authorized|password|authenticat/i.test(text)) {
    return new OnvifError('The camera didn\'t accept the username and password', 'login');
  }
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|timed? ?out|socket hang up/i.test(text)) {
    return new OnvifError('No answer from the camera at that address', 'unreachable');
  }
  if (/Wrong ONVIF SOAP response|\b404\b|\b405\b|Not Found|Invalid XML|Non-whitespace|Unexpected close tag/i.test(text)) {
    return new OnvifError('Something answered at that address, but not as an ONVIF camera', 'not-onvif');
  }
  return new OnvifError((err as Error)?.message || 'The camera gave an error', 'other');
}

/** rtsp://user:pass@host/… → rtsp://host/…: HomeHub keeps the login separately. */
export function withoutLogin(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url;
  }
}

const tokenOf = (p: unknown): string | undefined => {
  const o = p as { token?: unknown; $?: { token?: unknown } } | undefined;
  const t = o?.token ?? o?.$?.token;
  return typeof t === 'string' && t ? t : undefined;
};

const uriOf = (r: unknown): string | null => {
  const o = r as { uri?: unknown } | string | undefined;
  const u = typeof o === 'string' ? o : o?.uri;
  return typeof u === 'string' && u ? u : null;
};

const call = <T>(fn: (cb: (err: unknown, data: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => fn((err, data) => (err ? reject(err) : resolve(data))));

function newCam(login: CameraLogin): Cam {
  return new Cam({
    hostname: login.host, port: login.port, username: login.username, password: login.password,
    timeout: TIMEOUT_MS, autoconnect: false,
    // Cameras sometimes name an address of their own for their services; use the one HomeHub reached.
    preserveAddress: true,
  } as ConstructorParameters<typeof Cam>[0]);
}

async function connect(login: CameraLogin): Promise<Cam> {
  const cam = newCam(login);
  // An 'error' event with no listener would crash HomeHub.
  cam.on('error', () => undefined);
  try {
    await call<unknown>((cb) => cam.connect(cb as never));
  } catch (err) {
    throw classify(err);
  }
  return cam;
}

// ── Motion events ─────────────────────────────────────────────────

const MOTION_TOPIC = /Motion|People|Person|Human|Face|Vehicle|Animal|DogCat|Pet|ObjectsInside|Crossed|FieldDetector|LineDetector|Intrusion/i;
const STATE_NAME = /^(IsMotion|State|IsInside|IsCrossed|Value|Active|Alarm)$/i;

/**
 * One ONVIF notification, as a motion change, or null when it isn't about
 * motion. Cameras name it differently: Reolink sends
 * RuleEngine/CellMotionDetector/Motion (IsMotion) and
 * RuleEngine/MyRuleDetector/PeopleDetect (State); Amcrest sends
 * VideoSource/MotionAlarm (State). The current state sent on subscribing
 * ("Initialized") is skipped, so connecting doesn't count as motion.
 */
export function parseMotion(message: unknown): MotionEvent | null {
  const m = message as { topic?: unknown; message?: { message?: { $?: { PropertyOperation?: unknown }; data?: { simpleItem?: unknown } } } };
  const topicRaw = m?.topic as { _?: unknown } | string | undefined;
  const topic = typeof topicRaw === 'string' ? topicRaw : String(topicRaw?._ ?? '');
  if (!MOTION_TOPIC.test(topic)) return null;
  const inner = m?.message?.message;
  if (inner?.$?.PropertyOperation === 'Initialized') return null;
  const raw = inner?.data?.simpleItem;
  const items = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((i) => (i as { $?: unknown })?.$ ?? i) as { Name?: unknown; Value?: unknown }[];
  const item = items.find((i) => typeof i?.Name === 'string' && STATE_NAME.test(i.Name));
  if (!item) return null;
  const v = item.Value;
  const active = v === true || v === 1 || v === 'true' || v === '1';
  const detection: Detection | null = /People|Person|Human|Face/i.test(topic) ? 'person'
    : /Vehicle|Car/i.test(topic) ? 'vehicle'
      : /Animal|DogCat|Pet/i.test(topic) ? 'animal' : null;
  return { active, detection };
}

// ── Discovery ─────────────────────────────────────────────────────

/** "onvif://www.onvif.org/name/Reolink …" → the value after `kind/`. */
function scope(scopes: string, kind: string): string | null {
  const m = scopes.match(new RegExp(`onvif://www\\.onvif\\.org/${kind}/([^\\s]+)`, 'i'));
  if (!m) return null;
  try { return decodeURIComponent(m[1]).replace(/_/g, ' ') || null; } catch { return m[1]; }
}

export function parseProbeMatch(raw: unknown): FoundCamera | null {
  const match = (raw as { probeMatches?: { probeMatch?: { XAddrs?: unknown; scopes?: unknown } } })?.probeMatches?.probeMatch;
  if (!match || typeof match.XAddrs !== 'string') return null;
  for (const addr of match.XAddrs.split(/\s+/)) {
    try {
      const u = new URL(addr);
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)) continue;   // skip IPv6 and names
      const scopes = typeof match.scopes === 'string' ? match.scopes : '';
      return { host: u.hostname, port: Number(u.port) || 80, name: scope(scopes, 'name'), model: scope(scopes, 'hardware') };
    } catch { /* next address */ }
  }
  return null;
}

// ── The library ───────────────────────────────────────────────────

/** Connected cameras for turning, which needs a connection each time otherwise. */
const panCams = new Map<string, Promise<Cam>>();
const loginKey = (l: CameraLogin) => `${l.host}:${l.port}:${l.username}:${l.password}`;

export const onvifLibrary: OnvifConnector = {
  async probe(login) {
    const cam = await connect(login);
    let info: { manufacturer?: string; model?: string } = {};
    try { info = await call((cb) => cam.getDeviceInformation(cb as never)); } catch { /* optional */ }
    const profiles = (cam.profiles ?? []).filter((p) => tokenOf(p));
    const main = profiles[0];
    const token = tokenOf(main) ?? cam.activeSource?.profileToken;
    let mainUrl: string | null;
    try {
      mainUrl = uriOf(await call((cb) => cam.getStreamUri({ protocol: 'RTSP', profileToken: token }, cb as never)));
    } catch (err) {
      throw classify(err);
    }
    if (!mainUrl) throw new OnvifError('The camera didn\'t say where its video is', 'other');
    let subUrl: string | null = null;
    if (profiles[1]) {
      try {
        subUrl = uriOf(await call((cb) => cam.getStreamUri({ protocol: 'RTSP', profileToken: tokenOf(profiles[1]) }, cb as never)));
      } catch { /* one stream only */ }
    }
    let snapshotUrl: string | null = null;
    try {
      snapshotUrl = uriOf(await call((cb) => cam.getSnapshotUri({ profileToken: token }, cb as never)));
    } catch { /* pictures come from the video instead */ }
    const canPan = !!cam.uri?.ptz && !!(main?.PTZConfiguration ?? cam.activeSource?.ptz);
    return {
      port: login.port,
      maker: info.manufacturer?.trim() || null,
      model: info.model?.trim() || null,
      mainUrl: withoutLogin(mainUrl),
      subUrl: subUrl && subUrl !== mainUrl ? withoutLogin(subUrl) : null,
      snapshotUrl: snapshotUrl ? withoutLogin(snapshotUrl) : null,
      canPan,
    };
  },

  watchMotion(login, onEvent, onError) {
    let stopped = false;
    const cam = newCam(login);
    const fail = (err: unknown) => { if (!stopped) onError(classify(err)); };
    cam.on('error', fail);
    cam.connect((err: unknown) => {
      if (stopped) return;
      if (err) return fail(err);
      // Connected, so a failure now is about events, unless the camera went away.
      cam.on('eventsError', (e: unknown) => {
        const c = classify(e);
        fail(c.problem === 'unreachable' || c.problem === 'login' ? c : new OnvifError('The camera doesn\'t send motion events over ONVIF', 'other'));
      });
      cam.on('event', (message: unknown) => {
        if (stopped) return;
        const e = parseMotion(message);
        if (e) onEvent(e);
      });
    });
    return {
      stop() {
        stopped = true;
        // With no 'event' listener left, the library stops pulling and unsubscribes.
        cam.removeAllListeners('event');
        cam.removeAllListeners('eventsError');
      },
    };
  },

  async pan(login, action) {
    const key = loginKey(login);
    let pending = panCams.get(key);
    if (!pending) {
      pending = connect(login);
      panCams.set(key, pending);
      pending.catch(() => panCams.delete(key));
    }
    const cam = await pending;
    try {
      if (action === 'stop') {
        await call((cb) => cam.stop({ panTilt: true, zoom: true }, cb as never));
      } else {
        const x = action === 'left' ? -SPEED : action === 'right' ? SPEED : 0;
        const y = action === 'up' ? SPEED : action === 'down' ? -SPEED : 0;
        await call((cb) => cam.continuousMove({ x, y, zoom: 0, timeout: MOVE_SECONDS * 1000 } as never, cb as never));
      }
    } catch (err) {
      panCams.delete(key);
      throw classify(err);
    }
  },

  discover(timeoutMs) {
    // A garbled reply from some device emits 'error', which would crash HomeHub with no listener.
    if (!Discovery.listenerCount('error')) Discovery.on('error', () => undefined);
    return new Promise((resolve) => {
      Discovery.probe({ timeout: timeoutMs, resolve: false }, (_err, devices) => {
        const found = new Map<string, FoundCamera>();
        for (const d of devices ?? []) {
          const cam = parseProbeMatch(d);
          if (cam && !found.has(cam.host)) found.set(cam.host, cam);
        }
        resolve([...found.values()]);
      });
    });
  },
};
