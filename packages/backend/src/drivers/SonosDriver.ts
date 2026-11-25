import type { DeviceDriver, DiscoveredDevice, EnergyMetrics } from './DeviceDriver';
import { SonosError, describe, groupOf, isPlaying, leaderOf, pause, play, searchSpeakers, setVolume, transportState, type SpeakerInfo } from '../sonos/protocol';
import { noteRecent } from '../sonos/recent';
import { findChoice, libraryOf, playOn, type Playable } from '../sonos/music';
import { logger } from '../logger';

type Found = Omit<DiscoveredDevice, 'driverType'>;

export function speakerUuidOf(config?: Record<string, unknown>): string {
  return typeof config?.uuid === 'string' ? config.uuid : '';
}

/** Where play and pause go for this speaker: its group's leader. Without a saved id, the speaker itself. */
export async function leaderFor(ip: string, config?: Record<string, unknown>): Promise<string> {
  const uuid = speakerUuidOf(config);
  return uuid ? leaderOf(ip, uuid) : ip;
}

/** The group's leader's address and its id, which names the group's queue. */
export async function groupLeadOf(ip: string, config?: Record<string, unknown>): Promise<{ leaderIp: string; coordinator: string }> {
  let uuid = speakerUuidOf(config);
  if (!uuid) {
    const me = await describe(ip);
    if (!me) throw new SonosError(`No answer from the speaker at ${ip}`, 'UNREACHABLE');
    uuid = me.uuid;
  }
  let group = null;
  try {
    group = await groupOf(ip, uuid);
  } catch (err) {
    if (err instanceof SonosError && err.code === 'UNREACHABLE') throw err;
  }
  const leader = group?.members.find((m) => m.uuid === group.coordinator);
  return { leaderIp: leader?.ip ?? ip, coordinator: group?.coordinator ?? uuid };
}

/** A saved choice of what to play (a schedule's or a scene's): a favorite or Sonos playlist, by id and name. */
export interface PlayChoice { id: string; title: string }

export function isPlayChoice(v: unknown): v is PlayChoice {
  const c = v as PlayChoice;
  return !!c && typeof c === 'object' && typeof c.id === 'string' && /^(FV:2\/\d+|SQ:\d+)$/.test(c.id)
    && typeof c.title === 'string' && c.title.trim().length > 0 && c.title.length <= 200;
}

/** A saved choice from its stored JSON; null when there's none or it's unreadable. */
export function playChoiceOf(json: string | null | undefined): PlayChoice | null {
  if (!json) return null;
  try { const v = JSON.parse(json); return isPlayChoice(v) ? { id: v.id, title: v.title } : null; } catch { return null; }
}

/**
 * A device's driver config with what to play added, for a Turn ON that should start a favorite
 * (a scene's or schedule's) instead of carrying on with what was playing.
 */
export function configWithPlay(configJson: string | null, play: PlayChoice | null, volume: number | null = null): string | null {
  if (!play && volume === null) return configJson;
  let config: Record<string, unknown> = {};
  try { config = configJson ? JSON.parse(configJson) : {}; } catch { /* a bad config plays anyway */ }
  return JSON.stringify({ ...config, ...(play ? { play } : {}), ...(volume !== null ? { volume } : {}) });
}

/** A scene's volume for its speaker: a whole number from 0 to 100, or null to leave it. */
export function sceneVolumeOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100 ? v : null;
}

/** Starts a favorite or Sonos playlist on the speaker's group. Answers with what it started. */
export async function playChoice(ip: string, config: Record<string, unknown> | undefined, wanted: { id: string; title?: string | null }): Promise<Playable> {
  const found = findChoice(await libraryOf(ip), wanted);
  if (!found) {
    throw new SonosError(`“${wanted.title ?? wanted.id}” isn’t in Sonos Favorites or playlists any more. Choose another one.`, 'GONE');
  }
  const { leaderIp, coordinator } = await groupLeadOf(ip, config);
  await playOn(leaderIp, coordinator, found);
  // Kept by name, as ids change when favorites are re-made.
  noteRecent({ key: `${found.kind}:${found.title}`, kind: found.kind, title: found.title, note: found.note, art: found.art, payload: { id: found.id, title: found.title } });
  return found;
}

/**
 * Sonos speakers (see sonos/protocol.ts). On is playing and off is paused: a Sonos is never
 * really off. In a group, play and pause act on the whole group, as in the Sonos app.
 * A Turn ON with a chosen favorite (config.play) starts that instead, and a scene's volume
 * (config.volume) is set on the speaker first.
 */
export class SonosDriver implements DeviceDriver {
  readonly type = 'sonos';
  readonly confirmAfterMs = 1_500;

  async setPower(ip: string, on: boolean, config?: Record<string, unknown>): Promise<void> {
    // A scene's volume for this speaker, set before it plays.
    const volume = on ? sceneVolumeOf(config?.volume) : null;
    if (volume !== null) await setVolume(ip, volume);
    const chosen = on && config && isPlayChoice(config.play) ? config.play : null;
    if (chosen) {
      const started = await playChoice(ip, config, chosen);
      logger.info({ ip, favorite: started.title }, 'Sonos started a favorite');
      return;
    }
    const leader = await leaderFor(ip, config);
    const playing = isPlaying(await transportState(leader));
    if (playing === on) return;
    if (!on) { await pause(leader); return; }
    try {
      await play(leader);
    } catch (err) {
      if (err instanceof SonosError && err.code === 'NOTHING_TO_PLAY') {
        throw new SonosError('There’s nothing to play on it yet. Choose a favorite in its remote, or start some music in the Sonos app.', 'NOTHING_TO_PLAY');
      }
      throw err;
    }
  }

  async getPower(ip: string, config?: Record<string, unknown>): Promise<boolean> {
    return isPlaying(await transportState(await leaderFor(ip, config)));
  }

  async getEnergy(): Promise<EnergyMetrics | null> {
    return null;
  }

  async probe(ip: string): Promise<Found | null> {
    const s = await describe(ip);
    return s ? this.toFound(s) : null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    const speakers = await searchSpeakers();
    logger.info({ count: speakers.length }, 'Sonos search complete');
    return speakers.map((s) => ({ ...this.toFound(s), driverType: this.type }));
  }

  private toFound(s: SpeakerInfo): Found {
    return { ip: s.ip, alias: `${s.room} Sonos`, model: s.model, hasEmeter: false, driverConfig: { uuid: s.uuid }, ...(s.mac ? { mac: s.mac } : {}) };
  }
}
