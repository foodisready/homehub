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
  name.toLowerCase().replace(/['’]s\b/g, '').replace(/[_-]+/g, ' ').trim().replace(/^(my|the)\s+/, '');

const singular = (name: string) => name.split(/\s+/).map((word) => word.replace(/s$/, '')).join(' ');

/** People say "light" and "lamp" interchangeably, so "office light" can mean "office lamp". */
const lampAsLight = (name: string) => singular(name).replace(/\blamp\b/g, 'light');

const containsWords = (alias: string, wanted: string) =>
  ` ${singular(alias)} `.includes(` ${singular(wanted)} `);

function namesOf(device: NamedDevice): string[] {
  let nicknames: unknown = [];
  try {
    nicknames = JSON.parse(String(device.nicknames ?? '[]'));
  } catch { /* a bad value shouldn't stop the alias from matching */ }
  const extra = Array.isArray(nicknames) ? nicknames.map(String) : [];
  return [device.alias, ...extra];
}

const deviceNames = (device: NamedDevice) => namesOf(device).map(normalize);

/** Every name and nickname, as typed. Speech recognition uses these as hints. */
export function listDeviceNames(): string[] {
  const devices = getDb().prepare('SELECT * FROM devices').all() as NamedDevice[];
  const rooms = devices.map((d) => d.room).filter((room): room is string => typeof room === 'string');
  return [...new Set([...devices.flatMap(namesOf), ...rooms])];
}

export interface NamedScene {
  id:   number;
  name: string;
}

// Speech recognition may hear "Goodnight" as "good night".
const sceneKey = (name: string) => normalize(name).replace(/[^a-z0-9]/g, '');

export function listSceneNames(): string[] {
  const scenes = getDb().prepare('SELECT name FROM scenes').all() as { name: string }[];
  return scenes.map((scene) => scene.name);
}

/** Finds a scene by its whole name. A scene can switch many devices, so nothing partial counts. */
export function findScene(name: string): NamedScene | null {
  const wanted = sceneKey(name);
  if (!wanted) return null;
  const scenes = getDb().prepare('SELECT id, name FROM scenes').all() as NamedScene[];
  return scenes.find((scene) => sceneKey(scene.name) === wanted) ?? null;
}

/**
 * Devices in a room, or sharing a nickname such as "living room lights".
 * Sharing one is deliberate, so unlike an unclear partial name it means
 * all of them. A name that's also a device's real name is never a group.
 */
export function findDeviceGroup(name: string): NamedDevice[] {
  const wanted = normalize(name);
  if (!wanted) return [];

  const devices = getDb().prepare('SELECT * FROM devices').all() as NamedDevice[];
  if (devices.some((d) => normalize(d.alias) === wanted)) return [];

  const room = devices.filter((d) => typeof d.room === 'string' && normalize(d.room) === wanted);
  if (room.length) return room;

  const group = devices.filter((d) =>
    namesOf(d).slice(1).some((nickname) => singular(normalize(nickname)) === singular(wanted)));
  return group.length > 1 ? group : [];
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

  // Only tried when nothing matched, so it can't change a name that already works.
  const loose = partial.length ? partial : devices.filter((d) =>
    deviceNames(d).some((n) => containsWords(lampAsLight(n), lampAsLight(wanted))));
  if (loose.length === 1) return { device: loose[0] };

  if (loose.length > 1) {
    const candidates = loose.map((d) => `"${d.alias}"`);
    return { error: `"${name}" could mean ${candidates.join(', ')}. Ask the user which one they mean.`, candidates };
  }
  return { error: `Device "${name}" not found. Use list_devices to see available devices.` };
}
