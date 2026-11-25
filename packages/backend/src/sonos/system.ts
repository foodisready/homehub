/**
 * The whole sound system at once: which rooms play together, what each group is playing, and the
 * volumes; and choosing which rooms a group plays in. Rooms are the Sonos speakers added to
 * HomeHub; a group's other rooms (speakers not added) are named but can't be chosen.
 */
import { getDb } from '../db';
import {
  SonosError, groupVolumeOf, handOver, isPlaying, joinGroup, leaveGroup, nowPlaying, parseGroups, soap, transportState, volumeOf,
  type Group, type NowPlaying,
} from './protocol';
import { logger } from '../logger';
import { noteStation } from './music';

interface SpeakerRow { id: number; alias: string; ip: string; online?: number; driver_config: string | null }

export interface SystemRoom {
  /** The HomeHub device; null for a Sonos room not added to HomeHub. */
  deviceId: number | null;
  name: string;
  volume: number | null;
  muted: boolean;
}

export interface SystemGroup {
  /** The coordinator's Sonos id: stays the group's while it leads. */
  id: string;
  /** The device to send play, pause, skip and music to (any room of the group works; this is its leader when known). */
  deviceId: number;
  rooms: SystemRoom[];
  playing: boolean;
  nowPlaying: NowPlaying;
  /** The group's volume, when more than one room plays. */
  groupVolume: number | null;
}

export interface SoundSystem {
  groups: SystemGroup[];
  /** Speakers added to HomeHub that didn't answer. */
  unreachable: { deviceId: number; name: string }[];
}

const uuidOf = (s: SpeakerRow): string => {
  try { const c = s.driver_config ? JSON.parse(s.driver_config) : null; return typeof c?.uuid === 'string' ? c.uuid : ''; } catch { return ''; }
};

export function speakers(): SpeakerRow[] {
  return getDb().prepare("SELECT id, alias, ip, driver_config FROM devices WHERE driver_type = 'sonos' ORDER BY alias").all() as SpeakerRow[];
}

/** The groups, from the first speaker that answers. */
async function topology(rows: SpeakerRow[]): Promise<Group[]> {
  let last: unknown = null;
  for (const s of rows) {
    try { return parseGroups(await soap(s.ip, 'ZoneGroupTopology', 'GetZoneGroupState')); } catch (err) { last = err; }
  }
  throw last ?? new SonosError('No speakers', 'UNREACHABLE');
}

/** Which HomeHub speaker is this Sonos member: by its saved id, else by its address. */
function rowFor(rows: SpeakerRow[], m: { uuid: string; ip: string | null }): SpeakerRow | undefined {
  return rows.find((r) => uuidOf(r) === m.uuid) ?? (m.ip ? rows.find((r) => r.ip === m.ip) : undefined);
}

