import { getDb } from '../db';

export interface NamedDevice {
  id:    number;
  alias: string;
  [column: string]: unknown;
}

export type DeviceMatch =
  | { device: NamedDevice }
  | { error: string; candidates?: string[] };

const normalize = (name: string) =>
  name.toLowerCase().replace(/[_-]+/g, ' ').trim().replace(/^(my|the)\s+/, '');

const singular = (name: string) => name.split(/\s+/).map((word) => word.replace(/s$/, '')).join(' ');

const containsWords = (alias: string, wanted: string) =>
  ` ${singular(alias)} `.includes(` ${singular(wanted)} `);

function deviceNames(device: NamedDevice): string[] {
  let nicknames: unknown = [];
  try {
    nicknames = JSON.parse(String(device.nicknames ?? '[]'));
  } catch { /* a bad value shouldn't stop the alias from matching */ }
  const extra = Array.isArray(nicknames) ? nicknames.map(String) : [];
  return [device.alias, ...extra].map(normalize);
}

/**
 * Resolve a spoken or typed name to one device. Models and people often drop
 * part of a name ("office lamp" for "My office lamp"), so a partial match of
 * whole words is accepted, but only if it fits exactly one device. This can
 * switch real hardware, including a water valve, so an unclear name is never
 * guessed. Whole words matter: "it" must not match "kitchen lights".
 */
export function findDeviceByName(name: string): DeviceMatch {
  const wanted = normalize(name);
  if (!wanted) return { error: 'No device name was given.' };

  const devices = getDb().prepare('SELECT * FROM devices').all() as NamedDevice[];

  const exact = devices.filter((d) => deviceNames(d).includes(wanted));
  if (exact.length === 1) return { device: exact[0] };

  const partial = exact.length ? exact : devices.filter((d) => deviceNames(d).some((n) => containsWords(n, wanted)));
  if (partial.length === 1) return { device: partial[0] };

  if (partial.length > 1) {
    const candidates = partial.map((d) => `"${d.alias}"`);
    return { error: `"${name}" could mean ${candidates.join(', ')}. Ask the user which one they mean.`, candidates };
  }
  return { error: `Device "${name}" not found. Use list_devices to see available devices.` };
}
