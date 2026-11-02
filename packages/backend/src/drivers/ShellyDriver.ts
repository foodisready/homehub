import * as os   from 'os';
import { DeviceDriver, DiscoveredDevice, EnergyMetrics } from './DeviceDriver';
import { logger } from '../logger';

/** Return unique /24 subnet prefixes for all non-loopback IPv4 interfaces, e.g. ["192.168.86"] */
function localSubnets(): string[] {
  const prefixes = new Set<string>();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const p = addr.address.split('.');
        prefixes.add(`${p[0]}.${p[1]}.${p[2]}`);
      }
    }
  }
  return [...prefixes];
}

interface ShellyConfig {
  gen?: 1 | 2;
  auth?: { user: string; pass: string };
  /** Which relay to use on a multi-channel Shelly, such as the 2.5. Defaults to the first. */
  channel?: number;
}

const channelOf = ({ channel }: ShellyConfig) => (Number.isInteger(channel) && channel! > 0 ? channel! : 0);

/** Gen 2 devices report `auth_en` and Gen 1 report `auth`, both without a login. */
function loginRequired(info: { auth_en?: boolean; auth?: boolean }): boolean {
  return info.auth_en === true || info.auth === true;
}

async function shellyFetch(url: string, options: RequestInit = {}, auth?: ShellyConfig['auth']): Promise<any> {
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> ?? {}) };
  if (auth) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64');
  }
  const res = await fetch(url, {
    signal: AbortSignal.timeout(5000),
    ...options,
    headers,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

export class ShellyDriver implements DeviceDriver {
  readonly type = 'shelly';

  async setPower(ip: string, on: boolean, config?: Record<string, unknown>): Promise<void> {
    const { gen, auth } = (config ?? {}) as ShellyConfig;
    const channel = channelOf(config ?? {});
    if (gen === 2) {
      await shellyFetch(`http://${ip}/rpc/Switch.Set`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: channel, on }),
      }, auth);
    } else {
      const result = await shellyFetch(`http://${ip}/relay/${channel}?turn=${on ? 'on' : 'off'}`, {}, auth);
      logger.debug({ ip, on, ison: result?.ison }, 'Shelly Gen1 relay response');
      if (result && 'ison' in result && result.ison !== on) {
        throw new Error(`Shelly relay did not switch: expected ${on}, device reports ison=${result.ison}`);
      }
    }
  }

  async getPower(ip: string, config?: Record<string, unknown>): Promise<boolean> {
    const { gen, auth } = (config ?? {}) as ShellyConfig;
    const channel = channelOf(config ?? {});
    if (gen === 2) {
      const status = await shellyFetch(`http://${ip}/rpc/Switch.GetStatus`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: channel }),
      }, auth);
      return status.output === true;
    } else {
      const relay = await shellyFetch(`http://${ip}/relay/${channel}`, {}, auth);
      return relay.ison === true;
    }
  }

  async getEnergy(ip: string, config?: Record<string, unknown>): Promise<EnergyMetrics | null> {
    const { gen, auth } = (config ?? {}) as ShellyConfig;
    const channel = channelOf(config ?? {});
    try {
      if (gen === 2) {
        const status = await shellyFetch(`http://${ip}/rpc/Switch.GetStatus`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ id: channel }),
        }, auth);
        if (!('apower' in status)) return null;
        return {
          wattage: status.apower  ?? null,
          voltage: status.voltage ?? null,
          current: status.current ?? null,
        };
      } else {
        const meter = await shellyFetch(`http://${ip}/meter/${channel}`, {}, auth);
        if (!meter.is_valid) return null;
        return {
          wattage: meter.power   ?? null,
          voltage: meter.voltage ?? null,
          current: null,  // Gen1 basic meter doesn't expose current
        };
      }
    } catch {
      return null;
    }
  }

  async probe(ip: string, config?: Record<string, unknown>): Promise<Omit<DiscoveredDevice, 'driverType'> | null> {
    const auth = (config as ShellyConfig | undefined)?.auth;

    // Try Gen2 first
    try {
      const info = await shellyFetch(`http://${ip}/rpc/Shelly.GetDeviceInfo`, {}, auth);
      if (info && (info.gen ?? 0) >= 2) {
        let hasEmeter = false;
        try {
          const status = await shellyFetch(`http://${ip}/rpc/Switch.GetStatus`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ id: 0 }),
          }, auth);
          hasEmeter = 'apower' in status;
        } catch {}
        return {
          ip,
          alias:       info.name ?? info.id ?? ip,
          model:       info.model ?? info.app ?? 'Shelly',
          hasEmeter,
          driverConfig: { gen: 2, ...(auth ? { auth } : {}) },
          ...(!auth && loginRequired(info) ? { needsLogin: true } : {}),
        };
      }
    } catch {}

    // Try Gen1
    try {
      const info = await shellyFetch(`http://${ip}/shelly`, {}, auth);
      if (info && info.type) {
        let hasEmeter = false;
        try {
          const meter = await shellyFetch(`http://${ip}/meter/0`, {}, auth);
          hasEmeter = meter.is_valid === true;
        } catch {}
        return {
          ip,
          alias:       info.hostname ?? ip,
          model:       info.type ?? 'Shelly',
          hasEmeter,
          driverConfig: { gen: 1, ...(auth ? { auth } : {}) },
          ...(!auth && loginRequired(info) ? { needsLogin: true } : {}),
        };
      }
    } catch {}

    return null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    const subnets = localSubnets();
    if (!subnets.length) {
      logger.warn('Shelly scan: no non-loopback IPv4 interfaces found');
      return [];
    }

    logger.info({ subnets }, 'Shelly subnet scan started');

    const found: DiscoveredDevice[] = [];

    // Scan all /24 subnets in parallel — short 1.5s timeout per IP to keep it snappy
    await Promise.allSettled(
      subnets.flatMap((prefix) =>
        Array.from({ length: 254 }, (_, i) => i + 1).map(async (host) => {
          const ip = `${prefix}.${host}`;
          try {
            const result = await this.probeWithTimeout(ip, 1500);
            if (result) found.push({ ...result, driverType: 'shelly' });
          } catch {}
        })
      )
    );

    logger.info({ count: found.length }, 'Shelly subnet scan complete');
    return found;
  }

  /** Probe with a custom timeout (ms) — used during fast subnet scans. */
  private async probeWithTimeout(ip: string, timeoutMs: number): Promise<Omit<DiscoveredDevice, 'driverType'> | null> {
    // Try Gen2 first
    try {
      const info = await fetch(`http://${ip}/rpc/Shelly.GetDeviceInfo`, {
        signal: AbortSignal.timeout(timeoutMs),
      }).then((r) => r.ok ? r.json() as Promise<any> : Promise.reject());
      if (info?.gen >= 2) {
        let hasEmeter = false;
        try {
          const status: any = await fetch(`http://${ip}/rpc/Switch.GetStatus`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 0 }),
            signal: AbortSignal.timeout(timeoutMs),
          }).then((r) => r.json());
          hasEmeter = 'apower' in status;
        } catch {}
        return { ip, alias: info.name ?? info.id ?? ip, model: info.model ?? info.app ?? 'Shelly', hasEmeter, driverConfig: { gen: 2 }, ...(loginRequired(info) ? { needsLogin: true } : {}) };
      }
    } catch {}

    // Try Gen1
    try {
      const info = await fetch(`http://${ip}/shelly`, {
        signal: AbortSignal.timeout(timeoutMs),
      }).then((r) => r.ok ? r.json() as Promise<any> : Promise.reject());
      if (info?.type) {
        let hasEmeter = false;
        try {
          const meter: any = await fetch(`http://${ip}/meter/0`, { signal: AbortSignal.timeout(timeoutMs) }).then((r) => r.json());
          hasEmeter = meter.is_valid === true;
        } catch {}
        return { ip, alias: info.hostname ?? ip, model: info.type ?? 'Shelly', hasEmeter, driverConfig: { gen: 1 }, ...(loginRequired(info) ? { needsLogin: true } : {}) };
      }
    } catch {}

    return null;
  }
}
