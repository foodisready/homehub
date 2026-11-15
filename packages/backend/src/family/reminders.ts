import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { logger } from '../logger';
import { isActiveServer } from '../system/role';
import { getVoiceSettings, type VoiceLanguage } from '../system/voice-bridge';
import { dayKey, localTime } from './checkin';

/**
 * Spoken reminders: "食藥喇" at 9:00, said by the home's speakers in the language it's written in.
 *
 * HomeHub decides when; the voice bridge says it. A reminder that's due waits in a short queue
 * that the bridge reads every 10 seconds with its settings, then reports back how many speakers
 * said it. A speaker in the middle of a command finishes that first.
 *
 * Only the active server says reminders, as only it runs voice.
 */

export type ReminderLanguage = 'auto' | VoiceLanguage;

export interface Reminder {
  id: number;
  text: string;
  language: ReminderLanguage;
  at: string;
  days: number[];
  enabled: boolean;
  lastDay: string | null;
  lastStatus: string | null;
  lastSaidAt: string | null;
}

interface Row { id: number; text: string; language: string; at_time: string; days: string; enabled: number; last_day: string | null; last_status: string | null; last_said_at: string | null }

export interface Announcement { id: string; text: string; lang: VoiceLanguage; reminderId: number | null; queuedAt: number }

export class ReminderError extends Error {}

/** A reminder missed by more than this (HomeHub was off) isn't said late. */
const LATE_LIMIT_MS = 15 * 60_000;
/** How long one waits for the bridge before it's given up on. */
const ANSWER_WITHIN_MS = 2 * 60_000;
const TICK_MS = 15_000;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const LANGUAGES: ReminderLanguage[] = ['auto', 'en', 'yue', 'zh', 'vi'];

const toReminder = (r: Row): Reminder => ({
  id: r.id, text: r.text, language: r.language as ReminderLanguage, at: r.at_time, days: [...r.days].map(Number),
  enabled: !!r.enabled, lastDay: r.last_day, lastStatus: r.last_status, lastSaidAt: r.last_said_at,
});

export function listReminders(): Reminder[] {
  return (getDb().prepare('SELECT * FROM reminders ORDER BY at_time, id').all() as Row[]).map(toReminder);
}

export function getReminder(id: number): Reminder | null {
  const r = getDb().prepare('SELECT * FROM reminders WHERE id = ?').get(id) as Row | undefined;
  return r ? toReminder(r) : null;
}

/** Vietnamese letters with their marks, which English doesn't have. */
const VIETNAMESE = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const CHINESE = /[㐀-鿿]/;

/**
 * The voice a reminder is said in. Chinese is Cantonese unless only Mandarin is on; written in
 * simplified characters, it's Mandarin when that's on too. Null when no voice that's on fits.
 */
export function voiceFor(text: string, language: ReminderLanguage, on: VoiceLanguage[] = getVoiceSettings().languages): VoiceLanguage | null {
  if (language !== 'auto') return on.includes(language) ? language : null;
  if (CHINESE.test(text)) {
    const simplified = /[们这说开关灯时间药吃饭电视门锁记]/.test(text) && !/[們這說開關燈時間藥飯電視門鎖記]/.test(text);
    if (on.includes('zh') && (simplified || !on.includes('yue'))) return 'zh';
    return on.includes('yue') ? 'yue' : null;
  }
  if (VIETNAMESE.test(text)) return on.includes('vi') ? 'vi' : null;
  return 'en';
}

const LANGUAGE_NAME: Record<VoiceLanguage, string> = { en: 'English', yue: 'Cantonese', zh: 'Mandarin', vi: 'Vietnamese' };

export function saveReminder(input: unknown, id?: number): Reminder {
  if (!input || typeof input !== 'object') throw new ReminderError('Expected an object');
  const b = input as Record<string, unknown>;
  const existing = id ? getReminder(id) : null;
  if (id && !existing) throw new ReminderError('No such reminder');
  const text = typeof b['text'] === 'string' ? b['text'].trim() : existing?.text ?? '';
  if (!text || text.length > 200) throw new ReminderError('What to say is required, up to 200 characters');
  const language = (b['language'] ?? existing?.language ?? 'auto') as ReminderLanguage;
  if (!LANGUAGES.includes(language)) throw new ReminderError(`language must be one of ${LANGUAGES.join(', ')}`);
  if (!voiceFor(text, language)) {
    const wanted = language === 'auto' ? (CHINESE.test(text) ? 'Cantonese or Mandarin' : 'Vietnamese') : LANGUAGE_NAME[language];
    throw new ReminderError(`${wanted} isn't on in Settings → Voice control, so the speakers can't say this yet`);
  }
  const at = b['at'] ?? existing?.at;
  if (typeof at !== 'string' || !HHMM.test(at)) throw new ReminderError('at must be a time, HH:MM');
  const days = b['days'] ?? existing?.days ?? [0, 1, 2, 3, 4, 5, 6];
  if (!Array.isArray(days) || !days.length || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    throw new ReminderError('days must be a list of weekdays, 0 (Sunday) to 6');
  }
  const enabled = 'enabled' in b ? b['enabled'] === true : existing?.enabled ?? true;
  const values = [text, language, at, [...new Set(days as number[])].sort().join(''), enabled ? 1 : 0];
  const db = getDb();
  // A time already passed today waits for tomorrow, so saving at 9:05 doesn't say a 9:00 reminder now.
  const today = dayKey(new Date());
  const passed = Date.now() >= localTime(today, at);
  if (existing) {
    const lastDay = existing.at !== at ? (passed ? today : null) : existing.lastDay;
    db.prepare('UPDATE reminders SET text = ?, language = ?, at_time = ?, days = ?, enabled = ?, last_day = ? WHERE id = ?').run(...values, lastDay, existing.id);
    return getReminder(existing.id)!;
  }
  const r = db.prepare('INSERT INTO reminders (text, language, at_time, days, enabled, last_day) VALUES (?, ?, ?, ?, ?, ?)').run(...values, passed ? today : null);
  return getReminder(Number(r.lastInsertRowid))!;
}

