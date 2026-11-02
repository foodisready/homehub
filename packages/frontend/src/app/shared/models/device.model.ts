import type { LastChange } from '../activity/activity-text';

export interface Device {
  id: number;
  alias: string;
  ip: string;
  model: string | null;
  hasEmeter: boolean;
  icon: string | null;
  state: boolean;
  wattage: number | null;
  online: boolean;
  overrideState: boolean | null;
  overrideUntil: string | null;   // ISO datetime string, null = no active override
  driverType:   string;
  /** Passwords and keys stay on HomeHub; driverConfig has them removed. */
  driverConfig: Record<string, unknown> | null;
  /** Which secrets are saved, as paths into driverConfig, e.g. "auth.pass". */
  savedSecrets?: string[];
  /** The latest on/off change and its cause, from Activity. */
  lastChange?: LastChange | null;
  nicknames:    string[];
  room:         string | null;
  isProtected:  boolean;
}
