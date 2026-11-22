import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { logger } from '../logger';
import { isActiveServer } from '../system/role';
import { awayPausesFamily } from '../home/away-state';
import { getVoiceSettings, type VoiceLanguage } from '../system/voice-bridge';
import { sendPushToAll } from '../push/push.service';
import { emailConfigured, sendEmail } from '../notifications/providers/email';
import { dayKey, localTime } from './checkin';
import { personName } from './sos';

/**
 * Spoken reminders: "食藥喇" at 9:00, said by the home's speakers in the language it's written in.
 *
 * HomeHub decides when; the voice bridge says it. A reminder that's due waits in a short queue
 * that the bridge reads every 10 seconds with its settings, then reports back how many speakers
 * said it. A speaker in the middle of a command finishes that first.
 *
 * Only the active server says reminders, as only it runs voice.
 *
 * A reminder can ask back: "食藥喇。食咗藥未呀？" The speaker listens for the answer (no wake word
 * needed on speakers that can start a conversation), and a yes or no in any language answers it
 * while it's open. No answer, or "not yet", and it's asked again in 10 minutes, up to 3 times; then
 * the family is told, by push and email only: it isn't an emergency.
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
  /** Asks if it's done, and tells the family if nobody says yes. */
  ask: boolean;
  /** For one that asks: the last week's answers, newest first. */
  answers: AskDay[];
}

export interface AskDay { id: number; day: string; answer: 'yes' | 'no' | null; asks: number; answeredAt: string | null; answeredBy: string | null; toldAt: string | null }

interface Row { id: number; text: string; language: string; at_time: string; days: string; enabled: number; last_day: string | null; last_status: string | null; last_said_at: string | null; ask: number }

/** ask: the reminder_asks row this one asks about, so the speaker listens for the answer. */
export interface Announcement { id: string; text: string; lang: VoiceLanguage; reminderId: number | null; queuedAt: number; ask: number | null; askKind?: 'checkin' }

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
  ask: !!r.ask, answers: r.ask ? recentAnswers(r.id) : [],
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

/** A reminder as it would be saved, checked; throws ReminderError for what's wrong. Saves nothing. */
export function readReminder(input: unknown, existing: Reminder | null = null): Pick<Reminder, 'text' | 'language' | 'at' | 'days' | 'enabled' | 'ask'> {
  if (!input || typeof input !== 'object') throw new ReminderError('Expected an object');
  const b = input as Record<string, unknown>;
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
  const ask = 'ask' in b ? b['ask'] === true : existing?.ask ?? false;
  return { text, language, at, days: [...new Set(days as number[])].sort(), enabled, ask };
}

export function saveReminder(input: unknown, id?: number): Reminder {
  const existing = id ? getReminder(id) : null;
  if (id && !existing) throw new ReminderError('No such reminder');
  const { text, language, at, days, enabled, ask } = readReminder(input, existing);
  const values = [text, language, at, days.join(''), enabled ? 1 : 0, ask ? 1 : 0];
  const db = getDb();
  // A time already passed today waits for tomorrow, so saving at 9:05 doesn't say a 9:00 reminder now.
  const today = dayKey(new Date());
  const passed = Date.now() >= localTime(today, at);
  if (existing) {
    const lastDay = existing.at !== at ? (passed ? today : null) : existing.lastDay;
    db.prepare('UPDATE reminders SET text = ?, language = ?, at_time = ?, days = ?, enabled = ?, ask = ?, last_day = ? WHERE id = ?').run(...values, lastDay, existing.id);
    return getReminder(existing.id)!;
  }
  const r = db.prepare('INSERT INTO reminders (text, language, at_time, days, enabled, ask, last_day) VALUES (?, ?, ?, ?, ?, ?, ?)').run(...values, passed ? today : null);
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
export function announce(text: string, lang: VoiceLanguage, reminderId: number | null = null, now = Date.now(), ask: number | null = null,
  askKind?: 'checkin'): string {
  const id = randomUUID();
  queue.set(id, { id, text, lang, reminderId, queuedAt: now, ask, ...(askKind ? { askKind } : {}) });
  result(id, { state: 'waiting', said: [], error: null }, now);
  setStatus(reminderId, 'waiting for the speakers', false);
  return id;
}

/** What the bridge should say now. Old ones it never took are given up on. */
export function pendingAnnouncements(now = Date.now()): (Pick<Announcement, 'id' | 'text' | 'lang' | 'askKind'> & { ask?: number })[] {
  for (const a of queue.values()) {
    if (now - a.queuedAt > ANSWER_WITHIN_MS) {
      queue.delete(a.id);
      result(a.id, { state: 'not said', said: [], error: 'the voice bridge didn’t answer. Is voice control running?' }, now);
      setStatus(a.reminderId, 'not said: the voice bridge didn’t answer. Is voice control running?', false);
      logger.warn({ text: a.text }, 'Reminder not said: the voice bridge did not take it');
    }
  }
  return [...queue.values()].map(({ id, text, lang, ask, askKind }) => ({ id, text, lang, ...(ask !== null ? { ask } : {}), ...(askKind ? { askKind } : {}) }));
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
    if (awayPausesFamily(at)) { setStatus(r.id, `not said at ${r.at}: Away mode was on`, false); continue; }
    if (now - at > LATE_LIMIT_MS) {
      setStatus(r.id, `not said at ${r.at}: HomeHub was off`, false);
      continue;
    }
    if (!getVoiceSettings().enabled) { setStatus(r.id, 'not said: voice control is off', false); continue; }
    const lang = voiceFor(r.text, r.language);
    if (!lang) { setStatus(r.id, 'not said: its language isn’t on in Voice control', false); continue; }
    if (r.ask) {
      const askId = startAsk(r.id, today, now);
      announce(withQuestion(r.text, lang), lang, r.id, now, askId);
    } else {
      announce(r.text, lang, r.id, now);
    }
    n++;
  }
  askAgain(now);
  pendingAnnouncements(now);   // gives up on any the bridge never took, even with no bridge asking
  return n;
}

