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
  driverConfig: Record<string, unknown> | null;
  nicknames:    string[];
  isProtected:  boolean;
}
