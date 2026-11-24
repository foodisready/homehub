/** Robot vacuums (Roomba): what one is doing, in words, for the dashboard. */
import type { Device } from './models/device.model';

export type VacuumActivity = 'cleaning' | 'paused' | 'stuck' | 'recharging' | 'returning' | 'emptying' | 'docked' | 'idle';

export interface VacuumStatus {
  activity: VacuumActivity;
  /** Out on a cleaning job, paused or recharging part way included: the device's "on". */
  cleaning: boolean;
  battery: number | null;
  binFull: boolean;
  /** A problem it reports, in words. */
  error: string | null;
}

/** A room learned from a job the robot was given: named, or waiting for a name. */
export interface VacuumRoom { key: string; name: string | null; seenAt: string }

export const isVacuum = (d: Pick<Device, 'driverType'>) => d.driverType === 'roomba';

/** "Cleaning", "Going home", "Charging"… one or two words, for a small tile. */
export function vacuumWord(v: VacuumStatus | null | undefined, on: boolean): string {
  if (!v) return on ? 'Cleaning' : 'Not cleaning';
  switch (v.activity) {
    case 'cleaning': return 'Cleaning';
    case 'paused': return 'Paused';
    case 'stuck': return 'Stuck';
    case 'recharging': return 'Recharging';
    case 'returning': return 'Going home';
    case 'emptying': return 'Emptying bin';
    case 'docked': return v.battery !== null && v.battery < 100 ? 'Charging' : 'Docked';
    case 'idle': return 'Stopped';
  }
}

/** "Cleaning · 64%", "Stuck: Path blocked · 40%", "Docked · 100% · Bin full". */
export function vacuumDetail(v: VacuumStatus | null | undefined, on: boolean): string {
  if (!v) return vacuumWord(v, on);
  const head = v.activity === 'stuck' ? `Stuck: ${v.error ?? 'needs help'}`
    : v.activity === 'recharging' ? 'Recharging, then carries on'
    : vacuumWord(v, on);
  return [
    head,
    v.battery !== null ? `${v.battery}%` : '',
    v.binFull ? 'Bin full' : '',
    v.error && v.activity !== 'stuck' && v.error !== 'Bin full' ? v.error : '',
  ].filter(Boolean).join(' · ');
}

/** Wants someone to look: stuck, a problem, or a full bin. */
export const vacuumNeedsHelp = (v: VacuumStatus | null | undefined) => !!v && (v.activity === 'stuck' || !!v.error || v.binFull);
