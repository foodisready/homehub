import type { DeviceDriver, DiscoveredDevice, EnergyMetrics } from './DeviceDriver';
import { discover } from '../roomba/protocol';
import { readStatus, sendCommand, type RobotLogin } from '../roomba/link';
import { searchNetworks } from '../discovery/networks';
import { logger } from '../logger';

type Found = Omit<DiscoveredDevice, 'driverType'>;

/** How long a robot told to pause has to stop before it's sent home anyway. */
const PAUSE_WAIT_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "192.168.86" → its broadcast address. */
const broadcastOf = (prefix: string) => `${prefix}.255`;

export function loginOf(config?: Record<string, unknown>): RobotLogin {
  const blid = typeof config?.blid === 'string' ? config.blid : '';
  const password = typeof config?.password === 'string' ? config.password : '';
  if (!blid || !password) throw new Error('This Roomba isn’t paired yet. Remove it and add it again from Discover.');
  return { blid, password };
}

/**
 * Wi-Fi Roombas, on the home network (see roomba/protocol.ts). On means out
 * cleaning: turning it on starts a job, or carries on with a paused one, and
 * turning it off sends it home to its dock. Pausing has its own button.
 */
export class RoombaDriver implements DeviceDriver {
  readonly type = 'roomba';
  /** It takes a few seconds to set off or turn for home. */
  readonly confirmAfterMs = 8_000;

  async setPower(ip: string, on: boolean, config?: Record<string, unknown>): Promise<void> {
    const login = loginOf(config);
    const status = await readStatus(ip, login);
    if (on) {
      if (status.activity === 'cleaning') return;
      await sendCommand(ip, login, status.activity === 'paused' ? 'resume' : 'start');
      return;
    }
    if (!status.cleaning && status.activity !== 'returning') return;   // already home, or on its way
    // A robot out cleaning ignores "dock": it has to pause first, as iRobot's app does.
    if (status.activity === 'cleaning') {
      await sendCommand(ip, login, 'pause');
      const until = Date.now() + PAUSE_WAIT_MS;
      while (Date.now() < until && (await readStatus(ip, login)).activity === 'cleaning') await sleep(500);
    }
    await sendCommand(ip, login, 'dock');
  }

  async getPower(ip: string, config?: Record<string, unknown>): Promise<boolean> {
    return (await readStatus(ip, loginOf(config))).cleaning;
  }

  async getEnergy(): Promise<EnergyMetrics | null> {
    return null;
  }

  async probe(ip: string): Promise<Found | null> {
    const [robot] = await discover([ip], 2000);
    return robot ? this.toFound(robot) : null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    const networks = searchNetworks();
    const robots = await discover(['255.255.255.255', ...networks.map(broadcastOf)]);
    logger.info({ networks, count: robots.length }, 'Roomba search complete');
    return robots.filter((r) => r.mqtt).map((r) => ({ ...this.toFound(r), driverType: this.type }));
  }

  /** Every robot needs pairing at its Home button before it can be added: see routes/roomba.ts. */
  private toFound(r: Awaited<ReturnType<typeof discover>>[number]): Found {
    return {
      ip: r.ip,
      alias: r.name,
      model: r.sku || 'Roomba',
      hasEmeter: false,
      needsLogin: true,
      ...(r.mac ? { mac: r.mac } : {}),
    };
  }
}
