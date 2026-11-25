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
  | { kind: 'choose'; id: string; title: string | null } | { kind: 'spotify'; link: SpotifyLink };

/** Reads a remote button from a request body; a message for a bad one. */
export function sonosActionOf(body: Record<string, unknown>): SonosAction | string {
  const { action, volume, step, mute, choose, spotify } = body;
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
    }
    logger.info({ id: s.id, action: action.kind, by: req.user?.sub }, 'Sonos remote');
    // Give a skip, or something newly started, a moment to show its track.
    if (action.kind === 'next' || action.kind === 'previous' || action.kind === 'choose' || action.kind === 'spotify') {
      await new Promise((r) => setTimeout(r, routeWaitMs));
    }
    const remote = await remoteOf(s);
    // Play and pause are the row's on and off: keep its switch in step.
    // Something just started is playing, even while it's still loading its first track.
    if (action.kind === 'choose' || action.kind === 'spotify') remote.playing = true;
    if (action.kind === 'play' || action.kind === 'pause' || action.kind === 'choose' || action.kind === 'spotify') {
      noteState(s.id, remote.playing);
      emitDeviceState(s.id, s.alias, remote.playing, null);
    }
    res.json(remote);
  } catch (err) {
    failure(res, s, err);
  }
});
