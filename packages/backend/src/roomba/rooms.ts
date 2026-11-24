/**
 * A Roomba's rooms, learned from jobs. The robot knows a room only by its number on a map; the
 * names people gave them live in iRobot's cloud. So when the robot reports a job for one room
 * (started from the iRobot app, say), HomeHub keeps that room, unnamed, and someone names it once.
 * Rooms are kept in the device's driver_config, so they're backed up with it and go when it does.
 */
import { getDb } from '../db';
import type { Region, RoomJob } from './protocol';

export interface VacuumRoom {
  /** "<map id>:<room id>": a room's id is only unique on its map, and a home can have one per floor. */
  key:    string;
  pmapId: string;
  id:     string;
  type:   string;
  name:   string | null;
  /** When a job for it was last seen. */
  seenAt: string;
}

interface RoombaConfig {
  blid?: string;
  password?: string;
  rooms?: VacuumRoom[];
  /** Each map's latest version, from the last job seen on it: a room job names the version it's for. */
  maps?: Record<string, string>;
  [k: string]: unknown;
}

export class RoomError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export const MAX_ROOM_NAME = 40;

const keyOf = (pmapId: string, id: string) => `${pmapId}:${id}`;

function read(deviceId: number): RoombaConfig {
  const row = getDb().prepare("SELECT driver_config FROM devices WHERE id = ? AND driver_type = 'roomba'").get(deviceId) as
    { driver_config: string | null } | undefined;
  if (!row) throw new RoomError('Robot vacuum not found', 404);
  try {
    return row.driver_config ? JSON.parse(row.driver_config) as RoombaConfig : {};
  } catch {
    return {};
  }
}

function write(deviceId: number, config: RoombaConfig): void {
  getDb().prepare('UPDATE devices SET driver_config = ? WHERE id = ?').run(JSON.stringify(config), deviceId);
}

/** The rooms for the device list: named ones by name, then unnamed ones newest first. No map details. */
export function roomsView(driverConfig: string | null): { key: string; name: string | null; seenAt: string }[] {
  let config: RoombaConfig = {};
  try { config = driverConfig ? JSON.parse(driverConfig) : {}; } catch { /* none */ }
  const rooms = Array.isArray(config.rooms) ? config.rooms : [];
  return [...rooms]
    .sort((a, b) => (a.name === null) !== (b.name === null) ? (a.name === null ? 1 : -1)
      : a.name !== null && b.name !== null ? a.name.localeCompare(b.name) : b.seenAt.localeCompare(a.seenAt))
    .map(({ key, name, seenAt }) => ({ key, name, seenAt }));
}

export const roomsOf = (deviceId: number): VacuumRoom[] => read(deviceId).rooms ?? [];

/**
 * Keeps what a job says: its map's version and, for a job of one room, that room. A job of several
 * rooms doesn't say which number is which room, so it teaches nothing new. True if anything changed.
 */
export function learnFromJob(deviceId: number, job: RoomJob, now = new Date()): boolean {
  const config = read(deviceId);
  const rooms = config.rooms ?? [];
  const maps = { ...(config.maps ?? {}) };
  let changed = false;
  if (job.versionId && maps[job.pmapId] !== job.versionId) { maps[job.pmapId] = job.versionId; changed = true; }
  const at = now.toISOString();
  for (const region of job.regions) {
    const known = rooms.find((r) => r.pmapId === job.pmapId && r.id === region.id);
    if (known) { known.seenAt = at; changed = true; continue; }
    if (job.regions.length !== 1) continue;
    rooms.push({ key: keyOf(job.pmapId, region.id), pmapId: job.pmapId, id: region.id, type: region.type, name: null, seenAt: at });
    changed = true;
  }
  if (changed) write(deviceId, { ...config, rooms, maps });
  return changed;
}

export function nameRoom(deviceId: number, key: string, name: unknown): VacuumRoom {
  if (typeof name !== 'string' || !name.trim()) throw new RoomError('Give the room a name');
  const clean = name.trim().replace(/\s+/g, ' ');
  if (clean.length > MAX_ROOM_NAME) throw new RoomError(`A room name can be up to ${MAX_ROOM_NAME} characters`);
  const config = read(deviceId);
  const rooms = config.rooms ?? [];
  const room = rooms.find((r) => r.key === key);
  if (!room) throw new RoomError('That room isn’t known any more', 404);
  const taken = rooms.find((r) => r !== room && r.name?.toLowerCase() === clean.toLowerCase());
  if (taken) throw new RoomError(`Another room is already called ${taken.name}`, 409);
  room.name = clean;
  write(deviceId, { ...config, rooms });
  return room;
}

export function removeRoom(deviceId: number, key: string): void {
  const config = read(deviceId);
  const rooms = (config.rooms ?? []).filter((r) => r.key !== key);
  if (rooms.length === (config.rooms ?? []).length) throw new RoomError('That room isn’t known any more', 404);
  write(deviceId, { ...config, rooms });
}

/** The job for these named rooms, in the order given. They must all be on one map. */
export function jobFor(deviceId: number, keys: string[]): { job: RoomJob; names: string[] } {
  if (!keys.length) throw new RoomError('Choose at least one room');
  const config = read(deviceId);
  const rooms = keys.map((k) => (config.rooms ?? []).find((r) => r.key === k && r.name));
  if (rooms.some((r) => !r)) throw new RoomError('That room isn’t known any more', 404);
  const chosen = rooms as VacuumRoom[];
  const pmapId = chosen[0].pmapId;
  if (chosen.some((r) => r.pmapId !== pmapId)) throw new RoomError('Those rooms are on different maps, so clean them separately');
  const regions: Region[] = [...new Map(chosen.map((r) => [r.key, { id: r.id, type: r.type }])).values()];
  return { job: { pmapId, versionId: config.maps?.[pmapId] ?? '', regions }, names: [...new Set(chosen.map((r) => r.name!))] };
}
