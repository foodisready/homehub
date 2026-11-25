/**
 * What a Sonos can be told to play: the household's Sonos Favorites and Sonos playlists, and
 * Spotify songs, albums and playlists by their share link.
 *
 * Everything here is read from the speakers themselves (their ContentDirectory), with no music
 * service login: Sonos already holds the accounts. Two ways to start something:
 *  - a station (radio, line-in) becomes the group's source directly;
 *  - anything else (a song, an album, a playlist) replaces the group's queue and plays it from the
 *    top, as "Replace queue" does in the Sonos app. It's added before the old queue is removed, so
 *    something Sonos refuses leaves the music as it was.
 * Both go to the group's coordinator, which owns the queue.
 */
import { SonosError, coverOf, decodeXml, escapeXml, isPlaying, soap, tagOf, transportState } from './protocol';
import { noteStationSeen } from './recent';

export interface Choice {
  /** The Sonos object id: "FV:2/3" for a favorite, "SQ:0" for a Sonos playlist. */
  id: string;
  title: string;
  /** What the Sonos app shows under it: the service, or an artist. */
  note: string | null;
  kind: 'favorite' | 'playlist';
  /** Its cover: a web image (https), or a path on the speaker ("/getaa?…") for /api/sonos/:id/art. */
  art: string | null;
}

/** A choice, with what the speaker needs to play it. */
export interface Playable extends Choice { uri: string; meta: string; station: boolean }

// ── Reading ────────────────────────────────────────────────────

const MAX_ITEMS = 500;

/** The DIDL entries (items and containers) directly under a ContentDirectory object, paged. */
export async function browse(ip: string, objectId: string): Promise<string[]> {
  const out: string[] = [];
  for (let start = 0; start < MAX_ITEMS;) {
    const res = await soap(ip, 'ContentDirectory', 'Browse', {
      ObjectID: objectId, BrowseFlag: 'BrowseDirectChildren', Filter: '*', StartingIndex: start, RequestedCount: 100, SortCriteria: '',
    });
    const didl = tagOf(res, 'Result') ?? '';
    const entries = [...didl.matchAll(/<(item|container)\s[^>]*>[\s\S]*?<\/\1>/g)].map((m) => m[0]);
    out.push(...entries);
    const returned = Number(tagOf(res, 'NumberReturned') ?? entries.length);
    const total = Number(tagOf(res, 'TotalMatches') ?? 0);
    start += returned;
    if (!returned || start >= total) break;
  }
  return out;
}

const attrOf = (entry: string, name: string) => {
  const open = /^<\w+\s([^>]*)>/.exec(entry)?.[1] ?? '';
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(open);
  return m ? decodeXml(m[1]) : null;
};

/** Stations and inputs: these become the source themselves, and can't go in a queue. */
const STATION_SCHEMES = new Set([
  'x-sonosapi-stream', 'x-sonosapi-radio', 'x-rincon-mp3radio', 'hls-radio', 'x-sonosapi-hls', 'aac', 'x-rincon-stream', 'x-sonos-htastream',
]);

export function isStation(uri: string, meta: string): boolean {
  return STATION_SCHEMES.has(uri.split(':')[0]) || /<upnp:class>object\.item\.audioItem\.audioBroadcast/.test(meta);
}

/** Its cover: a web image (https), or a picture on the speaker, shown through HomeHub. */
const artOf = (entry: string): string | null => coverOf(tagOf(entry, 'upnp:albumArtURI'));

export interface Favorites { items: Playable[]; /** Favorites that open a list in the Sonos app, with nothing to play themselves. */ shortcuts: number }

/** The household's Sonos Favorites, in the Sonos app's order. */
export function parseFavorites(entries: string[]): Favorites {
  const items: Playable[] = [];
  let shortcuts = 0;
  for (const e of entries) {
    const uri = (tagOf(e, 'res') ?? '').trim();
    const id = attrOf(e, 'id');
    const title = tagOf(e, 'dc:title')?.trim();
    if (!id || !title) continue;
    if (!uri || tagOf(e, 'r:type') === 'shortcut') { shortcuts++; continue; }
    const meta = tagOf(e, 'r:resMD') ?? '';
    items.push({ id, title, note: tagOf(e, 'r:description')?.trim() || null, kind: 'favorite', art: artOf(e), uri, meta, station: isStation(uri, meta) });
  }
  return { items, shortcuts };
}

