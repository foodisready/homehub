import dgram from 'dgram';
import fs from 'fs';
import os from 'os';

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

// ── Is the camera's address on one of HomeHub's networks? ───────

export interface LocalNetwork { address: string; netmask: string }

/** Docker's own networks on this computer, which no camera is on. */
const CONTAINER_IFACE = /^(docker|br-|veth|cni|flannel|virbr)/;

/** HomeHub's own IPv4 networks: Wi-Fi, Ethernet. */
export function localNetworks(ifaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): LocalNetwork[] {
  const nets: LocalNetwork[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (CONTAINER_IFACE.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) nets.push({ address: a.address, netmask: a.netmask });
    }
  }
  return nets;
}

const ipv4 = (ip: string): number | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
};

/** Whether `ip` is inside one of `nets`, or null when `ip` isn't an IPv4 address. */
export function inNetworks(ip: string | null, nets: LocalNetwork[]): boolean | null {
  const n = ip ? ipv4(ip) : null;
  if (n === null) return null;
  return nets.some((net) => {
    const a = ipv4(net.address);
    const m = ipv4(net.netmask);
    return a !== null && m !== null && (n & m) >>> 0 === (a & m) >>> 0;
  });
}

/**
 * Wyze cameras whose address isn't on any of HomeHub's networks, such as one
 * on a second Wi-Fi behind another router. The bridge reaches cameras
 * directly on the home network, so it can't get video from those, though
 * Wyze's cloud still sends their motion pictures.
 *
 * Only decided when at least one camera is on HomeHub's network: otherwise
 * HomeHub may be in a container that can't see the home network's addresses,
 * and every camera would look elsewhere.
 */
export function camerasElsewhere(ips: (string | null)[], nets: LocalNetwork[] = localNetworks()): Set<string> {
  const elsewhere = new Set<string>();
  if (!ips.some((ip) => inNetworks(ip, nets) === true)) return elsewhere;
  for (const ip of ips) if (ip && inNetworks(ip, nets) === false) elsewhere.add(ip);
  return elsewhere;
}

/** "192.0.2.x" for HomeHub's main network, to show beside a camera's address. */
export function networkLabel(nets: LocalNetwork[] = localNetworks()): string | null {
  const net = nets.find((n) => n.netmask === '255.255.255.0') ?? nets[0];
  if (!net) return null;
  return net.netmask === '255.255.255.0' ? net.address.replace(/\.\d+$/, '.x') : net.address;
}

/** What to tell someone whose camera is on another network from HomeHub. */
export function elsewhereHint(ip: string, nets: LocalNetwork[] = localNetworks()): string {
  const home = networkLabel(nets);
  return `This camera is on a different network (${ip}) from HomeHub${home ? ` (${home})` : ''}, so live video and pictures can't reach HomeHub. `
    + 'Motion pictures from Wyze still arrive. To fix it, set the camera up again in the Wyze app on the same Wi-Fi as HomeHub.';
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
