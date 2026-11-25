import type { DeviceDriver, DiscoveredDevice, EnergyMetrics } from './DeviceDriver';
import { SonosError, describe, isPlaying, leaderOf, pause, play, searchSpeakers, transportState, type SpeakerInfo } from '../sonos/protocol';
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

/**
 * Sonos speakers (see sonos/protocol.ts). On is playing and off is paused: a Sonos is never
 * really off. In a group, play and pause act on the whole group, as in the Sonos app.
 */
export class SonosDriver implements DeviceDriver {
  readonly type = 'sonos';
  readonly confirmAfterMs = 1_500;

  async setPower(ip: string, on: boolean, config?: Record<string, unknown>): Promise<void> {
    const leader = await leaderFor(ip, config);
    const playing = isPlaying(await transportState(leader));
    if (playing === on) return;
    if (!on) { await pause(leader); return; }
    try {
      await play(leader);
    } catch (err) {
      if (err instanceof SonosError && err.code === 'NOTHING_TO_PLAY') {
        throw new SonosError('There’s nothing to play on it yet. Start some music in the Sonos app, and after that Play here carries on with it.', 'NOTHING_TO_PLAY');
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
