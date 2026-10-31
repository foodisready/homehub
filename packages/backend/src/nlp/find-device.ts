import { getDb } from '../db';

export interface NamedDevice {
  id:    number;
  alias: string;
  [column: string]: unknown;
}

export type DeviceMatch =
  | { device: NamedDevice }
  | { error: string };

const normalize = (name: string) =>
  name.toLowerCase().replace(/[_-]+/g, ' ').trim().replace(/^(my|the)\s+/, '');

/**
 * Resolve a spoken or typed name to one device. Models and people often drop
 * part of a name ("office lamp" for "My office lamp"), so a partial match is
 * accepted, but only if it fits exactly one device. This can switch real
 * hardware, including a water valve, so an unclear name is never guessed.
 */
export function findDeviceByName(name: string): DeviceMatch {
  const wanted = normalize(name);
  if (!wanted) return { error: 'No device name was given.' };

  const devices = getDb().prepare('SELECT * FROM devices').all() as NamedDevice[];

  const exact = devices.filter((d) => normalize(d.alias) === wanted);
  if (exact.length === 1) return { device: exact[0] };

  const partial = exact.length ? exact : devices.filter((d) => normalize(d.alias).includes(wanted));
  if (partial.length === 1) return { device: partial[0] };

  if (partial.length > 1) {
    const names = partial.map((d) => `"${d.alias}"`).join(', ');
    return { error: `"${name}" could mean ${names}. Ask the user which one they mean.` };
  }
  return { error: `Device "${name}" not found. Use list_devices to see available devices.` };
}
