import * as dgram   from 'dgram';
import * as net     from 'net';
import * as crypto  from 'crypto';
import { DeviceDriver, DiscoveredDevice, EnergyMetrics } from './DeviceDriver';
import { logger } from '../logger';
import { searchNetworks } from '../discovery/networks';

/** HomeHub's own /24s plus any other networks added in Settings, e.g. ["192.168.0", "192.168.1"]. */
const localSubnets = searchNetworks;

/** Check if TCP port 6668 is open on an IP within timeoutMs. */
function probeTuyaPort(ip: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (result: boolean) => { sock.destroy(); resolve(result); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error',   () => done(false));
    sock.connect(6668, ip);
  });
}

// Well-known AES key used for Tuya v3.3+ UDP broadcast encryption
const BROADCAST_KEY = Buffer.from('yGAdlopoPVldABfn');

interface TuyaConfig {
  deviceId: string;
  key:      string;
  version?: string;  // '3.1' | '3.3' | '3.4'
}

function tryParsePayload(buf: Buffer): any | null {
  // Attempt 1: plain JSON
  try {
    return JSON.parse(buf.toString('utf8').replace(/\0+$/, ''));
  } catch {}

  // Attempt 2: AES-128-ECB decrypt with known broadcast key (v3.3+)
  try {
    const decipher = crypto.createDecipheriv('aes-128-ecb', BROADCAST_KEY, null);
    decipher.setAutoPadding(false);
    const dec = Buffer.concat([decipher.update(buf), decipher.final()]);
    return JSON.parse(dec.toString('utf8').replace(/\0+$/, ''));
  } catch {}

  return null;
}

/** Parse a raw Tuya UDP broadcast packet and return device info, or null. */
function extractPacket(buf: Buffer): any | null {
  if (buf.length < 20) return null;

  const magic = buf.readUInt32BE(0);
  if (magic === 0x000055AA) {
    // Standard Tuya packet: 16-byte header + payload + 4-byte CRC + 4-byte suffix
    const dataLen = buf.readUInt32BE(12);
    const payloadEnd = Math.min(16 + dataLen - 4, buf.length - 4);
    if (payloadEnd <= 16) return null;
    return tryParsePayload(buf.slice(16, payloadEnd));
  }

  // Non-standard — try parsing the whole buffer as-is
  return tryParsePayload(buf);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const TuyAPI = require('tuyapi');

/** Create a TuyAPI device instance with a no-op error handler to prevent unhandled error events crashing the process. */
function makeTuyaDevice(deviceId: string, key: string, ip: string, version: string): any {
  const device = new TuyAPI({ id: deviceId, key, ip, issueGetOnConnect: false, version });
  device.on('error', () => {}); // suppress async ECONNRESET / socket errors
  return device;
}

export class TuyaDriver implements DeviceDriver {
  readonly type = 'tuya';

  async setPower(ip: string, on: boolean, config?: Record<string, unknown>): Promise<void> {
    const { deviceId, key, version = '3.3' } = (config ?? {}) as unknown as TuyaConfig;
    if (!deviceId || !key) throw new Error('Tuya device requires deviceId and key in driver_config');

    const device = makeTuyaDevice(deviceId, key, ip, version);
    try {
      await device.connect();
      await device.set({ dps: '1', set: on });
    } finally {
      try { device.disconnect(); } catch {}
    }
  }

  async getPower(ip: string, config?: Record<string, unknown>): Promise<boolean> {
    const { deviceId, key, version = '3.3' } = (config ?? {}) as unknown as TuyaConfig;
    if (!deviceId || !key) throw new Error('Tuya device requires deviceId and key in driver_config');

    const device = makeTuyaDevice(deviceId, key, ip, version);
    try {
      await device.connect();
      const status = await device.get({ dps: '1' });
      return status === true || status === 'true' || status === 1;
    } finally {
      try { device.disconnect(); } catch {}
    }
  }

  async getEnergy(): Promise<EnergyMetrics | null> {
    // Most Tuya plugs don't expose energy via the local API
    return null;
  }

  async probe(ip: string, config?: Record<string, unknown>): Promise<Omit<DiscoveredDevice, 'driverType'> | null> {
    const { deviceId, key, version = '3.3' } = (config ?? {}) as unknown as TuyaConfig;
    if (!deviceId || !key) return null;

    try {
      const device = makeTuyaDevice(deviceId, key, ip, version);
      await device.connect();
      try { device.disconnect(); } catch {}
      return {
        ip,
        alias:        ip,                // Local protocol doesn't expose device name
        model:        'Tuya Smart Plug',
        hasEmeter:    false,
        driverConfig: { deviceId, key, version },
      };
    } catch {
      return null;
    }
  }

  async discover(udpTimeoutMs = 3000): Promise<DiscoveredDevice[]> {
    const found = new Map<string, DiscoveredDevice>(); // keyed by IP

    // ── 1. UDP broadcast (catches devices that recently joined the network) ──
    await new Promise<void>((resolve) => {
      const sockets: dgram.Socket[] = [];
      const finish = () => {
        clearTimeout(timer);
        sockets.forEach((s) => { try { s.close(); } catch {} });
        resolve();
      };
      // eslint-disable-next-line prefer-const
      let timer = setTimeout(finish, udpTimeoutMs);

      const onMessage = (msg: Buffer) => {
        const data = extractPacket(msg);
        if (!data?.gwId || !data?.ip) return;
        if (found.has(data.ip)) return;
        logger.debug({ gwId: data.gwId, ip: data.ip, version: data.version }, 'Discovered Tuya device via UDP');
        found.set(data.ip, {
          ip:          data.ip,
          alias:       data.ip,
          model:       'Tuya Smart Plug',
          hasEmeter:   false,
          driverType:  'tuya',
          driverConfig: { deviceId: data.gwId, version: data.version ?? '3.3' },
        });
      };

      for (const port of [6666, 6667]) {
        try {
          const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
          sockets.push(sock);
          sock.on('message', onMessage);
          sock.on('error', () => {});
          sock.bind(port);
        } catch {}
      }
    });

    // ── 2. TCP port-6668 subnet scan (catches already-paired devices) ──
    const subnets = localSubnets();
    if (!subnets.length) {
      logger.warn('Tuya scan: no non-loopback IPv4 interfaces found');
      return Array.from(found.values());
    }

    logger.info({ subnets }, 'Tuya TCP port-6668 subnet scan started');

    await Promise.allSettled(
      subnets.flatMap((prefix) =>
        Array.from({ length: 254 }, (_, i) => i + 1).map(async (host) => {
          const ip = `${prefix}.${host}`;
          if (found.has(ip)) return; // already found via UDP
          const open = await probeTuyaPort(ip, 1000);
          if (!open) return;
          logger.debug({ ip }, 'Tuya device found via TCP scan (key required)');
          found.set(ip, {
            ip,
            alias:       ip,
            model:       'Tuya Smart Plug',
            hasEmeter:   false,
            driverType:  'tuya',
            driverConfig: { version: '3.3' }, // deviceId + key must be supplied by user
          });
        })
      )
    );

    logger.info({ count: found.size }, 'Tuya scan complete');
    return Array.from(found.values());
  }
}
