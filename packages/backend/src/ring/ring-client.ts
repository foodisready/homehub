/**
 * The thin layer between HomeHub and ring-client-api, the unofficial Ring
 * library Homebridge and Home Assistant's ring-mqtt also use. Everything else
 * in HomeHub talks to Ring through the small interfaces here, so tests can
 * replace Ring with a fake, and a change in the library touches this file only.
 *
 * The library is loaded only once someone signs in to Ring: it adds about
 * 60 MB of memory, which a HomeHub without Ring shouldn't pay.
 */

export type RingEventKind = 'ding' | 'motion';

export interface RingEvent {
  kind: RingEventKind;
  /** Ring's id for the event, the same when a notification arrives twice. */
  id: string;
  /** When it happened, in ms. */
  at: number;
  /** Ring's picture of the moment, when it has one. */
  snapshotUuid?: string;
  /** What Ring saw: 'human', 'vehicle', 'package', ... when it can tell. */
  detection?: string;
  /** End-to-end encryption is on for this camera, so no other app can see its pictures. */
  encrypted?: boolean;
}

export interface RingCam {
  id: number;
  name: string;
  /** Ring's model name, such as "Wired Doorbell Plus". */
  model: string;
  /** The home it's at, as named in the Ring app, for accounts with more than one. */
  home: string | null;
  isDoorbell: boolean;
  hasBattery: boolean;
  offline: boolean;
  /** A picture: Ring's of an event when `uuid` is given, a new one otherwise. */
  snapshot(uuid?: string): Promise<Buffer>;
  /** Calls `listener` for each doorbell press and motion. Returns a function that stops it. */
  onEvent(listener: (event: RingEvent) => void): () => void;
}

export interface RingSession {
  cameras(): Promise<RingCam[]>;
  disconnect(): void;
}

export type SignInResult =
  | { done: true; token: string }
  /** Ring sent a code; `prompt` says where, e.g. "sent to ***-***-1234 by text message". */
  | { done: false; prompt: string };

export interface PendingSignIn {
  /** Finishes a sign-in that needed a code. */
  submitCode(code: string): Promise<SignInResult>;
}

export interface RingConnector {
  /** Starts a sign-in. Ring usually asks for a code, so keep the returned object for submitCode. */
  signIn(email: string, password: string): Promise<{ result: SignInResult; pending: PendingSignIn }>;
  /** Connects with a saved token. Ring replaces the token now and then; `onToken` gets each new one, to save. */
  connect(token: string, onToken: (token: string) => void): RingSession;
}

/** Ring's sign-in said no, or the saved token no longer works. */
export class RingAuthError extends Error {}

/** The name HomeHub has in the Ring app, under Control Center → Authorized Client Devices. */
const CLIENT_NAME = 'HomeHub';

// ── The real thing ───────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
type Lib = any;
const loaded = new Map<string, Promise<Lib>>();

/**
 * ring-client-api is an ES module and HomeHub compiles to CommonJS, where
 * TypeScript would turn import() into require(). Function keeps it a real
 * import().
 */
function load(entry: 'ring-client-api' | 'ring-client-api/rest-client' = 'ring-client-api'): Promise<Lib> {
  let pending = loaded.get(entry);
  if (!pending) {
    pending = (new Function('m', 'return import(m)') as (m: string) => Promise<Lib>)(entry)
      .catch((err: Error) => { loaded.delete(entry); throw err; });
    loaded.set(entry, pending);
  }
  return pending;
}

/** Ring's error text, in words for people. */
function signInError(err: Error, client: Lib): Error {
  const text = err.message ?? '';
  if (/too many 2fa|too many requests/i.test(text)) {
    return new RingAuthError('Ring has sent too many codes. Wait 10 minutes, then try again.');
  }
  if (client?.promptFor2fa && /invalid|verification code/i.test(`${client.promptFor2fa} ${text}`)) {
    return new RingAuthError("That code didn't work. Check it and try again, or start over for a new code.");
  }
  if (/oauth token|email and password|refresh token/i.test(text)) {
    return new RingAuthError("Ring didn't accept that email and password.");
  }
  return new Error(`Couldn't reach Ring: ${text || 'no answer'}`);
}

