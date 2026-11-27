/**
 * Talking through a camera: the browser's microphone, sent to the camera's speaker.
 *
 * Wyze cameras (the camera bridge) and IP cameras (the camera relay) both go through a
 * go2rtc. The browser makes a WebRTC offer with its microphone, and an audio track it
 * receives (which go2rtc needs to treat it as a viewer rather than a new camera); HomeHub
 * passes the offer to go2rtc and the answer back. The sound then goes from the browser to
 * go2rtc directly, on the home network or Tailscale, and go2rtc plays it on the camera.
 * Ring cameras talk on their live video connection instead (ring/ring.ts).
 */

export class TalkError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

/** A WebRTC offer is a few KB; anything far bigger isn't one. */
const MAX_OFFER = 20_000;
/** go2rtc connects to the camera first, which takes a few seconds for a Wyze camera. */
const CONNECT_MS = 20_000;

export const NO_SPEAKER = 'This camera has no speaker HomeHub can use.';

export function checkOffer(offer: unknown): string {
  if (typeof offer !== 'string' || !offer.startsWith('v=0') || offer.length > MAX_OFFER || !/\nm=audio /.test(offer)) {
    throw new TalkError('offer: a WebRTC offer with audio', 400);
  }
  return offer;
}

type Fetch = typeof fetch;

/** go2rtc's medias for a stream's camera, such as "audio, sendonly, PCML/8000/1": sendonly audio is its speaker. */
export function hasSpeaker(info: unknown): boolean {
  const producers = (info as { producers?: { medias?: unknown }[] } | null)?.producers;
  if (!Array.isArray(producers)) return false;
  return producers.some((p) => Array.isArray(p.medias) && p.medias.some((m) => typeof m === 'string' && /^audio, sendonly\b/.test(m)));
}

/**
 * Passes `offer` to the go2rtc at `base` for `stream`, and returns its answer.
 * `streamInfo` reads the stream's state afterwards, to check the camera has a speaker.
 */
export async function talkVia(
  base: string,
  stream: string,
  offer: string,
  opts: { fetch?: Fetch; streamInfo?: () => Promise<unknown> } = {},
): Promise<string> {
  const f = opts.fetch ?? ((...args) => fetch(...args));
  let res: Response;
  try {
    res = await f(`${base}/api/webrtc?src=${encodeURIComponent(stream)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'offer', sdp: offer }),
      signal: AbortSignal.timeout(CONNECT_MS),
    });
  } catch (err) {
    throw new TalkError((err as Error).name === 'TimeoutError' ? 'The camera didn\'t answer in time.' : 'The camera service isn\'t running.', 503);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).trim();
    throw new TalkError(/connect|timeout|dial/i.test(text) ? 'HomeHub couldn\'t reach the camera.' : 'The camera didn\'t start talking.', 502);
  }
  const answer = ((await res.json().catch(() => null)) as { sdp?: unknown } | null)?.sdp;
  if (typeof answer !== 'string' || !answer.startsWith('v=0')) throw new TalkError('The camera didn\'t start talking.', 502);

  const read = opts.streamInfo ?? (async () => {
    const r = await f(`${base}/api/streams?src=${encodeURIComponent(stream)}`, { signal: AbortSignal.timeout(5_000) });
    return r.ok ? r.json() : null;
  });
  const info = await read().catch(() => null);
  // A camera without one still answers: the browser closes the connection on this error.
  if (!hasSpeaker(info)) throw new TalkError(NO_SPEAKER, 409);
  return answer;
}
