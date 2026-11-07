import dgram from 'dgram';
import os from 'os';
import { logger } from '../logger';

/**
 * Answers for homehub.local on the home network (multicast DNS), so people
 * can open http://homehub.local:4200 instead of looking up the Pi's address.
 * Phones and computers with Bonjour or mDNS (iPhone, Mac, Windows 10+, most
 * Linux) find it; the IP address keeps working everywhere.
 *
 * Only the backend runs on the host's network, so it does this. It answers
 * A (IPv4) questions for its own name, with the address on the network the
 * question came from, and tells AAAA (IPv6) askers there's no IPv6 address.
 * It shares port 5353 with any other mDNS service on the computer, such as
 * Avahi.
 *
 * The name comes from HOMEHUB_LOCAL_NAME, which docker-compose.yml sets to
 * `homehub`. Unset (as in development) or `off`, nothing answers, so a
 * development copy never competes with the real HomeHub.
 */

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const TYPE_A = 1;
const TYPE_AAAA = 28;
const TYPE_NSEC = 47;
const TYPE_ANY = 255;
const TTL = 120;

/** Interfaces that aren't the home network: Docker, VPNs, loopback. */
const NOT_HOME = /^(lo|docker|br-|veth|virbr|cni|flannel|tailscale|tun|tap|wg|zt|utun|awdl|llw)/;

export interface LocalAddress { address: string; netmask: string }

