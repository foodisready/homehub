import { getDb } from '../db';
import { isProtectedDevice, type PowerDevice } from '../devices/power';

export interface NamedDevice {
  id:    number;
  alias: string;
  [column: string]: unknown;
}

export type DeviceMatch =
  | { device: NamedDevice }
  | { error: string; candidates?: string[] };

/** A name as HomeHub compares it: lower case, no possessive 's, no leading my or the. */
export const normalize = (name: string) =>
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

/** Each device's names, as typed: its alias, then its nicknames. */
export function listDeviceNameGroups(): string[][] {
  const devices = getDb().prepare('SELECT * FROM devices').all() as NamedDevice[];
  return devices.map(namesOf);
}

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

const parseNames = (value: unknown): string[] => {
  try {
    const list = JSON.parse(String(value ?? '[]'));
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
};

/** Scene names and the extra names taught for them. */
export function listSceneNames(): string[] {
  const scenes = getDb().prepare('SELECT name, nicknames FROM scenes').all() as { name: string; nicknames: string | null }[];
  return scenes.flatMap((scene) => [scene.name, ...parseNames(scene.nicknames)]);
}

/** Finds a scene by its whole name or a taught name. A scene can switch many devices, so nothing partial counts. */
export function findScene(name: string): NamedScene | null {
  const wanted = sceneKey(name);
  if (!wanted) return null;
  const scenes = getDb().prepare('SELECT id, name, nicknames FROM scenes').all() as (NamedScene & { nicknames: string | null })[];
  const found = scenes.find((scene) => sceneKey(scene.name) === wanted)
    ?? scenes.find((scene) => parseNames(scene.nicknames).some((n) => sceneKey(n) === wanted));
  return found ? { id: found.id, name: found.name } : null;
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
  if (group.length > 1) return group;

  return roomLights(wanted, name, devices);
}

/** A room's name, and the name without "room": "Brenden's room" is also "Brenden's". */
const roomKeys = (room: string) => {
  const key = normalize(room);
  return [key, key.replace(/\s+room$/, '')].filter(Boolean);
};

/** Names that say a device isn't a light, so "<room> lights" leaves it alone. */
export const NOT_A_LIGHT = /\b(?:fans?|heaters?|tvs?|television|valves?|doors?|garage|pumps?|cameras?|cams?|speakers?|chargers?|ac|air|humidifiers?|dehumidifiers?|purifiers?|kettles?|coffee|printers?|routers?|plugs?)\b/i;

/**
 * "Brenden's lights", "kitchen lamps": the lights in a room, meaning every
 * device there that isn't protected and isn't named as something else, such
 * as a fan. Speech recognition often hears "light" for "lights", so the
 * singular counts too, unless the name already fits one device ("my office
 * light").
 */
function roomLights(wanted: string, spoken: string, devices: NamedDevice[]): NamedDevice[] {
  const match = wanted.match(/^(.+?)\s+(?:lights?|lamps?)$/);
  if (!match) return [];
  const place = match[1];
  const inRoom = devices.filter((d) => typeof d.room === 'string' && roomKeys(d.room).includes(place));
  if (!inRoom.length) return [];
  if ('device' in findDeviceByName(spoken)) return [];
  return inRoom.filter((d) => !NOT_A_LIGHT.test(d.alias) && !isProtectedDevice(d as unknown as PowerDevice));
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
