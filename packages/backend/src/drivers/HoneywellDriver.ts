import type { DeviceDriver, DiscoveredDevice, EnergyMetrics } from './DeviceDriver';

/**
 * Honeywell thermostats on Total Connect Comfort (see honeywell/honeywell.ts). Like a Matter
 * thermostat, one is "on" when its mode isn't off, and turning it on goes back to its last mode.
 * The device poller asks often, so on/off comes from the readings HomeHub already has: Honeywell
 * limits how often an account may ask.
 */
const honeywell = () => import('../honeywell/honeywell');

function deviceIdOf(ip: string, config?: Record<string, unknown>): number {
  const fromConfig = Number(config?.['deviceId']);
  if (Number.isFinite(fromConfig) && fromConfig > 0) return fromConfig;
  const m = /^honeywell:(\d+)$/.exec(ip);
  if (m) return Number(m[1]);
  throw new Error(`Not a Honeywell thermostat: ${ip}`);
}

export class HoneywellDriver implements DeviceDriver {
  readonly type = 'honeywell';
  /** Honeywell takes a while to pass a change on and report it back. */
  readonly confirmAfterMs = 4_000;

  async setPower(ip: string, on: boolean, config?: Record<string, unknown>): Promise<void> {
    const h = await honeywell();
    const deviceId = deviceIdOf(ip, config);
    if (!on) return h.setThermostat(deviceId, { mode: 'off' }, 'temporary');
    const now = h.readThermostat(deviceId);
    if (now.mode !== 'off') return;   // already heating, cooling or in auto
    const { resumeMode, thermostatIdForHoneywell } = await import('../thermostat/thermostat');
    const id = thermostatIdForHoneywell(deviceId);
    return h.setThermostat(deviceId, { mode: id === null ? 'heat' : resumeMode(id, now.modes) }, 'temporary');
  }

  async getPower(ip: string, config?: Record<string, unknown>): Promise<boolean> {
    return (await honeywell()).readThermostat(deviceIdOf(ip, config)).mode !== 'off';
  }

  async getEnergy(): Promise<EnergyMetrics | null> {
    return null;
  }

  /** Added by signing in to Total Connect Comfort, not by address. */
  async probe(): Promise<null> {
    return null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    return [];
  }
}
