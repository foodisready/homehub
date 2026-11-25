import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import {
  SonosError, groupOf, isPlaying, nowPlaying, pause, play, setMute, setVolume, skip, stepVolume, transportState, volumeOf,
  type NowPlaying,
} from '../sonos/protocol';
import { groupLeadOf, leaderFor, playChoice, speakerUuidOf } from '../drivers/SonosDriver';
import { libraryOf, parseSpotifyLink, playOn, spotifyAccountOf, spotifyPlayable, type Choice, type SpotifyLink } from '../sonos/music';
import { noteState } from '../kasa/device.cache';
import { emitDeviceState } from '../socket';
import { logger } from '../logger';
import { PlayOnError, setPlayOn, soundSystem, speakers, type SoundSystem } from '../sonos/system';
import { coverOf, sonosPort, stepGroupVolume } from '../sonos/protocol';
import { noteRecent, recentFor, recentList } from '../sonos/recent';
import { getCachedState } from '../kasa/device.cache';

export const sonosRouter = Router();

/** One tap of − or + on the remote. */
export const VOLUME_STEP = 2;

/** How long the remote waits after a skip or a start before reading the speaker again. */
let routeWaitMs = 800;
export function setRouteWaitForTests(ms: number): void { routeWaitMs = ms; }

interface SpeakerRow { id: number; alias: string; ip: string; driver_config: string | null }

export interface SonosRemote {
  playing: boolean;
  nowPlaying: NowPlaying;
  volume: number;
  muted: boolean;
  /** The other rooms it's playing with, when it's in a group. */
  groupedWith: string[];
}

function speakerFor(req: Request): SpeakerRow | undefined {
  return getDb().prepare("SELECT id, alias, ip, driver_config FROM devices WHERE id = ? AND driver_type = 'sonos'")
    .get(req.params.id) as SpeakerRow | undefined;
}

const configOf = (s: SpeakerRow) => { try { return s.driver_config ? JSON.parse(s.driver_config) : undefined; } catch { return undefined; } };

async function remoteOf(s: SpeakerRow): Promise<SonosRemote> {
  const config = configOf(s);
  const uuid = speakerUuidOf(config);
  const group = uuid ? await groupOf(s.ip, uuid).catch(() => null) : null;
  const leaderIp = group?.members.find((m) => m.uuid === group.coordinator)?.ip ?? s.ip;
  const [state, track, volume] = await Promise.all([
    transportState(leaderIp),
    nowPlaying(leaderIp).catch(() => ({ title: null, artist: null, album: null })),
    volumeOf(s.ip),
  ]);
  return {
    playing: isPlaying(state),
    nowPlaying: track,
    ...volume,
    groupedWith: group ? group.members.filter((m) => m.uuid !== uuid).map((m) => m.room) : [],
  };
}

type SonosAction =
  | { kind: 'play' | 'pause' | 'next' | 'previous' } | { kind: 'volume'; level: number } | { kind: 'step'; by: number } | { kind: 'mute'; on: boolean }
  | { kind: 'choose'; id: string; title: string | null } | { kind: 'spotify'; link: SpotifyLink } | { kind: 'recent'; key: string };

/** Reads a remote button from a request body; a message for a bad one. */
export function sonosActionOf(body: Record<string, unknown>): SonosAction | string {
  const { action, volume, step, mute, choose, spotify, recent } = body;
  if (recent !== undefined) {
    if (typeof recent !== 'string' || !recent || recent.length > 300) return 'recent must be an item from Recently played';
    return { kind: 'recent', key: recent };
  }
  if (choose !== undefined) {
    const c = choose as { id?: unknown; title?: unknown } | null;
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !/^(FV:2\/\d+|SQ:\d+)$/.test(c.id)) return 'choose must be a favorite or playlist from the list';
    if (c.title !== undefined && (typeof c.title !== 'string' || c.title.length > 200)) return 'choose.title must be text';
    return { kind: 'choose', id: c.id, title: typeof c.title === 'string' ? c.title : null };
  }
  if (spotify !== undefined) {
    const link = typeof spotify === 'string' && spotify.length <= 500 ? parseSpotifyLink(spotify) : null;
    if (!link) return 'That isn’t a Spotify song, album or playlist link. In Spotify, use Share → Copy link.';
    return { kind: 'spotify', link };
  }
  if (action !== undefined) {
    if (action === 'play' || action === 'pause' || action === 'next' || action === 'previous') return { kind: action };
    return 'action must be play, pause, next or previous';
  }
  if (volume !== undefined) {
    if (typeof volume !== 'number' || !Number.isInteger(volume) || volume < 0 || volume > 100) return 'volume must be a whole number from 0 to 100';
    return { kind: 'volume', level: volume };
  }
  if (step !== undefined) {
    if (step !== 'up' && step !== 'down') return 'step must be "up" or "down"';
    return { kind: 'step', by: step === 'up' ? VOLUME_STEP : -VOLUME_STEP };
  }
  if (mute !== undefined) {
    if (typeof mute !== 'boolean') return 'mute must be true or false';
    return { kind: 'mute', on: mute };
  }
  return 'Say what to do: action, volume, step or mute';
}