/** The metadata Sonos wants alongside a saved Sonos playlist when it's queued. */
const playlistMeta = (id: string, title: string) =>
  `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">`
  + `<item id="${escapeXml(id)}" parentID="SQ:" restricted="true"><dc:title>${escapeXml(title)}</dc:title><upnp:class>object.container.playlistContainer</upnp:class>`
  + '<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">RINCON_AssociatedZPUDN</desc></item></DIDL-Lite>';

/** The household's Sonos playlists (made in the Sonos app). */
export function parsePlaylists(entries: string[]): Playable[] {
  const out: Playable[] = [];
  for (const e of entries) {
    const id = attrOf(e, 'id');
    const uri = (tagOf(e, 'res') ?? '').trim();
    const title = tagOf(e, 'dc:title')?.trim();
    if (!id || !uri || !title) continue;
    out.push({ id, title, note: 'Sonos playlist', kind: 'playlist', art: artOf(e), uri, meta: playlistMeta(id, title), station: false });
  }
  return out;
}

export interface Library { favorites: Playable[]; playlists: Playable[]; shortcuts: number }

/** Favorites and playlists belong to the whole Sonos household, so any of its speakers can answer. */
export async function libraryOf(ip: string): Promise<Library> {
  const [fav, lists] = await Promise.all([browse(ip, 'FV:2'), browse(ip, 'SQ:')]);
  const { items, shortcuts } = parseFavorites(fav);
  return { favorites: items, playlists: parsePlaylists(lists), shortcuts };
}

/** What a saved choice is now: by its id when its name still matches, else by its name (ids change when favorites are re-made). */
export function findChoice(library: Library, wanted: { id: string; title?: string | null }): Playable | null {
  const all = [...library.favorites, ...library.playlists];
  const byId = all.find((c) => c.id === wanted.id);
  if (byId && (!wanted.title || byId.title === wanted.title)) return byId;
  if (wanted.title) {
    const sameKind = all.filter((c) => c.title === wanted.title && c.id.split('/')[0].split(':')[0] === wanted.id.split('/')[0].split(':')[0]);
    if (sameKind.length) return sameKind[0];
  }
  return wanted.title ? null : byId ?? null;
}

/** Radio stations, not a line-in or a TV, which are sources too but nothing to play again. */
const NOT_RADIO = new Set(['x-rincon-stream', 'x-sonos-htastream']);

/** Notes a radio station a group is playing, however it was started, for Recently played. */
export async function noteStation(leaderIp: string): Promise<void> {
  const media = await soap(leaderIp, 'AVTransport', 'GetMediaInfo', { InstanceID: 0 });
  const uri = (tagOf(media, 'CurrentURI') ?? '').trim();
  const meta = tagOf(media, 'CurrentURIMetaData') ?? '';
  if (!uri || NOT_RADIO.has(uri.split(':')[0]) || !isStation(uri, meta)) return;
  if (!isPlaying(await transportState(leaderIp))) return;
  const title = tagOf(meta, 'dc:title')?.trim();
  if (!title || /^x-(sonos|rincon)/.test(title)) return;
  noteStationSeen(uri, meta, title, coverOf(tagOf(meta, 'upnp:albumArtURI')));
}

// ── Playing ────────────────────────────────────────────────────

/**
 * Starts something on a group, through its coordinator. A station becomes the source; anything
 * else replaces the queue and plays from its first track.
 */
