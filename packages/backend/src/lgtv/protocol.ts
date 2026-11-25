/**
 * LG webOS TVs, on the home network. A TV takes commands over a WebSocket (wss on port 3001 since
 * 2018, plain ws on port 3000 before), once it has let HomeHub in: the first time, it asks on the
 * screen, someone presses OK on the remote, and the TV hands back a key that's used from then on.
 * A TV that's off doesn't listen at all, so it's turned on with Wake-on-LAN, which needs "Turn on
 * via Wi-Fi" (or "Mobile TV On"; "Wake on LAN" on 2025 models) on in the TV's settings.
 *
 * pairing.json is the manifest LG's own remote app presents, as published with lgtv2 (MIT,
 * Sebastian Raff): the permissions it asks for are what the TV shows and grants.
 */
import dgram from 'node:dgram';
import WebSocket from 'ws';
import pairingTemplate from './pairing.json';
import { logger } from '../logger';

export type TvFailure = 'UNREACHABLE' | 'NOT_PAIRED' | 'DENIED' | 'TIMEOUT' | 'FAILED';

export class TvError extends Error {
  constructor(message: string, readonly code: TvFailure) { super(message); }
}

export interface TvPort { port: number; secure: boolean }
/** Newer TVs only answer the secure port; older ones only the plain one. */
export const TV_PORTS: TvPort[] = [{ port: 3001, secure: true }, { port: 3000, secure: false }];

/** For tests: where TVs are reached and woken, instead of the real ports. */
let ports = TV_PORTS;
let wakeTargets: ((ip: string) => { address: string; port: number }[]) | null = null;
export function setPortsForTests(p: TvPort[]): void { ports = p; }
export function setWakeTargetsForTests(fn: typeof wakeTargets): void { wakeTargets = fn; }

/** The port that worked last time for each TV, tried first. */
const lastPort = new Map<string, TvPort>();

const CONNECT_MS = 2500;
/** How long a TV that knows HomeHub takes to let it in. */
const REGISTER_MS = 5000;
const REQUEST_MS = 5000;
/** Keep-alive: a TV switched off at the wall vanishes without closing the connection. */
const PING_MS = 10_000;

function pairing(signed: boolean): Record<string, unknown> {
  const p = JSON.parse(JSON.stringify(pairingTemplate));
  if (!signed) {
    // Some firmware refuses the signed manifest ("blacklisted certificate"); unsigned, it still asks on screen.
    delete p.manifest.signed;
    delete p.manifest.signatures;
    p.manifest.appVersion = '1.0';
  }
  return p;
}

interface Pending { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export interface OpenOptions {
  /** The key the TV gave HomeHub, or null to ask for one. */
  key: string | null;
  /** Pairing: the TV is asking on its screen, so wait this long for OK. Otherwise a TV that asks is "not paired". */
  pairForMs?: number;
  /** Runs when the TV shows its question. */
  onPrompt?: () => void;
}

/** One open connection to a TV, let in with its key. */
export class TvConnection {
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly closeListeners: (() => void)[] = [];
  private pinger: NodeJS.Timeout | null = null;
  private alive = true;
  closed = false;

  private constructor(private readonly ws: WebSocket, readonly ip: string, readonly port: TvPort) {
    ws.on('message', (raw) => this.onMessage(String(raw)));
    ws.on('close', () => this.shut(new TvError('The TV closed the connection', 'UNREACHABLE')));
    ws.on('error', (err) => this.shut(new TvError(err.message, 'UNREACHABLE')));
    ws.on('pong', () => { this.alive = true; });
    this.pinger = setInterval(() => {
      if (!this.alive) { this.close(); return; }
      this.alive = false;
      try { ws.ping(); } catch { this.close(); }
    }, PING_MS);
    this.pinger.unref();
  }

  /** Connects and is let in, or says why not. The key comes back new after pairing. */
  static async open(ip: string, options: OpenOptions): Promise<{ connection: TvConnection; key: string }> {
    const known = lastPort.get(ip);
    const order = known ? [known, ...ports.filter((p) => p.port !== known.port)] : ports;
    let lastError: Error = new TvError(`Nothing answered at ${ip}`, 'UNREACHABLE');
    for (const port of order) {
      let ws: WebSocket;
      try {
        ws = await connectSocket(ip, port);
      } catch (err) {
        lastError = err as Error;
        continue;
      }
      lastPort.set(ip, port);
      const connection = new TvConnection(ws, ip, port);
      try {
        const key = await connection.register(options);
        return { connection, key };
      } catch (err) {
        connection.close();
        throw err;
      }
    }
    throw lastError instanceof TvError ? lastError : new TvError(lastError.message, 'UNREACHABLE');
  }

  onClose(listener: () => void): void { this.closeListeners.push(listener); }