function failure(res: Response, s: SpeakerRow, err: unknown) {
  if (err instanceof SonosError && err.code === 'UNREACHABLE') {
    logger.warn({ id: s.id, reason: err.message }, 'Could not reach Sonos');
    return res.status(503).json({ error: `Couldn’t reach ${s.alias}.`, code: 'DEVICE_UNREACHABLE' });
  }
  if (err instanceof SonosError && (err.code === 'GONE' || err.code === 'NO_SPOTIFY')) {
    return res.status(409).json({ error: err.message, code: err.code });
  }
  if (err instanceof SonosError && err.code === 'NOTHING_TO_PLAY') {
    return res.status(409).json({ error: 'There’s nothing to play on it yet. Choose a favorite below, or start some music in the Sonos app.', code: 'NOTHING_TO_PLAY' });
  }
  // Skipping on the radio, or in a source that doesn't allow it.
  if (err instanceof SonosError && err.upnpCode === 711) return res.status(409).json({ error: 'What’s playing can’t skip.', code: 'DEVICE_REFUSED' });
  logger.warn({ id: s.id, reason: (err as Error).message }, 'Sonos refused');
  if (err instanceof SonosError && /^Sonos couldn’t play/.test(err.message)) return res.status(502).json({ error: err.message, code: 'DEVICE_REFUSED' });
  return res.status(502).json({ error: `${s.alias} didn’t do that. What’s playing may not allow it.`, code: 'DEVICE_REFUSED' });
}

/** Each room's switch follows its group: a room taken out of the music stops, one added plays. */
function syncSwitches(system: SoundSystem): void {
  for (const g of system.groups) {
    for (const r of g.rooms) {
      if (r.deviceId === null || getCachedState(r.deviceId)?.state === g.playing) continue;
      noteState(r.deviceId, g.playing);
      emitDeviceState(r.deviceId, r.name, g.playing, null);
    }
  }
}

/** GET /api/sonos/system — every group of rooms: what it's playing, its rooms and their volumes. */
sonosRouter.get('/system', async (_req: Request, res: Response) => {
  try {
    res.json(await soundSystem());
  } catch (err) {
    if (err instanceof SonosError && err.code === 'UNREACHABLE') return res.status(503).json({ error: 'Couldn’t reach any Sonos speaker.', code: 'DEVICE_UNREACHABLE' });
    logger.warn({ reason: (err as Error).message }, 'Could not read the Sonos system');
    res.status(502).json({ error: 'Couldn’t read the Sonos system. Try again.', code: 'DEVICE_REFUSED' });
  }
});

/**
 * POST /api/sonos/:id/play-on { rooms: deviceId[] } | { everywhere: true } — the rooms the music of
 * this speaker's group plays in. Answers with the whole system afterwards.
 */
sonosRouter.post('/:id/play-on', async (req: Request, res: Response) => {
  const s = speakerFor(req);
  if (!s) return res.status(404).json({ error: 'Speaker not found', code: 'DEVICE_NOT_FOUND' });
  const { rooms, everywhere } = (req.body ?? {}) as { rooms?: unknown; everywhere?: unknown };
  let ids: number[];
  if (everywhere === true) ids = [s.id, ...speakers().map((r) => r.id).filter((id) => id !== s.id)];
  else if (Array.isArray(rooms) && rooms.length && rooms.length <= 32 && rooms.every((r) => Number.isInteger(r))) ids = rooms as number[];
  else return res.status(400).json({ error: 'rooms must list at least one speaker, or set everywhere', code: 'VALIDATION_ERROR' });
  try {
    await setPlayOn(s.id, ids);
    logger.info({ id: s.id, rooms: ids, by: req.user?.sub }, 'Sonos rooms chosen');
    // Sonos takes a moment to show the new groups.
    await new Promise((r) => setTimeout(r, routeWaitMs));
    const system = await soundSystem();
    syncSwitches(system);
    res.json(system);
  } catch (err) {
    if (err instanceof PlayOnError) return res.status(400).json({ error: err.message, code: 'VALIDATION_ERROR' });
    failure(res, s, err);
  }
});

