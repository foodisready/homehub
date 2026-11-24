/** Robot vacuums (Roomba): what one is doing, in words, for the dashboard. */
import type { Device } from './models/device.model';

export type VacuumActivity = 'cleaning' | 'paused' | 'stuck' | 'recharging' | 'returning' | 'emptying' | 'docked' | 'idle';

export interface VacuumStatus {
  activity: VacuumActivity;
  /** Out on a cleaning job, paused or recharging part way included: the device's "on". */
  cleaning: boolean;
  /** It holds a job it hasn't finished: running, paused, or paused back on its dock. */
  jobOpen?: boolean;
  /** Sitting on its dock. */
  onDock?: boolean;
  /** Went home part way to empty its bin and stopped there instead of carrying on. */
  stoppedAfterEmptying?: boolean;
  /** The job it holds: the whole house, or these rooms in order (null for one not named yet). */
  job?: { whole: boolean; rooms: (string | null)[] } | null;
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
    : v.activity === 'emptying' && !v.onDock ? 'Going home to empty its bin'
    : v.activity === 'emptying' ? 'Emptying its bin, then carries on'
    : v.activity === 'paused' && v.onDock ? 'Job paused at home'
    : vacuumWord(v, on);
  return [
    head,
    v.battery !== null ? `${v.battery}%` : '',
    v.binFull ? 'Bin full' : '',
    v.error && v.activity !== 'stuck' && v.error !== 'Bin full' ? v.error : '',
  ].filter(Boolean).join(' · ');
}

/** "This job: Master Bedroom, Master Closet and Master Bath.", or the whole house; '' with no job. */
export function vacuumJobText(v: VacuumStatus | null | undefined): string {
  const job = v?.jobOpen ? v.job : null;
  if (!job) return '';
  if (job.whole) return 'This job: the whole house.';
  const names = job.rooms.map((r) => r ?? 'a room not named yet');
  if (!names.length) return '';
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `This job: ${list}.`;
}

/** Busy with a job it would have to drop for a new one. Paused, at home or not, it isn't. */
export const vacuumBusy = (v: VacuumStatus | null | undefined) => !!v && ['cleaning', 'returning', 'emptying', 'recharging'].includes(v.activity);

/** Wants someone to look: stuck, a problem, or a full bin. */
export const vacuumNeedsHelp = (v: VacuumStatus | null | undefined) => !!v && (v.activity === 'stuck' || !!v.error || v.binFull || !!v.stoppedAfterEmptying);
