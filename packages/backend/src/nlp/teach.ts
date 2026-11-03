import { getDb } from '../db';
import { cleanUp, parsePowerCommand } from './commands';
import { findDeviceByName, findDeviceGroup, findScene, normalize } from './find-device';

/**
 * Teaching HomeHub what a missed command meant. The phrase becomes a
 * nickname on the chosen devices, or an extra name for a scene, so the same
 * rules understand it next time, in Chat and by voice. Nothing is guessed:
 * the result is checked, and refused if HomeHub would still read it some
 * other way.
 */

export type MissSource = 'voice' | 'chat';

export interface Miss {
  source:    MissSource;
  id:        number;
  text:      string;
  createdAt: string;
  /** The part to teach, such as "brenden's light" from "Turn on Brenden's light". */
  phrase:    string;
  /** Whether it reads like a device command or a scene's name. */
  kind:      'device' | 'scene';
}

export class TeachError extends Error {}

const MAX_PHRASE = 60;

export function suggestPhrase(text: string): { phrase: string; kind: 'device' | 'scene' } {
  const command = parsePowerCommand(text);
  if (command) return { phrase: command.name.replace(/^(?:the|my)\s+/, ''), kind: 'device' };
  const scene = cleanUp(text).replace(/^(?:(?:run|start|activate|trigger|set)\s+)?(?:the\s+)?(?:scene\s+)?/, '').replace(/\s+scene$/, '');
  return { phrase: scene, kind: 'scene' };
}

const toIso = (sqlite: string) => sqlite.replace(' ', 'T') + 'Z';

/** Commands neither the rules nor anyone has dealt with yet, newest first, one per wording. */
export function listMisses(limit = 30): Miss[] {
  const db = getDb();
  const voice = db.prepare(
    'SELECT id, text, created_at FROM voice_commands WHERE understood = 0 AND resolved = 0 ORDER BY id DESC LIMIT 200',
  ).all() as { id: number; text: string; created_at: string }[];
  const chat = db.prepare(
    "SELECT id, text, created_at FROM chat_commands WHERE handled_by = 'model' AND resolved = 0 ORDER BY id DESC LIMIT 200",
  ).all() as { id: number; text: string; created_at: string }[];

  const all = [
    ...voice.map((r) => ({ source: 'voice' as const, ...r })),
    ...chat.map((r) => ({ source: 'chat' as const, ...r })),
  ].filter((r) => r.text.trim()).sort((a, b) => b.created_at.localeCompare(a.created_at));

  const seen = new Set<string>();
  const out: Miss[] = [];
  for (const r of all) {
    const key = cleanUp(r.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ source: r.source, id: r.id, text: r.text, createdAt: toIso(r.created_at), ...suggestPhrase(r.text) });
    if (out.length >= limit) break;
  }
  return out;
}

function missText(source: MissSource, id: number): string {
  const table = source === 'voice' ? 'voice_commands' : 'chat_commands';
  const row = getDb().prepare(`SELECT text FROM ${table} WHERE id = ?`).get(id) as { text: string } | undefined;
  if (!row) throw new TeachError('That command is no longer in the list.');
  return row.text;
}

/** Hide a miss, and the same wording elsewhere in the list. */
function resolve(text: string): void {
  const db = getDb();
  const key = cleanUp(text);
  for (const table of ['voice_commands', 'chat_commands']) {
    const rows = db.prepare(`SELECT id, text FROM ${table} WHERE resolved = 0`).all() as { id: number; text: string }[];
    const mark = db.prepare(`UPDATE ${table} SET resolved = 1 WHERE id = ?`);
    for (const r of rows) if (cleanUp(r.text) === key) mark.run(r.id);
  }
}

export function dismissMiss(source: MissSource, id: number): void {
  resolve(missText(source, id));
}