/** POST /api/sonos/:id/group-volume { step: "up" | "down" } — the whole group's volume. Answers with the system. */
sonosRouter.post('/:id/group-volume', async (req: Request, res: Response) => {
  const s = speakerFor(req);
  if (!s) return res.status(404).json({ error: 'Speaker not found', code: 'DEVICE_NOT_FOUND' });
  const step = (req.body ?? {}).step;
  if (step !== 'up' && step !== 'down') return res.status(400).json({ error: 'step must be "up" or "down"', code: 'VALIDATION_ERROR' });
  try {
    await stepGroupVolume(await leaderFor(s.ip, configOf(s)), step === 'up' ? VOLUME_STEP : -VOLUME_STEP);
    res.json(await soundSystem());
  } catch (err) {
    failure(res, s, err);
  }
});

/** Biggest cover passed on. */
const MAX_ART_BYTES = 3 * 1024 * 1024;

/**
 * GET /api/sonos/:id/art?u=/getaa?… — a cover kept on the speaker. The phone can't fetch it itself
 * (the speaker isn't on https, and may not be reachable), so HomeHub passes it on. Only the
 * speaker's own picture paths, from that speaker.
 */
sonosRouter.get('/:id/art', async (req: Request, res: Response) => {
  const s = speakerFor(req);
  if (!s) return res.status(404).json({ error: 'Speaker not found', code: 'DEVICE_NOT_FOUND' });
  const u = typeof req.query.u === 'string' ? req.query.u : '';
  if (!coverOf(u) || !u.startsWith('/')) return res.status(400).json({ error: 'u must be a picture path on the speaker', code: 'VALIDATION_ERROR' });
  try {
    const r = await fetch(`http://${s.ip}:${sonosPort()}${u}`, { signal: AbortSignal.timeout(6000), redirect: 'error' });
    const type = r.headers.get('content-type') ?? '';
    if (!r.ok || !/^image\//i.test(type)) return res.status(404).json({ error: 'No picture', code: 'NOT_FOUND' });
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > MAX_ART_BYTES) return res.status(404).json({ error: 'Picture too big', code: 'NOT_FOUND' });
    res.set({ 'content-type': type, 'cache-control': 'private, max-age=86400' }).send(body);
  } catch {
    res.status(404).json({ error: 'No picture', code: 'NOT_FOUND' });
  }
});

/** GET /api/sonos/:id/remote — playing or not, what's on, the volume, and the group it's in. */
sonosRouter.get('/:id/remote', async (req: Request, res: Response) => {
  const s = speakerFor(req);
  if (!s) return res.status(404).json({ error: 'Speaker not found', code: 'DEVICE_NOT_FOUND' });
  try {
    res.json(await remoteOf(s));
  } catch (err) {
    failure(res, s, err);
  }
});

export interface SonosLibrary {
  favorites: Choice[];
  playlists: Choice[];
  /** Favorites that only open a list in the Sonos app, so aren't offered. */
  shortcuts: number;
}

const toChoice = ({ id, title, note, kind, art }: Choice): Choice => ({ id, title, note, kind, art });

/** GET /api/sonos/recent — what played recently, newest first, to play again. */
sonosRouter.get('/recent', (_req: Request, res: Response) => {
  res.json(recentList());
});

/** GET /api/sonos/:id/library — the household's Sonos Favorites and Sonos playlists, to choose from. */
sonosRouter.get('/:id/library', async (req: Request, res: Response) => {
  const s = speakerFor(req);
  if (!s) return res.status(404).json({ error: 'Speaker not found', code: 'DEVICE_NOT_FOUND' });
  try {
    const lib = await libraryOf(s.ip);
    const body: SonosLibrary = { favorites: lib.favorites.map(toChoice), playlists: lib.playlists.map(toChoice), shortcuts: lib.shortcuts };
    res.json(body);
  } catch (err) {
    failure(res, s, err);
  }
});

/** Plays a Spotify link on the speaker's group, with the Spotify account Sonos already has. */
async function playSpotify(s: SpeakerRow, config: Record<string, unknown> | undefined, link: SpotifyLink): Promise<void> {
  const { leaderIp, coordinator } = await groupLeadOf(s.ip, config);
  const account = await spotifyAccountOf(leaderIp) ?? (leaderIp !== s.ip ? await spotifyAccountOf(s.ip) : null);
  if (!account) {
    throw new SonosError('HomeHub can’t find the Spotify account on your Sonos yet. Play any Spotify song on a Sonos once, from the Sonos or Spotify app, then try again.', 'NO_SPOTIFY');
  }
  try {
    await playOn(leaderIp, coordinator, spotifyPlayable(link, account));
  } catch (err) {
    if (err instanceof SonosError && err.code === 'FAILED') {
      throw new SonosError(`Sonos couldn’t play that Spotify ${link.kind}${err.upnpCode ? ` (code ${err.upnpCode})` : ''}. Check it plays in the Spotify app, and that Spotify is still set up in the Sonos app.`, 'FAILED', err.upnpCode);
    }
    throw err;
  }
}