  private async register(options: OpenOptions): Promise<string> {
    const attempt = (signed: boolean) => new Promise<string>((resolve, reject) => {
      const id = 'register_0';
      const pairingMs = options.pairForMs ?? 0;
      let timer = setTimeout(() => fail(new TvError('The TV didn’t let HomeHub in', 'TIMEOUT')), REGISTER_MS);
      const fail = (err: Error) => { clearTimeout(timer); this.pending.delete(id); reject(err); };
      this.pending.set(id, {
        timer,
        reject: fail,
        resolve: (message) => {
          const payload = (message.payload ?? {}) as Record<string, unknown>;
          if (message.type === 'registered' && typeof payload['client-key'] === 'string' && payload['client-key']) {
            clearTimeout(timer); this.pending.delete(id); resolve(payload['client-key']);
            return;
          }
          if (message.type === 'error') {
            const text = String(message.error ?? 'refused');
            if (signed && /blacklisted certificate/i.test(text)) { fail(new TvError(text, 'FAILED')); return; }
            fail(/cancel|reject|denied|403/i.test(text) && pairingMs
              ? new TvError('Pairing was turned down on the TV', 'DENIED')
              : new TvError(text, options.key ? 'NOT_PAIRED' : 'FAILED'));
            return;
          }
          if (payload.pairingType === 'PROMPT' || message.type === 'response') {
            // The TV is asking on its screen. Only pairing waits for an answer: a TV that should
            // already know HomeHub and asks instead has forgotten it, and mustn't be left asking.
            if (!pairingMs) { fail(new TvError('The TV doesn’t know HomeHub any more', 'NOT_PAIRED')); return; }
            options.onPrompt?.();
            clearTimeout(timer);
            timer = setTimeout(() => fail(new TvError('Nobody pressed OK on the TV', 'TIMEOUT')), pairingMs);
            const entry = this.pending.get(id);
            if (entry) entry.timer = timer;
          }
        },
      });
      const payload = { ...pairing(signed), ...(options.key ? { 'client-key': options.key } : {}) };
      this.send({ type: 'register', id, payload });
    });
    try {
      return await attempt(true);
    } catch (err) {
      if (err instanceof TvError && err.code === 'FAILED' && /blacklisted certificate/i.test(err.message)) return attempt(false);
      throw err;
    }
  }

  /** Asks the TV something, as "ssap://audio/getVolume". Fails if the TV says no. */
  request<T = Record<string, unknown>>(uri: string, payload?: Record<string, unknown>, timeoutMs = REQUEST_MS): Promise<T> {
    if (this.closed) return Promise.reject(new TvError('Not connected to the TV', 'UNREACHABLE'));
    const id = `r${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TvError('The TV didn’t answer', 'TIMEOUT'));
        // A TV that stops answering has most likely gone off: start afresh next time.
        this.close();
      }, timeoutMs);
      this.pending.set(id, {
        timer,
        reject: (e) => { clearTimeout(timer); this.pending.delete(id); reject(e); },
        resolve: (message) => {
          clearTimeout(timer); this.pending.delete(id);
          const body = (message.payload ?? {}) as Record<string, unknown>;
          if (message.type === 'error') { reject(new TvError(String(message.error ?? 'The TV refused'), 'FAILED')); return; }
          if (body.returnValue === false) { reject(new TvError(String(body.errorText ?? body.errorCode ?? 'The TV refused'), 'FAILED')); return; }
          resolve(body as T);
        },
      });
      this.send({ type: 'request', id, uri, ...(payload ? { payload } : {}) });
    });
  }

  close(): void {
    if (this.closed) return;
    try { this.ws.terminate(); } catch { /* gone */ }
    this.shut(new TvError('Connection closed', 'UNREACHABLE'));
  }

  private send(message: Record<string, unknown>): void {
    try { this.ws.send(JSON.stringify(message)); } catch (err) { this.shut(new TvError((err as Error).message, 'UNREACHABLE')); }
  }

  private onMessage(raw: string): void {
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw); } catch { return; }
    const entry = this.pending.get(String(message.id));
    entry?.resolve(message);
  }

  private shut(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pinger) clearInterval(this.pinger);
    for (const p of [...this.pending.values()]) p.reject(err);
    this.pending.clear();
    for (const l of this.closeListeners) l();
  }
}

function connectSocket(ip: string, port: TvPort): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const host = ip.includes(':') ? `[${ip}]` : ip;
    // The TV's certificate is LG's own, not one a browser would trust: the key is what proves it's paired.
    const ws = new WebSocket(`${port.secure ? 'wss' : 'ws'}://${host}:${port.port}`, {
      handshakeTimeout: CONNECT_MS, rejectUnauthorized: false,
    });
    const timer = setTimeout(() => { ws.terminate(); reject(new TvError(`No answer from ${ip}`, 'UNREACHABLE')); }, CONNECT_MS + 500);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', (err) => { clearTimeout(timer); reject(new TvError(err.message, 'UNREACHABLE')); });
  });
}

