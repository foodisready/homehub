import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { listDeviceNames, listSceneNames } from '../nlp/find-device';
import { isActiveServer } from './role';

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
  /** 'off': waiting for voice to be turned on; 'starting': loading or downloading its models. */
  state: 'off' | 'starting' | 'running';
  /** The bridge that sent it: two at once means an old one is still running. */
  id: string | null;
  /** 'docker' when it comes with HomeHub; 'service' when installed with install.sh. */
  kind: 'docker' | 'service' | null;
}

const SEEN_KEY = 'voice_bridge_seen_at';
const STATE_KEY = 'voice_bridge_state';
let last: BridgeReport | null = null;
// Bridges heard from lately, by id. Two checking in within this time are both running.
const bridges = new Map<string, { at: number; kind: BridgeReport['kind'] }>();
const TWO_BRIDGES_MS = 2.5 * 60_000;
/** Stands in for the id a bridge from before v0.1.23 doesn't send. */
const LEGACY_ID = 'legacy';

/** Every bridge that checked in lately: more than one means two answer each command. */
export function recentBridges(now = Date.now()): { id: string; kind: BridgeReport['kind'] }[] {
  return [...bridges].filter(([, b]) => now - b.at <= TWO_BRIDGES_MS).map(([id, b]) => ({ id, kind: b.kind }));
}

/**
 * What Settings → Voice control shows as the bridge. While one installed with
 * install.sh is still checking in, that's what it shows, even when the one that
 * comes with HomeHub spoke last, so the admin is told to stop the old one.
 */
export function bridgeForSettings(now = Date.now(), lateMs: number): Pick<BridgeReport, 'state' | 'kind' | 'version'> | null {
  if (!last || now - last.at > lateMs) return null;
  const service = recentBridges(now).some((b) => b.kind === 'service');
  return { state: last.state, kind: service ? 'service' : last.kind, version: last.version };
}

// ── Voice settings, chosen in Settings → Voice control ──────────

export const VOICE_LANGUAGES = ['en', 'yue'] as const;
export type VoiceLanguage = typeof VOICE_LANGUAGES[number];
export interface VoiceSettings { enabled: boolean; languages: VoiceLanguage[] }

const VOICE_KEY = 'voice_settings';

export function getVoiceSettings(): VoiceSettings {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(VOICE_KEY) as { value: string } | undefined;
  try {
    const v = row ? JSON.parse(row.value) : {};
    const languages = Array.isArray(v.languages) ? VOICE_LANGUAGES.filter((l) => v.languages.includes(l)) : ['en' as const];
    return { enabled: v.enabled === true, languages: languages.includes('en') ? languages : ['en', ...languages] };
  } catch {
    return { enabled: false, languages: ['en'] };
  }
}

/** Validates and saves. English is always on: it's how HomeHub's own wording is spoken. */
export function setVoiceSettings(input: unknown): VoiceSettings {
  const v = (input ?? {}) as Record<string, unknown>;
  if (typeof v.enabled !== 'boolean') throw new Error('enabled must be true or false');
  if (!Array.isArray(v.languages) || v.languages.some((l) => !VOICE_LANGUAGES.includes(l as VoiceLanguage))) {
    throw new Error(`languages must be a list of: ${VOICE_LANGUAGES.join(', ')}`);
  }
  const languages = VOICE_LANGUAGES.filter((l) => l === 'en' || (v.languages as unknown[]).includes(l));
  const saved: VoiceSettings = { enabled: v.enabled, languages };
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(VOICE_KEY, JSON.stringify(saved));
  return saved;
}

/** What the bridge runs with, and a version that changes when it does, so the bridge restarts to apply it. */
export function voiceConfig(): VoiceSettings & { version: string } {
  // Only the active server listens: a speaker such as Ava talks to one bridge at a time.
  // The saved settings stay as they are, for when this server is active again.
  const s = isActiveServer() ? getVoiceSettings() : { ...getVoiceSettings(), enabled: false };
  return { ...s, version: createHash('sha1').update(JSON.stringify(s)).digest('hex').slice(0, 12) };
}

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
  const state = b['state'] === 'off' || b['state'] === 'starting' ? b['state'] : 'running';
  const id = str(b['id'], 40) || null;
  // Bridges from before v0.1.23 send neither: they were all installed with install.sh.
  const kind = b['kind'] === 'docker' || b['kind'] === 'service' ? b['kind'] : id ? null : 'service';
  last = { at: now, version: str(b['version'], 40) || null, speakers, state, id, kind };
  bridges.set(id ?? LEGACY_ID, { at: now, kind });
  for (const [k, seen] of bridges) if (now - seen.at > TWO_BRIDGES_MS) bridges.delete(k);
  // Remembered across restarts, so a bridge that stops checking in is noticed.
  const save = getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  save.run(SEEN_KEY, new Date(now).toISOString());
  save.run(STATE_KEY, state);
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

/** What the bridge said it was doing last time, even before this backend started. */
export function bridgeLastState(): BridgeReport['state'] | null {
  if (last) return last.state;
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(STATE_KEY) as { value: string } | undefined;
  return row?.value === 'off' || row?.value === 'starting' || row?.value === 'running' ? row.value : null;
}

/** Forgets the bridge, for when it has been removed on purpose. */
export function forgetBridge(): void {
  last = null;
  getDb().prepare('DELETE FROM settings WHERE key IN (?, ?)').run(SEEN_KEY, STATE_KEY);
}

/** Every device, nickname, room and scene name, for the bridge's speech recognition and Cantonese matching. */
/**
 * Every name, for speech recognition, and the scenes' among them, so the bridge
 * never sends a light's name heard alone ("廚房燈") as a scene to run.
 */
export function voiceNames(): { names: string[]; scenes: string[]; version: string } {
  const scenes = listSceneNames();
  const names = [...listDeviceNames(), ...scenes];
  return { names, scenes, version: createHash('sha1').update(JSON.stringify([names, scenes])).digest('hex').slice(0, 12) };
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
export function bridgeInstructions(now = Date.now()): { namesVersion: string; configVersion: string; restart: boolean } {
  const restart = restartAskedAt !== null;
  if (restart) {
    restartAskedAt = null;
    restartingSince = now;
  } else if (restartingSince !== null && now - restartingSince > RESTART_SETTLE_MS) {
    restartingSince = null;   // checked in again: restarted
  }
  return { namesVersion: voiceNames().version, configVersion: voiceConfig().version, restart };
}

/** 'asked' until the bridge checks in, then 'restarting' until it checks in again. */
export function bridgeRestartState(): 'asked' | 'restarting' | null {
  return restartAskedAt !== null ? 'asked' : restartingSince !== null ? 'restarting' : null;
}

/** For tests. */
export function resetBridgeReport(): void {
  last = null;
  bridges.clear();
  restartAskedAt = null;
  restartingSince = null;
}