/** POST /api/sonos/:id/remote { action | volume | step | mute | choose | spotify } — one button. Answers with the remote afterwards. */
sonosRouter.post('/:id/remote', async (req: Request, res: Response) => {
  const s = speakerFor(req);
  if (!s) return res.status(404).json({ error: 'Speaker not found', code: 'DEVICE_NOT_FOUND' });
  const action = sonosActionOf((req.body ?? {}) as Record<string, unknown>);
  if (typeof action === 'string') return res.status(400).json({ error: action, code: 'VALIDATION_ERROR' });
  try {
    const config = configOf(s);
    switch (action.kind) {
      case 'play': await play(await leaderFor(s.ip, config)); break;
      case 'pause': await pause(await leaderFor(s.ip, config)); break;
      case 'next': case 'previous': await skip(await leaderFor(s.ip, config), action.kind === 'next'); break;
      case 'volume': await setVolume(s.ip, action.level); break;
      case 'step': await stepVolume(s.ip, action.by); break;
      case 'mute': await setMute(s.ip, action.on); break;
      case 'choose': {
        try {
          const started = await playChoice(s.ip, config, { id: action.id, title: action.title });
          logger.info({ id: s.id, favorite: started.title, by: req.user?.sub }, 'Sonos started a favorite');
        } catch (err) {
          if (err instanceof SonosError && err.code === 'FAILED') {
            throw new SonosError(`Sonos couldn’t play “${action.title ?? 'that'}”${err.upnpCode ? ` (code ${err.upnpCode})` : ''}. Try it in the Sonos app: its music service may need signing in again.`, 'FAILED', err.upnpCode);
          }
          throw err;
        }
        break;
      }
      case 'spotify':
        await playSpotify(s, config, action.link);
        logger.info({ id: s.id, spotify: action.link.kind, by: req.user?.sub }, 'Sonos started a Spotify link');
        break;
      case 'recent': {
        const item = recentFor(action.key);
        if (!item) return res.status(404).json({ error: 'That isn’t in Recently played any more.', code: 'NOT_FOUND' });
        if ('id' in item.payload) await playChoice(s.ip, config, item.payload);
        else if ('link' in item.payload) {
          const link = parseSpotifyLink(item.payload.link);
          if (!link) return res.status(404).json({ error: 'That isn’t in Recently played any more.', code: 'NOT_FOUND' });
          await playSpotify(s, config, link);
        } else {
          const { leaderIp, coordinator } = await groupLeadOf(s.ip, config);
          try {
            await playOn(leaderIp, coordinator, { uri: item.payload.uri, meta: item.payload.meta, station: true });
          } catch (err) {
            if (err instanceof SonosError && err.code === 'FAILED') {
              throw new SonosError(`Sonos couldn’t play “${item.title}”${err.upnpCode ? ` (code ${err.upnpCode})` : ''}. Try it in the Sonos app.`, 'FAILED', err.upnpCode);
            }
            throw err;
          }
          noteRecent({ key: action.key, kind: 'station', title: item.title, note: 'Radio station', payload: item.payload });
        }
        logger.info({ id: s.id, recent: item.kind, by: req.user?.sub }, 'Sonos played a recent item');
        break;
      }
    }
    logger.info({ id: s.id, action: action.kind, by: req.user?.sub }, 'Sonos remote');
    // Give a skip, or something newly started, a moment to show its track.
    const started = action.kind === 'choose' || action.kind === 'spotify' || action.kind === 'recent';
    if (action.kind === 'next' || action.kind === 'previous' || started) {
      await new Promise((r) => setTimeout(r, routeWaitMs));
    }
    const remote = await remoteOf(s);
    // A Spotify link, for Recently played: named from what it's playing now.
    if (action.kind === 'spotify') {
      const { kind, id } = action.link;
      const np = remote.nowPlaying;
      noteRecent({
        key: `spotify:${kind}:${id}`, kind: 'spotify',
        title: kind === 'track' ? np.title ?? 'Spotify song' : kind === 'album' ? np.album ?? 'Spotify album' : 'Spotify playlist',
        note: kind === 'playlist' ? (np.title ? `Spotify · started with ${np.title}` : 'Spotify') : np.artist ? `Spotify · ${np.artist}` : 'Spotify',
        art: np.art ?? null, payload: { link: `spotify:${kind}:${id}` },
      });
    }
    // Play and pause are the row's on and off: keep its switch in step.
    // Something just started is playing, even while it's still loading its first track.
    if (started) remote.playing = true;
    if (action.kind === 'play' || action.kind === 'pause' || started) {
      noteState(s.id, remote.playing);
      emitDeviceState(s.id, s.alias, remote.playing, null);
    }
    res.json(remote);
  } catch (err) {
    failure(res, s, err);
  }
});
