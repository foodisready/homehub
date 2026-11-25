import type { DeviceDriver, DiscoveredDevice, EnergyMetrics } from './DeviceDriver';
import { TvError, searchTvs, wake, normalMac, type FoundTv } from '../lgtv/protocol';
import { powerOf, turnOff, type TvLogin } from '../lgtv/link';
import { logger } from '../logger';

type Found = Omit<DiscoveredDevice, 'driverType'>;

/** How long a woken TV has to start answering. Most take 5–10 s. */
export const WAKE_WAIT_MS = 20_000;
let wakeWaitMs = WAKE_WAIT_MS;
/** For tests: a shorter wait for a TV to wake. */
export function setWakeWaitForTests(ms: number): void { wakeWaitMs = ms; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function tvLoginOf(config?: Record<string, unknown>): TvLogin {
  const key = typeof config?.key === 'string' ? config.key : '';
  if (!key) throw new TvError('This TV isn’t paired yet. Pair it from Discover.', 'NOT_PAIRED');
  return { key };
}

export function tvMacsOf(config?: Record<string, unknown>): string[] {
  const list = Array.isArray(config?.macs) ? config.macs : [];
  return [...new Set(list.map(normalMac).filter((m): m is string => !!m))];
}

/**
 * LG webOS TVs (see lgtv/protocol.ts). Off over the network; on with Wake-on-LAN, which the TV
 * only hears with "Turn on via Wi-Fi" on, and only from HomeHub's own network.
 */
export class LgTvDriver implements DeviceDriver {
  readonly type = 'lgtv';
  /** setPower waits for the TV itself, so the read-back can come soon after. */
  readonly confirmAfterMs = 2_000;

  async setPower(ip: string, on: boolean, config?: Record<string, unknown>): Promise<void> {
    const login = tvLoginOf(config);
    const now = await powerOf(ip, login);
    if (now === on) return;
    if (!on) { await turnOff(ip, login); return; }

    const macs = tvMacsOf(config);
    if (!macs.length) throw new TvError('HomeHub doesn’t know how to wake this TV. Turn it on with its remote, then pair it again from Discover.', 'FAILED');
    await wake(ip, macs);
    const until = Date.now() + wakeWaitMs;
    const every = Math.min(1_500, wakeWaitMs / 5);
    let round = 0;
    while (Date.now() < until) {
      await sleep(every);
      if (await powerOf(ip, login)) return;
      // Keep knocking: the first packets can arrive while the TV's network is still asleep.
      if (++round % 3 === 0) await wake(ip, macs);
    }
    logger.warn({ ip }, 'LG TV did not wake');
    throw new TvError('The TV didn’t turn on. In its settings, turn on “Turn on via Wi-Fi” (or “Mobile TV On”), then try again.', 'TIMEOUT');
  }

  async getPower(ip: string, config?: Record<string, unknown>): Promise<boolean> {
    return powerOf(ip, tvLoginOf(config));
  }

  async getEnergy(): Promise<EnergyMetrics | null> {
    return null;
  }

  async probe(ip: string): Promise<Found | null> {
    const [tv] = (await searchTvs(ip, 2000)).filter((t) => t.ip === ip);
    return tv ? this.toFound(tv) : null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    const tvs = await searchTvs();
    logger.info({ count: tvs.length }, 'LG TV search complete');
    return tvs.map((t) => ({ ...this.toFound(t), driverType: this.type }));
  }

  /** Every TV needs pairing (OK on its remote) before it can be added: see routes/lgtv.ts. */
  private toFound(t: FoundTv): Found {
    return { ip: t.ip, alias: t.name, model: t.model, hasEmeter: false, needsLogin: true };
  }
}
