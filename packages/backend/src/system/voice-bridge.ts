import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { listDeviceNames, listSceneNames } from '../nlp/find-device';

/**
 * What the voice bridge last reported: it runs outside HomeHub, on this
 * computer or another one, and checks in every minute.
 */

export interface BridgeSpeaker {
  name: string;
  address: string;
  connected: boolean;
}

export interface BridgeReport {
  at: number;
  version: string | null;
  speakers: BridgeSpeaker[];
}

const SEEN_KEY = 'voice_bridge_seen_at';
let last: BridgeReport | null = null;

const str = (v: unknown, max = 100): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Validates and keeps a report. Returns null when it isn't one. */
export function recordBridgeReport(body: unknown, now = Date.now()): BridgeReport | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b['speakers'])) return null;
  const speakers = (b['speakers'] as unknown[]).slice(0, 50).flatMap((s): BridgeSpeaker[] => {
    if (!s || typeof s !== 'object') return [];
    const o = s as Record<string, unknown>;
    const address = str(o['address']);
    if (!address) return [];
    return [{ name: str(o['name']) || address, address, connected: o['connected'] === true }];
  });
  last = { at: now, version: str(b['version'], 40) || null, speakers };
  // Remembered across restarts, so a bridge that stops checking in is noticed.
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(SEEN_KEY, new Date(now).toISOString());
  return last;
}

export function lastBridgeReport(): BridgeReport | null {
  return last;
}

/** When a bridge last checked in, even before this backend started. Null if never. */
export function bridgeSeenAt(): number | null {
  if (last) return last.at;
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(SEEN_KEY) as { value: string } | undefined;
  const t = row ? Date.parse(row.value) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** Forgets the bridge, for when it has been removed on purpose. */
export function forgetBridge(): void {
  last = null;
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(SEEN_KEY);
}

/** Every device, nickname, room and scene name, for the bridge's speech recognition and Cantonese matching. */
export function voiceNames(): { names: string[]; version: string } {
  const names = [...listDeviceNames(), ...listSceneNames()];
  return { names, version: createHash('sha1').update(JSON.stringify(names)).digest('hex').slice(0, 12) };
}

// An admin asked for a restart, which the bridge picks up at its next check-in.
let restartAskedAt: number | null = null;
// When it was handed to the bridge, until the bridge checks in again after restarting.
let restartingSince: number | null = null;
/** A report this soon after the bridge was told to restart is still from before it stopped. */
const RESTART_SETTLE_MS = 5_000;

export function requestBridgeRestart(now = Date.now()): void {
  restartAskedAt = now;
}

/** What HomeHub tells the bridge when it checks in: the names' version, and whether to restart. */
export function bridgeInstructions(now = Date.now()): { namesVersion: string; restart: boolean } {
  const restart = restartAskedAt !== null;
  if (restart) {
    restartAskedAt = null;
    restartingSince = now;
  } else if (restartingSince !== null && now - restartingSince > RESTART_SETTLE_MS) {
    restartingSince = null;   // checked in again: restarted
  }
  return { namesVersion: voiceNames().version, restart };
}

/** 'asked' until the bridge checks in, then 'restarting' until it checks in again. */
export function bridgeRestartState(): 'asked' | 'restarting' | null {
  return restartAskedAt !== null ? 'asked' : restartingSince !== null ? 'restarting' : null;
}

/** For tests. */
export function resetBridgeReport(): void {
  last = null;
  restartAskedAt = null;
  restartingSince = null;
}