// ── Power ──────────────────────────────────────────────────────

/**
 * Whether a TV that answers is on, from its power state. "Screen Off" (sound only) and the screen
 * saver are on; "Active Standby" is off with the network kept up for waking. A TV part way through
 * turning off says "Active" with "Request Power Off" processing.
 */
export function isOnState(payload: Record<string, unknown>): boolean {
  const state = String(payload.state ?? '');
  const processing = String(payload.processing ?? '');
  if (/power off|suspend|standby/i.test(processing)) return false;
  return state === 'Active' || state === 'Screen Off' || state === 'Screen Saver';
}

/** "AA:BB:CC:DD:EE:FF" from any spelling, or null. */
export function normalMac(value: unknown): string | null {
  const hex = String(value ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (hex.length !== 12 || /^0+$|^f+$/.test(hex)) return null;
  return hex.match(/../g)!.join(':').toUpperCase();
}

export function magicPacket(mac: string): Buffer {
  const hex = Buffer.from(mac.replace(/[^0-9a-f]/gi, ''), 'hex');
  const buf = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) hex.copy(buf, 6 + i * 6);
  return buf;
}

/**
 * Wakes a TV: magic packets for each of its addresses (wired and Wi-Fi), to everyone on the network,
 * to its own network's broadcast and to the TV itself, a few times over. Only a TV on HomeHub's own
 * network can hear the broadcasts: routers don't pass them on.
 */
export async function wake(ip: string, macs: string[]): Promise<void> {
  const targets = wakeTargets ? wakeTargets(ip) : [
    { address: '255.255.255.255', port: 9 },
    ...(/^\d+\.\d+\.\d+\.\d+$/.test(ip) ? [{ address: ip.replace(/\.\d+$/, '.255'), port: 9 }] : []),
    { address: ip, port: 9 },
  ];
  const socket = dgram.createSocket('udp4');
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(0, () => { socket.setBroadcast(true); resolve(); }); });
  const send = (packet: Buffer, t: { address: string; port: number }) => new Promise<void>((resolve) => {
    socket.send(packet, t.port, t.address, (err) => {
      if (err) logger.debug({ address: t.address, reason: err.message }, 'Wake-on-LAN packet not sent');
      resolve();
    });
  });
  try {
    for (let round = 0; round < 3; round++) {
      for (const mac of macs) for (const t of targets) await send(magicPacket(mac), t);
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    socket.close();
  }
}

// ── Finding TVs ────────────────────────────────────────────────

export const SSDP_TARGET = 'urn:lge-com:service:webos-second-screen:1';

export interface FoundTv { ip: string; name: string; model: string }

/** Asks for webOS TVs: everyone on the network, or one address. Each answers with where its description is. */
export function searchTvs(address = '239.255.255.250', waitMs = 3000): Promise<FoundTv[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const seen = new Map<string, string>();
    socket.on('message', (msg, rinfo) => {
      const text = msg.toString();
      if (!text.toLowerCase().includes('webos-second-screen')) return;
      const location = /^location:\s*(\S+)/im.exec(text)?.[1] ?? '';
      if (!seen.has(rinfo.address)) seen.set(rinfo.address, location);
    });
    socket.on('error', () => undefined);
    socket.bind(0, () => {
      const query = Buffer.from(
        `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${SSDP_TARGET}\r\n\r\n`,
      );
      for (let i = 0; i < 2; i++) socket.send(query, 1900, address, () => undefined);
    });
    setTimeout(async () => {
      try { socket.close(); } catch { /* closed */ }
      const found = await Promise.all([...seen].map(async ([ip, location]) => ({ ip, ...(await describe(location)) })));
      resolve(found);
    }, waitMs);
  });
}

/** A TV's name and model, from its description; plain ones if that can't be read. */
export async function describe(location: string): Promise<{ name: string; model: string }> {
  const fallback = { name: 'LG TV', model: 'LG webOS TV' };
  if (!/^http:\/\//.test(location)) return fallback;
  try {
    const res = await fetch(location, { signal: AbortSignal.timeout(2500) });
    const xml = await res.text();
    const tag = (t: string) => new RegExp(`<${t}>([^<]*)</${t}>`, 'i').exec(xml)?.[1]?.trim();
    const name = decodeXml(tag('friendlyName') || '').replace(/^\[LG\]\s*/i, '') || fallback.name;
    const model = decodeXml(tag('modelName') || '') || fallback.model;
    return { name, model: /^lg/i.test(model) ? model : `LG ${model}` };
  } catch {
    return fallback;
  }
}

const decodeXml = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
