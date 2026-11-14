/** GET /api/energy/usage. Energy in kWh and therms; cost in `prices.currency`. */

export type WattsMethod = 'set' | 'measured' | 'typical' | 'none';

export interface DeviceUsage {
  id: number; alias: string; room: string | null;
  onHours: number; knownHours: number;
  kwh: number | null; cost: number | null;
  watts: number | null; method: WattsMethod; label: string | null; rough: boolean;
}

export interface HvacUsage {
  id: number; alias: string; kind: 'heating' | 'cooling';
  hours: number; kwh: number | null; therms: number | null; cost: number | null;
  system: string | null;
}

export interface Totals { kwh: number; therms: number; cost: number | null; notCounted: number; electricityCost: number | null; gasCost: number | null }

export interface Prices { electricity: number | null; gas: number | null; currency: string }

export interface MonthTotal extends Totals { month: string; recorded: boolean }

export interface Usage {
  month: string; from: string; to: string; partial: boolean; days: number; daysInMonth: number;
  recordedFrom: string | null;
  prices: Prices;
  devices: DeviceUsage[];
  hvac: HvacUsage[];
  excluded: { id: number; alias: string; reason: string }[];
  totals: Totals;
  /** Last month's same days, for the devices HomeHub recorded through both: `current` is those same devices now. */
  previousSameDays: { month: string; days: number; previous: Totals; current: Totals; devices: number; heating: boolean } | null;
  months: MonthTotal[];
  thisMonth: string;
  timezone: string;
}

export const monthName = (m: string, style: 'long' | 'short' = 'long', year = false) =>
  new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 15).toLocaleDateString([], { month: style, ...(year ? { year: 'numeric' } : {}) });

export const kwhText = (k: number) => `${k < 10 ? k.toFixed(2) : k < 100 ? k.toFixed(1) : Math.round(k)} kWh`;

export function money(v: number, currency: string): string {
  try {
    return new Intl.NumberFormat([], { style: 'currency', currency, maximumFractionDigits: v < 10 ? 2 : 0 }).format(v);
  } catch {
    return v.toFixed(2);
  }
}

/** What heating or cooling runs on, in words. */
export const SYSTEM_NAME: Record<string, string> = {
  gas: 'gas furnace', heat_pump: 'heat pump', electric: 'electric heat', ac: 'central air',
};
