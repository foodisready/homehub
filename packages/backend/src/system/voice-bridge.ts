import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { listDeviceNameGroups, listDeviceNames, listSceneNames } from '../nlp/find-device';
import { isActiveServer } from './role';

/**
 * What the voice bridge last reported: it runs outside HomeHub, on this
 * computer or another one, and checks in every minute.
 */

export interface BridgeSpeaker {
  name: string;
  address: string;
  connected: boolean;
  /** Whether it can say something it wasn't asked, such as a reminder; null from a bridge before v0.1.85. */
  announce: boolean | null;
  /** Its wake words and which are on: a Voice PE says, Ava doesn't (null). From v0.3.30. */
  wakeWords: SpeakerWakeWord[] | null;
  /** How readily its wake words wake it, and the choices: "Slightly sensitive" …; null if it can't say. */
  sensitivity: string | null;
  sensitivities: string[];
}

export interface SpeakerWakeWord { id: string; name: string; on: boolean }

/** What an admin chose for a speaker in Settings → Voice control, by its name. The bridge applies it. */
export interface SpeakerChoice { wakeWords?: string[]; sensitivity?: string }

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
  /** The languages it's running with; null from a bridge before v0.1.60. */
  languages: string[] | null;
  /** While starting, what it's doing: "Downloading the Vietnamese speech model: 45% of 60 MB". */
  detail: string | null;
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
export function bridgeForSettings(now = Date.now(), lateMs: number):
  (Pick<BridgeReport, 'state' | 'kind' | 'version' | 'languages' | 'detail'> & {
    applying: boolean;
    /** Each speaker and whether it's connected, so Settings can show them beside Restart; and its
     *  wake words and sensitivity, with `applying` while the bridge hasn't yet made it so. */
    speakers: SettingsSpeaker[];
    /** 'asked' until the bridge picks up a restart, then 'restarting' until it checks in again. */
    restart: 'asked' | 'restarting' | null;
  }) | null {
  if (!last || now - last.at > lateMs) return null;
  const service = recentBridges(now).some((b) => b.kind === 'service');
  return {
    state: last.state, kind: service ? 'service' : last.kind, version: last.version,
    languages: last.languages, detail: last.detail, applying: languagesPending(),
    speakers: last.speakers.map(settingsSpeaker),
    restart: bridgeRestartState(),
  };
}

/**
 * True while the bridge is running with other languages than the ones saved: it
 * restarts to apply them within seconds of noticing, and until then a command in a
 * newly ticked language goes to another one. Unknown for a bridge before v0.1.60.
 */
export function languagesPending(): boolean {
  if (!last || last.state !== 'running' || !last.languages) return false;
  const want = voiceConfig();
  if (!want.enabled) return false;
  const have = new Set(last.languages);
  return want.languages.length !== have.size || want.languages.some((l) => !have.has(l));
}

// ── Voice settings, chosen in Settings → Voice control ──────────

export const VOICE_LANGUAGES = ['en', 'yue', 'vi', 'zh'] as const;
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

export interface SettingsSpeaker {
  name: string;
  connected: boolean;
  wakeWords?: SpeakerWakeWord[];
  sensitivity?: string;
  sensitivities?: string[];
  /** What was chosen in Settings isn't on the speaker yet: the bridge applies it within about 10 seconds. */
  applying?: boolean;
}

const CHOICES_KEY = 'voice_speaker_choices';