export function homeAddresses(ifaces = os.networkInterfaces()): LocalAddress[] {
  const out: LocalAddress[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (NOT_HOME.test(name)) continue;
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (inSubnet(a.address, '100.64.0.0', '255.192.0.0')) continue;   // Tailscale's range
      if (a.address.startsWith('169.254.')) continue;                     // no DHCP answer
      out.push({ address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

const toInt = (ip: string) => ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
const inSubnet = (ip: string, net: string, mask: string) =>
  ((toInt(ip) & toInt(mask)) >>> 0) === ((toInt(net) & toInt(mask)) >>> 0);

/** The local address on the same network as `from`, or the first one. */
export function addressFor(from: string, addrs: LocalAddress[]): string | undefined {
  return addrs.find((a) => inSubnet(from, a.address, a.netmask))?.address ?? addrs[0]?.address;
}

// ── DNS messages ───────────────────────────────────────────────────

interface Question { name: string; type: number; unicast: boolean; end: number }

function readName(buf: Buffer, offset: number): { name: string; end: number } {
  const labels: string[] = [];
  let pos = offset, end = -1;
  for (let jumps = 0; jumps < 20; jumps++) {
    if (pos >= buf.length) throw new Error('name runs past the message');
    const len = buf[pos];
    if (len === 0) { if (end < 0) end = pos + 1; return { name: labels.join('.'), end }; }
    if ((len & 0xc0) === 0xc0) {            // compression pointer
      if (end < 0) end = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  throw new Error('too many name pointers');
}

export function parseQuery(buf: Buffer): { id: number; questions: Question[] } | null {
  if (buf.length < 12) return null;
  const flags = buf.readUInt16BE(2);
  if (flags & 0x8000) return null;           // a response, not a question
  const count = buf.readUInt16BE(4);
  const questions: Question[] = [];
  let pos = 12;
  try {
    for (let i = 0; i < count; i++) {
      const { name, end } = readName(buf, pos);
      if (end + 4 > buf.length) return null;
      const type = buf.readUInt16BE(end);
      const cls = buf.readUInt16BE(end + 2);
      questions.push({ name, type, unicast: (cls & 0x8000) !== 0, end: end + 4 });
      pos = end + 4;
    }
  } catch {
    return null;
  }
  return { id: buf.readUInt16BE(0), questions };
}

function encodeName(name: string): Buffer {
  const parts = name.split('.').map((l) => {
    const b = Buffer.from(l, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

function record(name: Buffer, type: number, cls: number, rdata: Buffer): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(cls, 2);
  head.writeUInt32BE(TTL, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([name, head, rdata]);
}

/**
 * A reply about `name`. For an A question (the default), the answer is the
 * address. For any other question, such as AAAA (IPv6), the answer is an
 * NSEC record saying the name has only an IPv4 address, so the asker doesn't
 * wait seconds for an IPv6 reply that never comes (RFC 6762 §6.1). Either
 * way the other record goes along as additional information.
 * `legacy` replies echo the id and question, as plain DNS does.
 */
export function buildAnswer(
  name: string, address: string, opts: { id?: number; legacy?: boolean; type?: number } = {},
): Buffer {
  const type = opts.type ?? TYPE_A;
  const encoded = encodeName(name);
  const cls = opts.legacy ? 0x0001 : 0x8001;   // IN, with cache-flush for mDNS
  const a = record(encoded, TYPE_A, cls, Buffer.from(address.split('.').map(Number)));
  // NSEC: next name is this name; bitmap window 0 lists only type A (bit 1).
  const nsec = record(encoded, TYPE_NSEC, cls, Buffer.concat([encoded, Buffer.from([0, 1, 0x40])]));
  const positive = type === TYPE_A || type === TYPE_ANY;

  const header = Buffer.alloc(12);
  header.writeUInt16BE(opts.legacy ? opts.id ?? 0 : 0, 0);
  header.writeUInt16BE(0x8400, 2);            // response, authoritative
  header.writeUInt16BE(opts.legacy ? 1 : 0, 4);
  header.writeUInt16BE(1, 6);                 // one answer
  header.writeUInt16BE(1, 10);                // one additional record
  const question = opts.legacy ? Buffer.concat([encoded, Buffer.from([type >> 8, type & 0xff, 0, 1])]) : Buffer.alloc(0);
  return Buffer.concat([header, question, positive ? a : nsec, positive ? nsec : a]);
}

/** What to send back for one incoming packet, if anything. */
export function respond(
  buf: Buffer, from: { address: string; port: number }, hostname: string, addrs: LocalAddress[],
): { message: Buffer; to: { address: string; port: number }; via: string } | null {
  const q = parseQuery(buf);
  if (!q) return null;
  const ours = q.questions.filter((x) => x.name.toLowerCase() === hostname);
  // Answer the address question first; AAAA (and others) get "IPv4 only".
  const asked = ours.find((x) => x.type === TYPE_A || x.type === TYPE_ANY) ?? ours.find((x) => x.type === TYPE_AAAA);
  if (!asked) return null;
  const address = addressFor(from.address, addrs);
  if (!address) return null;
  // A query from a port other than 5353 is a plain DNS lookup and wants a direct reply.
  const legacy = from.port !== MDNS_PORT;
  const message = buildAnswer(hostname, address, { id: q.id, legacy, type: asked.type });
  const to = legacy || asked.unicast ? from : { address: MDNS_ADDR, port: MDNS_PORT };
  return { message, to, via: address };
}

/** The IPv4 addresses (A records) a response gives, from every section. Goodbyes (TTL 0) are left out. */
export function parseResponse(buf: Buffer): { name: string; address: string }[] {
  if (buf.length < 12 || !(buf.readUInt16BE(2) & 0x8000)) return [];
  const qd = buf.readUInt16BE(4);
  const records = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  const out: { name: string; address: string }[] = [];
  let pos = 12;
  try {
    for (let i = 0; i < qd; i++) pos = readName(buf, pos).end + 4;
    for (let i = 0; i < records; i++) {
      const { name, end } = readName(buf, pos);
      if (end + 10 > buf.length) break;
      const type = buf.readUInt16BE(end);
      const ttl = buf.readUInt32BE(end + 4);
      const len = buf.readUInt16BE(end + 8);
      const data = end + 10;
      if (data + len > buf.length) break;
      if (type === TYPE_A && len === 4 && ttl > 0) out.push({ name: name.toLowerCase(), address: [...buf.subarray(data, data + 4)].join('.') });
      pos = data + len;
    }
  } catch { /* keep what was read */ }
  return out;
}

/** A plain mDNS question for `name`'s IPv4 address. */
export function buildQuery(name: string): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4);                 // one question
  return Buffer.concat([header, encodeName(name), Buffer.from([0, TYPE_A, 0, 1])]);
}

// ── Responder ──────────────────────────────────────────────────────

/** HOMEHUB_LOCAL_NAME, the name the active HomeHub answers to. */
export function localName(): string | null {
  const configured = (process.env.HOMEHUB_LOCAL_NAME ?? '').trim().toLowerCase().replace(/\.local$/, '');
  if (!configured || configured === 'off') return null;
  if (/^[a-z0-9]([a-z0-9-]{0,52}[a-z0-9])?$/.test(configured)) return configured;
  logger.warn(`HOMEHUB_LOCAL_NAME "${configured}" isn't a valid name; not answering for a .local name`);
  return null;
}

/**
 * The name this HomeHub answers to: the configured one when it's the active
 * server, and `<name>-backup` or `<name>-dev` otherwise, so only one computer
 * ever answers for homehub.local.
 */
export function nameForRole(base: string, role: string): string {
  return role === 'active' ? base : `${base}-${role}`;
}

let role = 'active';
let reannounce: (() => void) | null = null;
/** Another computer answering for the main name: the active HomeHub, or a second one. */
let other: { address: string; at: number } | null = null;
const OTHER_FRESH_MS = 3 * 60 * 1000;

/** Called when this server's role changes: answer to the new name straight away. */
export function setLocalNameRole(r: string): void {
  if (r === role) return;
  role = r;
  other = null;
  reannounce?.();
}

/**
 * Another computer seen answering for the main .local name in the last few
 * minutes. On a backup server that's the active HomeHub; on the active one it
 * means a second HomeHub thinks it's active too.
 */
export function otherAnswering(now = Date.now()): { address: string; at: number } | null {
  return other && now - other.at < OTHER_FRESH_MS ? other : null;
}

/** Note answers for the main name from addresses that aren't this computer's. For tests too. */
export function noticeOthers(buf: Buffer, mainHostname: string, ours: LocalAddress[], now = Date.now()): void {
  for (const r of parseResponse(buf)) {
    if (r.name !== mainHostname || ours.some((a) => a.address === r.address)) continue;
    if (other?.address !== r.address) logger.info({ address: r.address, role }, `Another computer answers for ${mainHostname}`);
    other = { address: r.address, at: now };
  }
}

export function startLocalName(): void {
  const name = localName();
  if (!name) return;
  const main = `${name}.local`;
  const hostname = () => `${nameForRole(name, role)}.local`;
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('error', (err) => {
    logger.warn({ err }, `Can't answer for ${hostname()}; open HomeHub by its IP address instead`);
    socket.close();
  });

  socket.on('message', (buf, rinfo) => {
    const addrs = homeAddresses();
    noticeOthers(buf, main, addrs);
    const reply = respond(buf, rinfo, hostname(), addrs);
    if (!reply) return;
    try { socket.setMulticastInterface(reply.via); } catch { /* use the default */ }
    socket.send(reply.message, reply.to.port, reply.to.address);
  });

  const joined = new Set<string>();
  /** Say which name this computer answers to, so devices that looked earlier find it now. */
  const announce = (address: string): void => {
    socket.setMulticastInterface(address);
    socket.send(buildAnswer(hostname(), address), MDNS_PORT, MDNS_ADDR);
  };
  /** Listen on each home network, including ones that appear later (Wi-Fi reconnecting). */
  const join = (): void => {
    for (const a of homeAddresses()) {
      if (joined.has(a.address)) continue;
      try {
        socket.addMembership(MDNS_ADDR, a.address);
        joined.add(a.address);
        announce(a.address);
        logger.info({ address: a.address }, `Answering for ${hostname()}`);
      } catch (err) {
        logger.debug({ err, address: a.address }, 'mDNS: could not join on this interface');
      }
    }
  };
  /** Ask who answers for the main name; answers arrive as messages above. */
  const ask = (): void => {
    for (const address of joined) {
      try {
        socket.setMulticastInterface(address);
        socket.send(buildQuery(main), MDNS_PORT, MDNS_ADDR);
      } catch { /* try again next time */ }
    }
  };
  reannounce = () => {
    for (const address of joined) {
      try { announce(address); } catch { /* next time */ }
    }
    logger.info(`Answering for ${hostname()}`);
  };

  socket.bind(MDNS_PORT, () => {
    socket.setMulticastTTL(255);
    join();
    ask();
    setInterval(() => { join(); ask(); }, 60_000).unref();
  });
}
