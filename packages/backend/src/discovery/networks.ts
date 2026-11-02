import net from 'net';
import os from 'os';
import { getDb } from '../db';
import { logger } from '../logger';

/**
 * Which networks Discover searches: HomeHub's own, plus any the user adds in
 * Settings for devices on another Wi-Fi network, such as a garage access point
 * that runs its own router upstream of HomeHub's.
 *
 * Networks are /24s, stored as prefixes like "192.168.1", so a search is at
 * most 254 addresses each.
 */

const SETTING = 'discovery_networks';
export const MAX_EXTRA_NETWORKS = 4;

/** Common home router ranges, offered as suggestions. */
const COMMON = ['192.168.0', '192.168.1', '10.0.0', '10.0.1', '192.168.2'];

const isOctet = (s: string) => /^\d{1,3}$/.test(s) && Number(s) <= 255;

function isPrivate(prefix: string): boolean {
  const [a, b] = prefix.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Reads "192.168.1.x", "192.168.1.*", "192.168.1.0/24", "192.168.1" or
 * "192.168.1.50" as the prefix "192.168.1". Returns null for anything else,
 * including public addresses and ranges wider than a /24.
 */
export function parseNetwork(input: string): string | null {
  const text = input.trim().toLowerCase();
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\.(x|\*|\d{1,3})(?:\/(\d{1,2}))?)?$/.exec(text);
  if (!m) return null;
  const [, a, b, c, d, bits] = m;
  if (![a, b, c].every(isOctet)) return null;
  if (d && d !== 'x' && d !== '*' && !isOctet(d)) return null;
  if (bits !== undefined && bits !== '24') return null;
  const prefix = `${Number(a)}.${Number(b)}.${Number(c)}`;
  return isPrivate(prefix) ? prefix : null;
}

/** Docker's own networks and VPNs such as Tailscale have no smart devices on them. */
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|tailscale|utun|tun|wg|zt)/i;

/** /24 prefixes of HomeHub's own home-network interfaces, e.g. ["192.168.0"]. */
export function ownNetworks(): string[] {
  const prefixes = new Set<string>();
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const p = addr.address.split('.');
      const prefix = `${p[0]}.${p[1]}.${p[2]}`;
      if (isPrivate(prefix)) prefixes.add(prefix);
    }
  }
  return [...prefixes];
}

export function extraNetworks(): string[] {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(SETTING) as { value: string } | undefined;
    const list = row ? JSON.parse(row.value) : [];
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string' && parseNetwork(p) === p) : [];
  } catch (err) {
    logger.warn({ err }, 'Could not read the extra discovery networks');
    return [];
  }
}

/** Saves the extra networks, dropping duplicates and HomeHub's own. Throws on an invalid entry. */
export function saveExtraNetworks(inputs: string[]): string[] {
  const own = new Set(ownNetworks());
  const prefixes: string[] = [];
  for (const input of inputs) {
    if (!input.trim()) continue;
    const prefix = parseNetwork(input);
    if (!prefix) throw new Error(`"${input}" isn't a home network address. Use a form like 192.168.1.x.`);
    if (!own.has(prefix) && !prefixes.includes(prefix)) prefixes.push(prefix);
  }
  if (prefixes.length > MAX_EXTRA_NETWORKS) throw new Error(`Add up to ${MAX_EXTRA_NETWORKS} other networks.`);
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(SETTING, JSON.stringify(prefixes));
  return prefixes;
}

/** Everything Discover searches: HomeHub's own networks first, then the extra ones. */
export function searchNetworks(): string[] {
  return [...new Set([...ownNetworks(), ...extraNetworks()])];
}

export function suggestedNetworks(): string[] {
  const taken = new Set(searchNetworks());
  return COMMON.filter((p) => !taken.has(p));
}

export function hostsOf(prefix: string): string[] {
  return Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
}

export function isPortOpen(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port });
    const done = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Shows prefixes the way people write them: "192.168.1.x". */
export const displayNetwork = (prefix: string) => `${prefix}.x`;