export async function playOn(leaderIp: string, coordinatorUuid: string, p: Pick<Playable, 'uri' | 'meta' | 'station'>): Promise<void> {
  if (p.station) {
    await soap(leaderIp, 'AVTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: p.uri, CurrentURIMetaData: p.meta });
  } else {
    if (!coordinatorUuid) throw new SonosError('Couldn’t tell which speaker holds the queue', 'FAILED');
    // Added at the end first: if Sonos refuses it (a service that's closed, or signed out), the
    // queue and what's playing are left as they were. Only then do the old tracks go.
    const added = await soap(leaderIp, 'AVTransport', 'AddURIToQueue', {
      InstanceID: 0, EnqueuedURI: p.uri, EnqueuedURIMetaData: p.meta, DesiredFirstTrackNumberEnqueued: 0, EnqueueAsNext: 0,
    });
    const first = Number(tagOf(added, 'FirstTrackNumberEnqueued'));
    if (first > 1) {
      await soap(leaderIp, 'AVTransport', 'RemoveTrackRangeFromQueue', { InstanceID: 0, UpdateID: 0, StartingIndex: 1, NumberOfTracks: first - 1 });
    }
    await soap(leaderIp, 'AVTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: `x-rincon-queue:${coordinatorUuid}#0`, CurrentURIMetaData: '' });
    // From the top. Play starts there anyway on a fresh queue, so a refusal here isn't fatal.
    await soap(leaderIp, 'AVTransport', 'Seek', { InstanceID: 0, Unit: 'TRACK_NR', Target: 1 }).catch(() => undefined);
  }
  await soap(leaderIp, 'AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
}

// ── The queue ──────────────────────────────────────────────────

export interface QueueSong { n: number; title: string; artist: string | null; album: string | null; art: string | null }
export interface QueuePage {
  /** Songs in the queue. */
  total: number;
  /** The first song's number on this page (1 is the first in the queue). */
  start: number;
  songs: QueueSong[];
  /** The song playing, by number, when the group is playing its queue; null for a station or another source. */
  current: number | null;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
}

/** Songs per page. */
export const QUEUE_PAGE = 50;

const MODES: Record<string, { shuffle: boolean; repeat: 'off' | 'all' | 'one' }> = {
  NORMAL: { shuffle: false, repeat: 'off' }, REPEAT_ALL: { shuffle: false, repeat: 'all' }, REPEAT_ONE: { shuffle: false, repeat: 'one' },
  SHUFFLE_NOREPEAT: { shuffle: true, repeat: 'off' }, SHUFFLE: { shuffle: true, repeat: 'all' }, SHUFFLE_REPEAT_ONE: { shuffle: true, repeat: 'one' },
};

export function playModeOf(mode: string): { shuffle: boolean; repeat: 'off' | 'all' | 'one' } {
  return MODES[mode] ?? MODES['NORMAL'];
}

export function playModeFor(shuffle: boolean, repeat: 'off' | 'all' | 'one'): string {
  return Object.entries(MODES).find(([, v]) => v.shuffle === shuffle && v.repeat === repeat)![0];
}

/**
 * A page of the group's queue, from its coordinator: by default the page with the song playing.
 * `start` (0-based) asks for another page.
 */
export async function queuePage(leaderIp: string, start?: number): Promise<QueuePage> {
  const [media, position, settings] = await Promise.all([
    soap(leaderIp, 'AVTransport', 'GetMediaInfo', { InstanceID: 0 }),
    soap(leaderIp, 'AVTransport', 'GetPositionInfo', { InstanceID: 0 }),
    soap(leaderIp, 'AVTransport', 'GetTransportSettings', { InstanceID: 0 }).catch(() => ''),
  ]);
  const fromQueue = /^x-rincon-queue:/.test((tagOf(media, 'CurrentURI') ?? '').trim());
  const track = Number(tagOf(position, 'Track')) || 0;
  const current = fromQueue && track > 0 ? track : null;
  const first = start ?? (current ? Math.floor((current - 1) / QUEUE_PAGE) * QUEUE_PAGE : 0);
  const res = await soap(leaderIp, 'ContentDirectory', 'Browse', {
    ObjectID: 'Q:0', BrowseFlag: 'BrowseDirectChildren', Filter: '*', StartingIndex: Math.max(0, first), RequestedCount: QUEUE_PAGE, SortCriteria: '',
  });
  const didl = tagOf(res, 'Result') ?? '';
  const songs = [...didl.matchAll(/<item\s[^>]*>[\s\S]*?<\/item>/g)].map((m, i): QueueSong => ({
    n: Math.max(0, first) + i + 1,
    title: tagOf(m[0], 'dc:title')?.trim() || 'Untitled',
    artist: tagOf(m[0], 'dc:creator')?.trim() || null,
    album: tagOf(m[0], 'upnp:album')?.trim() || null,
    art: coverOf(tagOf(m[0], 'upnp:albumArtURI')),
  }));
  return { total: Number(tagOf(res, 'TotalMatches') ?? songs.length), start: Math.max(0, first) + 1, songs, current, ...playModeOf(tagOf(settings, 'PlayMode') ?? 'NORMAL') };
}

/** Plays song `n` of the group's queue, switching the group to its queue first if it was on something else. */
export async function playQueueSong(leaderIp: string, coordinatorUuid: string, n: number): Promise<void> {
  const media = await soap(leaderIp, 'AVTransport', 'GetMediaInfo', { InstanceID: 0 });
  if (!/^x-rincon-queue:/.test((tagOf(media, 'CurrentURI') ?? '').trim())) {
    await soap(leaderIp, 'AVTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: `x-rincon-queue:${coordinatorUuid}#0`, CurrentURIMetaData: '' });
  }
  await soap(leaderIp, 'AVTransport', 'Seek', { InstanceID: 0, Unit: 'TRACK_NR', Target: n });
  await soap(leaderIp, 'AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
}

/** Shuffle and repeat for the group. */
export async function setPlayMode(leaderIp: string, shuffle: boolean, repeat: 'off' | 'all' | 'one'): Promise<void> {
  await soap(leaderIp, 'AVTransport', 'SetPlayMode', { InstanceID: 0, NewPlayMode: playModeFor(shuffle, repeat) });
}

// ── Spotify ────────────────────────────────────────────────────

export type SpotifyKind = 'track' | 'album' | 'playlist';
export interface SpotifyLink { kind: SpotifyKind; id: string }

/**
 * A Spotify song, album or playlist from what Spotify's Share gives: an open.spotify.com link
 * (with or without "?si=…" or a language part), or a spotify: address. Null for anything else.
 */
export function parseSpotifyLink(text: string): SpotifyLink | null {
  const t = text.trim();
  const web = /^(?:https?:\/\/)?open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(?:embed\/)?(track|album|playlist)\/([A-Za-z0-9]{22})(?:[/?#][^\s]*)?$/i.exec(t);
  const uri = /^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/.exec(t);
  const m = web ?? uri;
  return m ? { kind: m[1].toLowerCase() as SpotifyKind, id: m[2] } : null;
}

/** The Spotify account Sonos holds: its service id ("sid") and account number ("sn"). */
export interface SpotifyAccount { sid: number; sn: number }

/** Finds Spotify in what Sonos says ("…spotify%3atrack…?sid=12&…&sn=3"). */
export function spotifyAccountIn(text: string): SpotifyAccount | null {
  const plain = decodeXml(decodeXml(text));
  for (const m of plain.matchAll(/(?:x-sonos-spotify:|spotify%3a)[^\s"<>]*?[?&]sid=(\d+)[^\s"<>]*?[&;]sn=(\d+)/gi)) {
    return { sid: Number(m[1]), sn: Number(m[2]) };
  }
  return null;
}

/**
 * Which Spotify account to play with: learned from something Spotify the household has played or
 * saved. What's playing now first (the freshest), then the queue, then the favorites. Null when
 * nothing Spotify is anywhere.
 */
export async function spotifyAccountOf(leaderIp: string): Promise<SpotifyAccount | null> {
  const sources: (() => Promise<string>)[] = [
    () => soap(leaderIp, 'AVTransport', 'GetPositionInfo', { InstanceID: 0 }),
    async () => (await browse(leaderIp, 'Q:0')).join(''),
    async () => (await browse(leaderIp, 'FV:2')).join(''),
  ];
  for (const read of sources) {
    try {
      const found = spotifyAccountIn(await read());
      if (found) return found;
    } catch (err) {
      if (err instanceof SonosError && err.code === 'UNREACHABLE') throw err;
    }
  }
  return null;
}

/**
 * How Sonos plays a Spotify link: the same addresses and metadata the Sonos app uses. The
 * service type in the metadata is the account's sid × 256 + 7 (3079 for sid 12).
 */
export function spotifyPlayable(link: SpotifyLink, account: SpotifyAccount): Pick<Playable, 'uri' | 'meta' | 'station'> {
  const encoded = `spotify%3a${link.kind}%3a${link.id}`;
  const service = account.sid * 256 + 7;
  const shape = {
    track: { uri: `x-sonos-spotify:${encoded}?sid=${account.sid}&flags=8224&sn=${account.sn}`, itemId: `00032020${encoded}`, cls: 'object.item.audioItem.musicTrack' },
    album: { uri: `x-rincon-cpcontainer:1004206c${encoded}`, itemId: `1004206c${encoded}`, cls: 'object.container.album.musicAlbum' },
    playlist: { uri: `x-rincon-cpcontainer:1006206c${encoded}`, itemId: `1006206c${encoded}`, cls: 'object.container.playlistContainer' },
  }[link.kind];
  const meta = '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">'
    + `<item id="${shape.itemId}" parentID="" restricted="true"><dc:title></dc:title><upnp:class>${shape.cls}</upnp:class>`
    + `<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON${service}_X_#Svc${service}-0-Token</desc></item></DIDL-Lite>`;
  return { uri: shape.uri, meta, station: false };
}