export async function soundSystem(): Promise<SoundSystem> {
  const rows = speakers();
  if (!rows.length) return { groups: [], unreachable: [] };
  const groups = await topology(rows);
  const seen = new Set<number>();
  const out = await Promise.all(groups.map(async (g): Promise<SystemGroup | null> => {
    const members = g.members.map((m) => ({ m, row: rowFor(rows, m) }));
    const known = members.filter((x) => x.row);
    if (!known.length) return null;
    for (const x of known) seen.add(x.row!.id);
    const leader = members.find((x) => x.m.uuid === g.coordinator);
    const leaderIp = leader?.m.ip ?? known[0].row!.ip;
    noteStation(leaderIp).catch(() => undefined);
    const [state, track, groupVolume, volumes] = await Promise.all([
      transportState(leaderIp).catch(() => 'STOPPED'),
      nowPlaying(leaderIp).catch(() => ({ title: null, artist: null, album: null })),
      members.length > 1 ? groupVolumeOf(leaderIp).catch(() => null) : Promise.resolve(null),
      Promise.all(members.map((x) => (x.m.ip ? volumeOf(x.m.ip).catch(() => null) : Promise.resolve(null)))),
    ]);
    // The leader first, then the rest by name.
    const order = members.map((x, i) => ({ ...x, v: volumes[i] }))
      .sort((a, b) => Number(b.m.uuid === g.coordinator) - Number(a.m.uuid === g.coordinator) || (a.row?.alias ?? a.m.room).localeCompare(b.row?.alias ?? b.m.room));
    return {
      id: g.coordinator,
      deviceId: (leader?.row ?? known[0].row!).id,
      rooms: order.map((x) => ({ deviceId: x.row?.id ?? null, name: x.row?.alias ?? `${x.m.room} (not in HomeHub)`, volume: x.v?.volume ?? null, muted: x.v?.muted ?? false })),
      playing: isPlaying(state),
      nowPlaying: track,
      groupVolume: members.length > 1 ? groupVolume : null,
    };
  }));
  const list = out.filter((g): g is SystemGroup => !!g)
    // Playing first, then by name.
    .sort((a, b) => Number(b.playing) - Number(a.playing) || a.rooms[0].name.localeCompare(b.rooms[0].name));
  return { groups: list, unreachable: rows.filter((r) => !seen.has(r.id)).map((r) => ({ deviceId: r.id, name: r.alias })) };
}

export class PlayOnError extends Error {}

/**
 * Makes the group that `deviceId` is in play in exactly these rooms (HomeHub speakers). Rooms are
 * joined first, so the music never stops in a room that stays; when the group's leader isn't
 * among them, the music is handed to one that is; then the rooms left out leave (and stop).
 */
export async function setPlayOn(deviceId: number, roomIds: number[]): Promise<void> {
  const rows = speakers();
  const me = rows.find((r) => r.id === deviceId);
  if (!me) throw new PlayOnError('Speaker not found');
  const wanted = [...new Set(roomIds)].map((id) => rows.find((r) => r.id === id));
  if (!wanted.length || wanted.some((w) => !w)) throw new PlayOnError('Choose at least one speaker, from those added to HomeHub');
  const target = wanted as SpeakerRow[];

  const groups = await topology(rows);
  const meUuid = uuidOf(me);
  const group = groups.find((g) => g.members.some((m) => m.uuid === meUuid || m.ip === me.ip));
  if (!group) throw new SonosError(`Couldn’t find ${me.alias} among the Sonos groups`, 'UNREACHABLE');
  const coordinator = group.members.find((m) => m.uuid === group.coordinator);
  if (!coordinator?.ip) throw new SonosError('Couldn’t reach the group’s leader', 'UNREACHABLE');
  const inGroup = (r: SpeakerRow) => group.members.some((m) => m.uuid === uuidOf(r) || m.ip === r.ip);
  const targetUuids = new Set(target.map(uuidOf));

  // 1. Rooms to add join the group.
  for (const r of target.filter((t) => !inGroup(t))) {
    await joinGroup(r.ip, group.coordinator);
    logger.info({ deviceId: r.id, alias: r.alias }, 'Sonos room joined a group');
  }
  // 2. The leader isn't wanted: the music moves to a wanted room, and the old leader leaves.
  let leaderUuid = group.coordinator;
  if (!targetUuids.has(group.coordinator)) {
    const heir = target[0];
    await handOver(coordinator.ip, uuidOf(heir));
    leaderUuid = uuidOf(heir);
    logger.info({ to: heir.alias }, 'Sonos group handed over');
  }
  // 3. The rest of the old group that isn't wanted leaves.
  for (const m of group.members) {
    if (m.uuid === leaderUuid || m.uuid === group.coordinator || targetUuids.has(m.uuid) || !m.ip) continue;
    if (!rowFor(rows, m)) continue; // A room not in HomeHub is left as it is.
    await leaveGroup(m.ip);
    logger.info({ room: m.room }, 'Sonos room left a group');
  }
}