/** Each speaker's wake words and sensitivity as chosen in Settings, by speaker name. */
export function speakerChoices(): Record<string, SpeakerChoice> {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(CHOICES_KEY) as { value: string } | undefined;
  try {
    const all = JSON.parse(row?.value ?? '{}');
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
}

export class SpeakerChoiceError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/**
 * Saves a speaker's wake words (the ones to have on) and sensitivity, checked against what the
 * speaker last said it has. At least one wake word stays on, or the speaker could never be woken.
 */
export function chooseForSpeaker(name: unknown, body: unknown): SpeakerChoice {
  const speaker = typeof name === 'string' ? last?.speakers.find((sp) => sp.name === name) : undefined;
  if (!speaker) throw new SpeakerChoiceError('No speaker by that name has checked in.', 404);
  const b = (body ?? {}) as Record<string, unknown>;
  const choice: SpeakerChoice = { ...speakerChoices()[speaker.name] };
  if (b['wakeWords'] !== undefined) {
    if (!speaker.wakeWords) throw new SpeakerChoiceError('This speaker can\'t change its wake words.');
    const ids = Array.isArray(b['wakeWords']) ? b['wakeWords'].filter((x): x is string => typeof x === 'string') : [];
    const on = speaker.wakeWords.map((w) => w.id).filter((id) => ids.includes(id));
    if (!on.length) throw new SpeakerChoiceError('Keep at least one wake word on, or the speaker can\'t be woken.');
    choice.wakeWords = on;
  }
  if (b['sensitivity'] !== undefined) {
    if (typeof b['sensitivity'] !== 'string' || !speaker.sensitivities.includes(b['sensitivity'])) {
      throw new SpeakerChoiceError(`sensitivity: one of ${speaker.sensitivities.join(', ') || 'none for this speaker'}`);
    }
    choice.sensitivity = b['sensitivity'];
  }
  const all = { ...speakerChoices(), [speaker.name]: choice };
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(CHOICES_KEY, JSON.stringify(all));
  return choice;
}

function settingsSpeaker(sp: BridgeSpeaker): SettingsSpeaker {
  const out: SettingsSpeaker = { name: sp.name, connected: sp.connected };
  if (!sp.wakeWords && !sp.sensitivity) return out;
  const want = speakerChoices()[sp.name] ?? {};
  // As chosen, while the bridge is still setting it, so Settings doesn't flick back.
  if (sp.wakeWords) out.wakeWords = sp.wakeWords.map((w) => ({ ...w, on: want.wakeWords ? want.wakeWords.includes(w.id) : w.on }));
  if (sp.sensitivity) { out.sensitivity = want.sensitivity ?? sp.sensitivity; out.sensitivities = sp.sensitivities; }
  const on = (sp.wakeWords ?? []).filter((w) => w.on).map((w) => w.id).sort().join();
  out.applying = sp.connected && (
    (!!want.wakeWords && !!sp.wakeWords && [...want.wakeWords].sort().join() !== on)
    || (!!want.sensitivity && !!sp.sensitivity && want.sensitivity !== sp.sensitivity));
  return out;
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
    const wakeWords = Array.isArray(o['wakeWords'])
      ? (o['wakeWords'] as unknown[]).slice(0, 20).flatMap((w): SpeakerWakeWord[] => {
        const ww = (w ?? {}) as Record<string, unknown>;
        const id = str(ww['id'], 60);
        return id ? [{ id, name: str(ww['name'], 60) || id, on: ww['on'] === true }] : [];
      })
      : null;
    const sensitivities = Array.isArray(o['sensitivities'])
      ? (o['sensitivities'] as unknown[]).slice(0, 10).map((x) => str(x, 60)).filter(Boolean)
      : [];
    const sensitivity = sensitivities.includes(str(o['sensitivity'], 60)) ? str(o['sensitivity'], 60) : null;
    return [{
      name: str(o['name']) || address, address, connected: o['connected'] === true,
      announce: typeof o['announce'] === 'boolean' ? o['announce'] : null,
      wakeWords: wakeWords?.length ? wakeWords : null, sensitivity, sensitivities: sensitivity ? sensitivities : [],
    }];
  });
  const state = b['state'] === 'off' || b['state'] === 'starting' ? b['state'] : 'running';
  const id = str(b['id'], 40) || null;
  // Bridges from before v0.1.23 send neither: they were all installed with install.sh.
  const kind = b['kind'] === 'docker' || b['kind'] === 'service' ? b['kind'] : id ? null : 'service';
  const languages = Array.isArray(b['languages'])
    ? VOICE_LANGUAGES.filter((l) => (b['languages'] as unknown[]).includes(l))
    : null;
  const detail = state === 'starting' ? str(b['detail'], 200) || null : null;
  last = { at: now, version: str(b['version'], 40) || null, speakers, state, id, kind, languages, detail };
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
export function voiceNames(): { names: string[]; scenes: string[]; groups: string[][]; version: string } {
  const scenes = listSceneNames();
  const names = [...listDeviceNames(), ...scenes];
  // Each device's names together, so the bridge knows "đèn bếp" and "đèn nhà bếp" are one light,
  // not two it can't choose between.
  const groups = listDeviceNameGroups().filter((g) => g.length > 1);
  return { names, scenes, groups, version: createHash('sha1').update(JSON.stringify([names, scenes, groups])).digest('hex').slice(0, 12) };
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
