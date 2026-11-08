/**
 * The camera relay: go2rtc in its own container (camera-relay in
 * docker-compose.yml), listening on 127.0.0.1 only. It connects to an IP
 * camera's RTSP stream when someone watches, and serves it as HLS, which
 * HomeHub passes on to the browser with its own login. It also makes a
 * picture from the video for cameras without a snapshot address.
 *
 * The relay keeps nothing: HomeHub tells it each camera's stream before
 * using it, so a restarted relay simply learns them again.
 */

export const relayUrl = () => (process.env.CAMERA_RELAY_URL || 'http://127.0.0.1:1985').replace(/\/+$/, '');

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** For tests. */
export function setRelayFetchForTests(f: Fetch | null): void { fetchImpl = f ?? ((...args) => fetch(...args)); }

export class RelayError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

const UNREACHABLE = 'The camera relay isn\'t running. Update HomeHub, which adds it, or start the camera-relay service.';

async function call(path: string, init: RequestInit = {}, timeoutMs = 5_000): Promise<Response> {
  try {
    return await fetchImpl(relayUrl() + path, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') throw new RelayError('The camera relay didn\'t answer in time', 504);
    throw new RelayError(UNREACHABLE, 503);
  }
}

export type RelayState = { state: 'ready' } | { state: 'unreachable'; detail: string };

export async function relayState(): Promise<RelayState> {
  try {
    // go2rtc's info, not its stream list, which it reads without a lock: a list during a change can crash it.
    const res = await call('/api');
    return res.ok ? { state: 'ready' } : { state: 'unreachable', detail: `The camera relay answered HTTP ${res.status}` };
  } catch (err) {
    return { state: 'unreachable', detail: (err as Error).message };
  }
}

/** Each stream's source as HomeHub last gave it, so it's only sent again when it changes or the relay forgot it. */
const given = new Map<string, string>();

/**
 * Changes to the relay's streams, and the stream list, go one at a time:
 * go2rtc crashes ("concurrent map writes") when they overlap, as when a
 * thumbnail and live video start at once, or a camera's two streams are
 * removed. If it does crash, Docker starts it again and HomeHub tells it the
 * streams again.
 */
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

/** Makes sure the relay has stream `name` playing `src`. */
export function ensureStream(name: string, src: string): Promise<void> {
  return oneAtATime(() => putIfNeeded(name, src));
}

async function putIfNeeded(name: string, src: string): Promise<void> {
  const res = await call('/api/streams');
  if (!res.ok) throw new RelayError(`The camera relay answered HTTP ${res.status}`);
  const streams = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (streams && name in streams && given.get(name) === src) return;
  const put = await call(`/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`, { method: 'PUT' });
  if (!put.ok) throw new RelayError(`The camera relay didn't take the stream (HTTP ${put.status})`);
  given.set(name, src);
}

export function removeStream(name: string): Promise<void> {
  given.delete(name);
  return oneAtATime(async () => {
    try {
      await call(`/api/streams?src=${encodeURIComponent(name)}`, { method: 'DELETE' });
    } catch { /* the relay is gone, and the stream with it */ }
  });
}

/** For tests. */
export function resetRelayState(): void { given.clear(); }

/**
 * Live video, for relaying. `index.m3u8` starts a session for the stream;
 * the playlist and segments that follow name the session, under `hls/`.
 */
export function hlsFetch(name: string, file: string, query: string, signal?: AbortSignal): Promise<Response> {
  const target = file === 'index.m3u8' ? `/api/stream.m3u8?src=${encodeURIComponent(name)}` : `/api/${file}${query}`;
  return call(target, { signal }, 30_000);
}

/** A JPEG made from the video now. Slower than a camera's own snapshot: the relay connects first. */
export async function frame(name: string): Promise<Buffer> {
  const res = await call(`/api/frame.jpeg?src=${encodeURIComponent(name)}`, {}, 20_000);
  const type = res.headers.get('content-type') ?? '';
  const body = Buffer.from(await res.arrayBuffer());
  if (!res.ok || !type.startsWith('image/') || body.length === 0) throw new RelayError('No picture from the camera\'s video');
  return body;
}