const readNames = (value: unknown): string[] => {
  try {
    const list = JSON.parse(String(value ?? '[]'));
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
};

/** What "turn on <phrase>" would switch now: the same order runPowerCommand uses. */
function devicesFor(phrase: string): number[] {
  const group = findDeviceGroup(phrase);
  if (group.length) return group.map((d) => d.id).sort((a, b) => a - b);
  const match = findDeviceByName(phrase);
  return 'device' in match ? [match.device.id] : [];
}

function checkPhrase(phrase: unknown): string {
  if (typeof phrase !== 'string') throw new TeachError('Enter the words to teach.');
  const trimmed = phrase.trim().replace(/\s+/g, ' ');
  if (!/[a-z0-9]/i.test(trimmed)) throw new TeachError('Enter the words to teach.');
  if (trimmed.length > MAX_PHRASE) throw new TeachError(`Use ${MAX_PHRASE} characters or fewer.`);
  return trimmed;
}


export function teach(input: {
  source: MissSource; id: number; phrase: unknown; deviceIds?: unknown; sceneId?: unknown;
}): { phrase: string; devices?: string[]; scene?: string } {
  const text = missText(input.source, input.id);
  const phrase = checkPhrase(input.phrase);
  const db = getDb();
  let result: { phrase: string; devices?: string[]; scene?: string } = { phrase };

  const run = db.transaction(() => {
    if (input.sceneId !== undefined) {
      const scene = db.prepare('SELECT id, name, nicknames FROM scenes WHERE id = ?').get(input.sceneId) as
        { id: number; name: string; nicknames: string | null } | undefined;
      if (!scene) throw new TeachError('Choose a scene.');
      const names = readNames(scene.nicknames);
      if (!names.some((n) => normalize(n) === normalize(phrase)) && normalize(scene.name) !== normalize(phrase)) {
        db.prepare('UPDATE scenes SET nicknames = ? WHERE id = ?').run(JSON.stringify([...names, phrase]), scene.id);
      }
      if (findScene(phrase)?.id !== scene.id) {
        throw new TeachError(`"${phrase}" already means another scene. Choose different words.`);
      }
      result = { phrase, scene: scene.name };
      return;
    }

    const ids = input.deviceIds;
    if (!Array.isArray(ids) || !ids.length || ids.some((x) => !Number.isInteger(x))) {
      throw new TeachError('Choose at least one device.');
    }
    const chosen = [...new Set(ids as number[])].sort((a, b) => a - b);
    const devices = chosen.map((id) =>
      db.prepare('SELECT id, alias, nicknames FROM devices WHERE id = ?').get(id) as
        { id: number; alias: string; nicknames: string | null } | undefined);
    if (devices.some((d) => !d)) throw new TeachError('One of those devices no longer exists.');

    const other = db.prepare('SELECT alias FROM devices WHERE id NOT IN (' + chosen.map(() => '?').join(',') + ')')
      .all(...chosen) as { alias: string }[];
    const taken = other.find((d) => normalize(d.alias) === normalize(phrase));
    if (taken) throw new TeachError(`"${taken.alias}" is already called that. Choose different words.`);

    const save = db.prepare('UPDATE devices SET nicknames = ? WHERE id = ?');
    for (const d of devices as { id: number; alias: string; nicknames: string | null }[]) {
      const names = readNames(d.nicknames);
      if (normalize(d.alias) === normalize(phrase) || names.some((n) => normalize(n) === normalize(phrase))) continue;
      save.run(JSON.stringify([...names, phrase]), d.id);
    }

    const now = devicesFor(phrase);
    if (now.join(',') !== chosen.join(',')) {
      throw new TeachError(
        now.length
          ? `HomeHub would still read "${phrase}" as other devices, such as a room or a shared nickname. Choose different words, or change that nickname in Settings → Devices.`
          : `HomeHub still couldn't tell which device "${phrase}" means. Choose different words.`,
      );
    }
    result = { phrase, devices: (devices as { alias: string }[]).map((d) => d.alias) };
  });

  run();
  resolve(text);
  return result;
}
