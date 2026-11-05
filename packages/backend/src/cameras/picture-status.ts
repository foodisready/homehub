import dgram from 'dgram';
import fs from 'fs';

/**
 * Whether each camera is actually sending pictures. The camera bridge reports
 * every camera as streaming whether or not video arrives, so HomeHub judges by
 * results: every picture it asks the bridge for (thumbnails, snapshots, motion
 * snapshots, and a check now and then) counts as a success or a failure.
 *
 * One failure isn't enough to call a camera broken: the first request after
 * a quiet spell often comes back empty while the bridge connects.
 */

/** Failures in a row before a camera counts as sending no picture. */
const FAILURES_TO_FAIL = 2;
/** A result older than this says nothing about now. */
const STALE_MS = 15 * 60_000;

interface Record { okAt: number | null; failAt: number | null; failures: number; failingSince: number | null }
const records = new Map<string, Record>();

export type PictureState = 'ok' | 'failing' | 'unknown';

/** Notes the result of asking the bridge for a picture from `cam` (its bridge name). */
export function notePicture(cam: string, ok: boolean, now = Date.now()): void {
  const r = records.get(cam) ?? { okAt: null, failAt: null, failures: 0, failingSince: null };
  if (ok) {
    r.okAt = now;
    r.failures = 0;
    r.failingSince = null;
  } else {
    r.failAt = now;
    r.failures++;
    if (r.failures === FAILURES_TO_FAIL) r.failingSince = now;
  }
  records.set(cam, r);
}

export interface PictureHealth {
  state: PictureState;
  /** The last good picture, ms, or null. */
  lastOkAt: number | null;
  /** When the camera started failing, ms, or null. */
  failingSince: number | null;
}

export function pictureHealth(cam: string, now = Date.now()): PictureHealth {
  const r = records.get(cam);
  if (!r) return { state: 'unknown', lastOkAt: null, failingSince: null };
  const latest = Math.max(r.okAt ?? 0, r.failAt ?? 0);
  // One failure after good pictures is a hiccup, not a broken camera.
  const state: PictureState = now - latest > STALE_MS ? 'unknown' : r.failures >= FAILURES_TO_FAIL ? 'failing' : r.okAt !== null ? 'ok' : 'unknown';
  return { state, lastOkAt: r.okAt, failingSince: state === 'failing' ? r.failingSince : null };
}

/** When a picture of `cam` was last asked for, ms, or null. */
export function lastAsked(cam: string): number | null {
  const r = records.get(cam);
  if (!r) return null;
  return Math.max(r.okAt ?? 0, r.failAt ?? 0) || null;
}

/** For tests. */
export function resetPictureStatus(): void {
  records.clear();
  hints.clear();
}

// ── Is the camera on HomeHub's network at all? ──────────────────

/** The kernel's address table: hardware address → network address, for this computer's own networks. */
function arpTable(file = process.env.HOMEHUB_ARP_FILE || '/proc/net/arp'): Map<string, string> | null {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const table = new Map<string, string>();
  for (const line of text.split('\n').slice(1)) {
    const [ip, , flags, hw] = line.trim().split(/\s+/);
    // 0x2: a complete entry. Incomplete ones have no hardware address yet.
    if (!ip || !hw || !(Number(flags) & 0x2)) continue;
    table.set(hw.replace(/[^0-9a-f]/gi, '').toUpperCase(), ip);
  }
  return table;
}

/** Sends one harmless packet to `ip` (the discard port), so the computer looks up who has that address. */
function nudge(ip: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const done = () => { try { socket.close(); } catch { /* closed */ } resolve(); };
    socket.on('error', done);
    socket.send(Buffer.alloc(1), 9, ip, () => setTimeout(done, 1500));
  });
}

/**
 * Whether a device with this hardware address answers on HomeHub's own
 * network, or null when that can't be told (not Linux, or no address table).
 * A camera on another Wi-Fi, or one whose address another device has taken,
 * isn't there.
 */
export async function onLocalNetwork(mac: string, ip: string | null): Promise<boolean | null> {
  const want = mac.replace(/[^0-9a-f]/gi, '').toUpperCase();
  const before = arpTable();
  if (before === null) return null;
  if (before.has(want)) return true;
  if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) await nudge(ip);
  return arpTable()?.has(want) ?? null;
}

const HINT_MS = 2 * 60_000;
const hints = new Map<string, { at: number; text: string }>();

/** What to tell someone whose camera sends no picture. Looked up at most every two minutes per camera. */
export async function noPictureHint(cam: string, mac: string | null, ip: string | null, now = Date.now()): Promise<string> {
  const cached = hints.get(cam);
  if (cached && now - cached.at < HINT_MS) return cached.text;
  const present = mac ? await onLocalNetwork(mac, ip) : null;
  const text = present === false
    ? 'HomeHub can\'t find this camera on its network. It may have joined another Wi-Fi, or another device may be using its address.'
    : present === true
      ? 'The camera is on the network but isn\'t sending video. Try unplugging it for 10 seconds.'
      : 'Check that the camera is on, and on the same Wi-Fi as HomeHub.';
  hints.set(cam, { at: now, text });
  return text;
}