async function attempt(client: Lib, code?: string): Promise<SignInResult> {
  try {
    const auth = await client.getAuth(code);
    return { done: true, token: auth.refresh_token as string };
  } catch (err) {
    // Ring asks for a code: the library notes that and what to say, then throws.
    if (client.using2fa && !code && client.promptFor2fa) {
      // "Please enter the code sent to ***-1234 via sms" → "sent to ***-1234 by text message"
      const prompt = String(client.promptFor2fa)
        .replace(/^Please enter the code\s*/i, '')
        .replace(/ via sms$/i, ' by text message')
        .replace(/ via email$/i, ' by email')
        .replace(/^sent to your text\/email$/i, 'sent to your phone or email');
      return { done: false, prompt: prompt || 'sent to your phone or email' };
    }
    throw signInError(err as Error, client);
  }
}

function toCam(camera: Lib, home: string | null = null): RingCam {
  const kindOf = (category: string): RingEventKind | null =>
    /\.ding$/.test(category) ? 'ding' : /\.motion$/.test(category) ? 'motion' : null;
  return {
    id: camera.id,
    name: camera.name,
    model: camera.model ?? 'Ring camera',
    home: home || null,
    isDoorbell: !!camera.isDoorbot,
    hasBattery: !!camera.hasBattery,
    offline: !!camera.isOffline,
    async snapshot(uuid?: string): Promise<Buffer> {
      return Buffer.from(await camera.getSnapshot(uuid ? { uuid } : undefined));
    },
    onEvent(listener) {
      const sub = camera.onNewNotification.subscribe((n: Lib) => {
        const kind = kindOf(String(n?.android_config?.category ?? ''));
        const ding = n?.data?.event?.ding;
        if (!kind || !ding?.id) return;
        const at = Date.parse(ding.created_at);
        listener({
          kind,
          id: String(ding.id),
          at: Number.isFinite(at) ? at : Date.now(),
          snapshotUuid: n?.img?.snapshot_uuid || undefined,
          detection: ding.detection_type || n?.data?.event?.eventito?.type || undefined,
          encrypted: n?.data?.device?.e2ee_enabled === true,
        });
      });
      return () => sub.unsubscribe();
    },
  };
}

export const ringLibrary: RingConnector = {
  async signIn(email, password) {
    const { RingRestClient } = await load('ring-client-api/rest-client');
    // One client for both steps: Ring ties the code to this client's hardware id.
    const client = new RingRestClient({ email, password, controlCenterDisplayName: CLIENT_NAME });
    const result = await attempt(client);
    return { result, pending: { submitCode: (code) => attempt(client, code) } };
  },

  connect(token, onToken) {
    let api: Lib = null;
    let closed = false;
    const ready = load().then(({ RingApi }) => {
      api = new RingApi({
        refreshToken: token,
        controlCenterDisplayName: CLIENT_NAME,
        // Pictures come when asked; don't wake battery cameras for HomeHub.
        avoidSnapshotBatteryDrain: true,
      });
      api.onRefreshTokenUpdated.subscribe(({ newRefreshToken }: { newRefreshToken: string }) => {
        if (!closed && newRefreshToken) onToken(newRefreshToken);
      });
      if (closed) api.disconnect();
      return api;
    });
    let cams: Promise<RingCam[]> | null = null;
    return {
      cameras() {
        // By home, so each camera knows which home it's at.
        cams ??= ready.then((a) => a.getLocations())
          .then((homes: Lib[]) => homes.flatMap((h) => (h.cameras ?? []).map((c: Lib) => toCam(c, h.name ?? null))))
          .catch((err: Error) => {
          cams = null;
          throw /oauth token|refresh token/i.test(err.message ?? '')
            ? new RingAuthError('Ring no longer accepts HomeHub\'s sign-in. Sign in to Ring again.')
            : err;
        });
        return cams;
      },
      disconnect() {
        closed = true;
        api?.disconnect();
      },
    };
  },
};

/** For tests of the parts that read the library's objects. */
export const libraryPartsForTests = { attempt, toCam };
