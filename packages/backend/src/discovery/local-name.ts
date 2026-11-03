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
 * question came from. It shares port 5353 with any other mDNS service on the
 * computer, such as Avahi.
 *
 * The name comes from HOMEHUB_LOCAL_NAME, which docker-compose.yml sets to
 * `homehub`. Unset (as in development) or `off`, nothing answers, so a
 * development copy never competes with the real HomeHub.
 */

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const TYPE_A = 1;
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

/** An answer with one A record. `legacy` replies echo the id and question, as plain DNS does. */
export function buildAnswer(name: string, address: string, opts: { id?: number; legacy?: boolean } = {}): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(opts.legacy ? opts.id ?? 0 : 0, 0);
  header.writeUInt16BE(0x8400, 2);            // response, authoritative
  header.writeUInt16BE(opts.legacy ? 1 : 0, 4);
  header.writeUInt16BE(1, 6);
  const encoded = encodeName(name);
  const question = opts.legacy ? Buffer.concat([encoded, Buffer.from([0, TYPE_A, 0, 1])]) : Buffer.alloc(0);
  const rr = Buffer.alloc(10);
  rr.writeUInt16BE(TYPE_A, 0);
  rr.writeUInt16BE(opts.legacy ? 0x0001 : 0x8001, 2);   // IN, with cache-flush for mDNS
  rr.writeUInt32BE(TTL, 4);
  rr.writeUInt16BE(4, 8);
  const ip = Buffer.from(address.split('.').map(Number));
  return Buffer.concat([header, question, encoded, rr, ip]);
}

/** What to send back for one incoming packet, if anything. */
export function respond(
  buf: Buffer, from: { address: string; port: number }, hostname: string, addrs: LocalAddress[],
): { message: Buffer; to: { address: string; port: number }; via: string } | null {
  const q = parseQuery(buf);
  if (!q) return null;
  const asked = q.questions.find((x) => x.name.toLowerCase() === hostname && (x.type === TYPE_A || x.type === TYPE_ANY));
  if (!asked) return null;
  const address = addressFor(from.address, addrs);
  if (!address) return null;
  // A query from a port other than 5353 is a plain DNS lookup and wants a direct reply.
  const legacy = from.port !== MDNS_PORT;
  const message = buildAnswer(hostname, address, { id: q.id, legacy });
  const to = legacy || asked.unicast ? from : { address: MDNS_ADDR, port: MDNS_PORT };
  return { message, to, via: address };
}

// ── Responder ──────────────────────────────────────────────────────

export function localName(): string | null {
  const configured = (process.env.HOMEHUB_LOCAL_NAME ?? '').trim().toLowerCase().replace(/\.local$/, '');
  if (!configured || configured === 'off') return null;
  if (/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(configured)) return configured;
  logger.warn(`HOMEHUB_LOCAL_NAME "${configured}" isn't a valid name; not answering for a .local name`);
  return null;
}

export function startLocalName(): void {
  const name = localName();
  if (!name) return;
  const hostname = `${name}.local`;
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('error', (err) => {
    logger.warn({ err }, `Can't answer for ${hostname}; open HomeHub by its IP address instead`);
    socket.close();
  });

  socket.on('message', (buf, rinfo) => {
    const reply = respond(buf, rinfo, hostname, homeAddresses());
    if (!reply) return;
    try { socket.setMulticastInterface(reply.via); } catch { /* use the default */ }
    socket.send(reply.message, reply.to.port, reply.to.address);
  });

  const joined = new Set<string>();
  /** Listen on each home network, including ones that appear later (Wi-Fi reconnecting). */
  const join = (): void => {
    for (const a of homeAddresses()) {
      if (joined.has(a.address)) continue;
      try {
        socket.addMembership(MDNS_ADDR, a.address);
        joined.add(a.address);
        // Announce, so devices that looked before HomeHub started find it now.
        socket.setMulticastInterface(a.address);
        socket.send(buildAnswer(hostname, a.address), MDNS_PORT, MDNS_ADDR);
        logger.info({ address: a.address }, `Answering for ${hostname}`);
      } catch (err) {
        logger.debug({ err, address: a.address }, 'mDNS: could not join on this interface');
      }
    }
  };

  socket.bind(MDNS_PORT, () => {
    socket.setMulticastTTL(255);
    join();
    setInterval(join, 60_000).unref();
  });
}
