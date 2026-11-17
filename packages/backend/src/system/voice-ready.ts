import { getDb } from '../db';
import { lastBridgeReport, voiceConfig, type BridgeReport } from './voice-bridge';

/**
 * Whether voice is back after HomeHub starts: an update restarts the voice bridge too, and the
 * speakers can't be talked to until it has loaded its speech models and found them again, which
 * takes about a minute. The app says so, then says when a speaker is listening again.
 *
 * - off:      nothing to say: voice is off here, or no speaker has ever been connected.
 * - starting: since this start, no speaker connected yet. `loading`: the bridge is still
 *             loading its speech models, or hasn't checked in yet.
 * - ready:    a speaker connected, at `readyAt`. A speaker going away later isn't this banner's
 *             business: it's about the start, and the Health page says which speaker and why.
 * - missing:  none connected within MISSING_AFTER_MS of the start.
 */
export type VoiceReadyState = 'off' | 'starting' | 'ready' | 'missing';

export interface VoiceReady {
  state: VoiceReadyState;
  startedAt: string;
  readyAt: string | null;
  loading: boolean;
}

/** A speaker usually answers about a minute after a start; three is plainly too long. */
export const MISSING_AFTER_MS = 3 * 60_000;
/** Remembered across starts: a home where a speaker has never connected doesn't use voice. */
const HAD_KEY = 'voice_speaker_connected_at';

let startedAt = Date.now();
let readyAt: number | null = null;

/** Called with each report from the voice bridge. */
export function noteBridgeReport(report: BridgeReport, now = Date.now()): void {
  if (!report.speakers.some((s) => s.connected)) return;
  if (readyAt === null) readyAt = now;
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(HAD_KEY, new Date(now).toISOString());
}

function hadSpeaker(): boolean {
  return readyAt !== null || !!getDb().prepare('SELECT 1 FROM settings WHERE key = ?').get(HAD_KEY);
}

export function voiceReady(now = Date.now()): VoiceReady {
  const base = { startedAt: new Date(startedAt).toISOString(), readyAt: readyAt === null ? null : new Date(readyAt).toISOString() };
  if (!voiceConfig().enabled || !hadSpeaker()) return { ...base, state: 'off', loading: false };
  if (readyAt !== null) return { ...base, state: 'ready', loading: false };
  const report = lastBridgeReport();
  const loading = !report || report.at < startedAt || report.state !== 'running';
  return { ...base, state: now - startedAt < MISSING_AFTER_MS ? 'starting' : 'missing', loading };
}

/** For tests: as if HomeHub had just started. */
export function resetVoiceReady(now = Date.now()): void {
  startedAt = now;
  readyAt = null;
}