// ── Asking back ─────────────────────────────────────────────────

export const ASK_AGAIN_MS = 10 * 60_000;
export const MAX_ASKS = 3;

const MEDICINE = /藥|药|thuốc|medicine|medication|meds|pill|tablet/i;

/** "食咗藥未呀？", "Have you taken it?": about medicine if the reminder is, otherwise "done it?". */
export function question(text: string, lang: VoiceLanguage): string {
  const med = MEDICINE.test(text);
  switch (lang) {
    case 'yue': return med ? '食咗藥未呀？' : '做咗未呀？';
    case 'zh': return med ? '吃药了吗？' : '做了吗？';
    case 'vi': return med ? 'Đã uống thuốc chưa?' : 'Đã làm chưa?';
    default: return med ? 'Have you taken it?' : 'Have you done it?';
  }
}

/** The reminder, then its question: "Take your pills. Have you taken it?", "食藥喇。食咗藥未呀？" */
export function withQuestion(text: string, lang: VoiceLanguage): string {
  const chinese = lang === 'yue' || lang === 'zh';
  const ends = /[.!?。！？]$/.test(text.trim());
  return `${text.trim()}${ends ? (chinese ? '' : ' ') : chinese ? '。' : '. '}${question(text, lang)}`;
}

interface AskRow { id: number; reminder_id: number; day: string; first_at: string; last_at: string; asks: number; answer: string | null; answered_at: string | null; answered_by: string | null; told_at: string | null }

const toAskDay = (a: AskRow): AskDay => ({
  id: a.id, day: a.day, answer: (a.answer as 'yes' | 'no' | null), asks: a.asks, answeredAt: a.answered_at, answeredBy: a.answered_by, toldAt: a.told_at,
});

export function recentAnswers(reminderId: number, days = 7): AskDay[] {
  return (getDb().prepare('SELECT * FROM reminder_asks WHERE reminder_id = ? ORDER BY day DESC LIMIT ?').all(reminderId, days) as AskRow[]).map(toAskDay);
}

function startAsk(reminderId: number, day: string, now: number): number {
  const at = new Date(now).toISOString();
  getDb().prepare('INSERT INTO reminder_asks (reminder_id, day, first_at, last_at) VALUES (?, ?, ?, ?) ON CONFLICT(reminder_id, day) DO NOTHING').run(reminderId, day, at, at);
  return (getDb().prepare('SELECT id FROM reminder_asks WHERE reminder_id = ? AND day = ?').get(reminderId, day) as { id: number }).id;
}