export function deleteReminder(id: number): boolean {
  return getDb().prepare('DELETE FROM reminders WHERE id = ?').run(id).changes > 0;
}

// ── The queue the bridge reads ──────────────────────────────────

const queue = new Map<string, Announcement>();
/** How each one went, for the page that asked to hear it: kept a few minutes. */
export interface AnnouncementResult { state: 'waiting' | 'said' | 'not said'; said: string[]; error: string | null; at: number }
const results = new Map<string, AnnouncementResult>();
const KEEP_RESULT_MS = 10 * 60_000;
function result(id: string, r: Omit<AnnouncementResult, 'at'>, now = Date.now()): void {
  for (const [k, v] of results) if (now - v.at > KEEP_RESULT_MS) results.delete(k);
  results.set(id, { ...r, at: now });
}
export function announcementStatus(id: string): AnnouncementResult | null {
  pendingAnnouncements();
  return results.get(id) ?? null;
}

function setStatus(reminderId: number | null, status: string, said: boolean): void {
  if (reminderId === null) return;
  getDb().prepare(`UPDATE reminders SET last_status = ?${said ? ', last_said_at = ?' : ''} WHERE id = ?`)
    .run(...(said ? [status, new Date().toISOString(), reminderId] : [status, reminderId]));
}

/** Puts something in the queue for the speakers. Returns its id. */
export function announce(text: string, lang: VoiceLanguage, reminderId: number | null = null, now = Date.now()): string {
  const id = randomUUID();
  queue.set(id, { id, text, lang, reminderId, queuedAt: now });
  result(id, { state: 'waiting', said: [], error: null }, now);
  setStatus(reminderId, 'waiting for the speakers', false);
  return id;
}

/** What the bridge should say now. Old ones it never took are given up on. */
export function pendingAnnouncements(now = Date.now()): Pick<Announcement, 'id' | 'text' | 'lang'>[] {
  for (const a of queue.values()) {
    if (now - a.queuedAt > ANSWER_WITHIN_MS) {
      queue.delete(a.id);
      result(a.id, { state: 'not said', said: [], error: 'the voice bridge didn’t answer. Is voice control running?' }, now);
      setStatus(a.reminderId, 'not said: the voice bridge didn’t answer. Is voice control running?', false);
      logger.warn({ text: a.text }, 'Reminder not said: the voice bridge did not take it');
    }
  }
  return [...queue.values()].map(({ id, text, lang }) => ({ id, text, lang }));
}

/** The bridge's answer: how many speakers said it, or why none did. */
export function announcementDone(id: string, body: unknown): boolean {
  const a = queue.get(id);
  if (!a) return false;
  queue.delete(id);
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const said = Array.isArray(b['said']) ? (b['said'] as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 10) : [];
  const error = typeof b['error'] === 'string' ? b['error'].slice(0, 200) : '';
  result(id, { state: said.length ? 'said' : 'not said', said, error: said.length ? null : error || 'no speaker could say it' });
  if (said.length) {
    setStatus(a.reminderId, `said on ${said.join(', ')}`, true);
    logger.info({ text: a.text, speakers: said }, 'Reminder said');
  } else {
    setStatus(a.reminderId, `not said: ${error || 'no speaker could say it'}`, false);
    logger.warn({ text: a.text, error }, 'Reminder not said');
  }
  return true;
}

export function clearQueueForTests(): void { queue.clear(); results.clear(); }

// ── When ────────────────────────────────────────────────────────

/** Queues the reminders that are due. Returns how many. */
export function checkReminders(now = Date.now()): number {
  if (!isActiveServer()) return 0;
  const today = dayKey(new Date(now));
  const weekday = new Date(now).getDay();
  let n = 0;
  for (const r of listReminders()) {
    if (!r.enabled || r.lastDay === today || !r.days.includes(weekday)) continue;
    const at = localTime(today, r.at);
    if (now < at) continue;
    getDb().prepare('UPDATE reminders SET last_day = ? WHERE id = ?').run(today, r.id);
    if (now - at > LATE_LIMIT_MS) {
      setStatus(r.id, `not said at ${r.at}: HomeHub was off`, false);
      continue;
    }
    if (!getVoiceSettings().enabled) { setStatus(r.id, 'not said: voice control is off', false); continue; }
    const lang = voiceFor(r.text, r.language);
    if (!lang) { setStatus(r.id, 'not said: its language isn’t on in Voice control', false); continue; }
    announce(r.text, lang, r.id, now);
    n++;
  }
  return n;
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startReminders(): void {
  timer = setInterval(() => { try { checkReminders(); } catch (err) { logger.error({ err }, 'Reminders failed'); } }, TICK_MS);
  timer.unref?.();
}
export function stopReminders(): void { if (timer) clearInterval(timer); timer = undefined; }
