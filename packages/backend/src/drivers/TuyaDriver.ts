import * as dgram   from 'dgram';
import * as crypto  from 'crypto';
import { DeviceDriver, DiscoveredDevice, EnergyMetrics } from './DeviceDriver';
import { logger } from '../logger';

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

export class TuyaDriver implements DeviceDriver {
  readonly type = 'tuya';

  async setPower(ip: string, on: boolean, config?: Record<string, unknown>): Promise<void> {
    const { deviceId, key, version = '3.3' } = (config ?? {}) as unknown as TuyaConfig;
    if (!deviceId || !key) throw new Error('Tuya device requires deviceId and key in driver_config');

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const TuyAPI = require('tuyapi');
    const device = new TuyAPI({ id: deviceId, key, ip, issueGetOnConnect: false, version });
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

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const TuyAPI = require('tuyapi');
    const device = new TuyAPI({ id: deviceId, key, ip, issueGetOnConnect: false, version });
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
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const TuyAPI = require('tuyapi');
      const device = new TuyAPI({ id: deviceId, key, ip, issueGetOnConnect: false, version });
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

  async discover(timeoutMs = 5000): Promise<DiscoveredDevice[]> {
    return new Promise((resolve) => {
      const found   = new Map<string, DiscoveredDevice>(); // keyed by gwId
      const sockets: dgram.Socket[] = [];

      const finish = () => {
        clearTimeout(timer);
        sockets.forEach((s) => { try { s.close(); } catch {} });
        resolve(Array.from(found.values()));
      };

      // eslint-disable-next-line prefer-const
      let timer = setTimeout(finish, timeoutMs);

      const onMessage = (msg: Buffer) => {
        const data = extractPacket(msg);
        if (!data?.gwId || !data?.ip) return;
        if (found.has(data.gwId)) return;

        logger.debug({ gwId: data.gwId, ip: data.ip, version: data.version }, 'Discovered Tuya device');
        found.set(data.gwId, {
          ip:          data.ip,
          alias:       data.ip,  // No alias available from broadcast — user must set one
          model:       'Tuya Smart Plug',
          hasEmeter:   false,
          driverType:  'tuya',
          driverConfig: {
            deviceId: data.gwId,
            version:  data.version ?? '3.3',
            // key is intentionally absent — must be supplied by the user
          },
        });
      };

      // Tuya devices broadcast on UDP 6666 (v3.1 plain) and 6667 (v3.3 encrypted)
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
  }
}