/** Questions waiting for an answer, for the bridge: a yes or no heard now answers one of these. */
export function openAsks(now = Date.now()): { id: number; lang: VoiceLanguage }[] {
  const rows = getDb().prepare(`SELECT a.id, r.text, r.language FROM reminder_asks a JOIN reminders r ON r.id = a.reminder_id
    WHERE a.told_at IS NULL AND (a.answer IS NULL OR a.answer = 'no') AND a.last_at >= ? ORDER BY a.last_at DESC`)
    .all(new Date(now - ASK_AGAIN_MS - 60_000).toISOString()) as { id: number; text: string; language: string }[];
  return rows.flatMap((r) => { const lang = voiceFor(r.text, r.language as ReminderLanguage); return lang ? [{ id: r.id, lang }] : []; });
}

/** Tells the family: by push and email, never a call. Replaced in tests. */
let tellFamily = (title: string, body: string): void => {
  sendPushToAll(title, body, { url: '/family' });
  if (emailConfigured()) sendEmail({ subject: title, text: `${body}\n\n— HomeHub` }).catch((err) => logger.warn({ err }, 'Reminder email failed'));
};
export function setTellFamilyForTests(fn: typeof tellFamily): void { tellFamily = fn; }

function tell(a: AskRow, r: Reminder, now: number, said: 'no answer' | 'not yet'): void {
  getDb().prepare('UPDATE reminder_asks SET told_at = ? WHERE id = ?').run(new Date(now).toISOString(), a.id);
  const who = personName();
  const at = new Date(localTime(a.day, r.at)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const how = said === 'not yet' ? `said “not yet” ${a.asks} ${a.asks === 1 ? 'time' : 'times'}` : `didn’t answer, asked ${a.asks} times`;
  tellFamily(`${who} didn’t say “${r.text}” was done`, `The ${at} reminder “${r.text}”: ${who} ${how}. You might want to check.`);
  logger.info({ reminder: r.id, said }, 'Reminder not done: the family was told');
}

/** An answer to "done yet?": yes ends it; no asks again in 10 minutes. False if it isn't open. */
export function answerAsk(askId: number, answer: 'yes' | 'no', by: string, now = Date.now()): boolean {
  const a = getDb().prepare('SELECT * FROM reminder_asks WHERE id = ?').get(askId) as AskRow | undefined;
  if (!a || a.answer === 'yes') return false;
  const at = new Date(now).toISOString();
  if (answer === 'yes') {
    getDb().prepare('UPDATE reminder_asks SET answer = ?, answered_at = ?, answered_by = ? WHERE id = ?').run('yes', at, by, askId);
    if (a.told_at) {
      const r = getReminder(a.reminder_id);
      if (r) tellFamily(`“${r.text}” is done`, `${by === 'voice' ? personName() : by} said it’s done, at ${new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`);
    }
    return true;
  }
  getDb().prepare('UPDATE reminder_asks SET answer = ?, answered_at = ?, answered_by = ?, last_at = ? WHERE id = ?').run('no', at, by, at, askId);
  return true;
}

/** Asks again when 10 minutes have passed with no yes; after the last try, tells the family. */
export function askAgain(now = Date.now()): void {
  const rows = getDb().prepare(`SELECT * FROM reminder_asks WHERE told_at IS NULL AND (answer IS NULL OR answer = 'no') AND last_at <= ?`)
    .all(new Date(now - ASK_AGAIN_MS).toISOString()) as AskRow[];
  for (const a of rows) {
    const r = getReminder(a.reminder_id);
    if (!r) continue;
    if (now - Date.parse(a.first_at) > 3 * 3_600_000) {   // HomeHub was off: too late to ask or tell
      getDb().prepare('UPDATE reminder_asks SET told_at = ? WHERE id = ?').run(new Date(now).toISOString(), a.id);
      continue;
    }
    if (a.asks >= MAX_ASKS) { tell(a, r, now, a.answer === 'no' ? 'not yet' : 'no answer'); continue; }
    const lang = voiceFor(r.text, r.language);
    if (!lang || !getVoiceSettings().enabled) { tell(a, r, now, 'no answer'); continue; }
    getDb().prepare('UPDATE reminder_asks SET asks = asks + 1, last_at = ? WHERE id = ?').run(new Date(now).toISOString(), a.id);
    announce(withQuestion(r.text, lang), lang, r.id, now, a.id);
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startReminders(): void {
  timer = setInterval(() => { try { checkReminders(); } catch (err) { logger.error({ err }, 'Reminders failed'); } }, TICK_MS);
  timer.unref?.();
}
export function stopReminders(): void { if (timer) clearInterval(timer); timer = undefined; }
