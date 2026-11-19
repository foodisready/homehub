import { getDb } from '../db';
import { logger } from '../logger';
import { upIntervals } from '../energy/usage';
import { isActiveServer } from '../system/role';
import { awayPausesFamily } from '../home/away-state';
import { sendPushToAll } from '../push/push.service';
import { emailConfigured, emailRecipients, sendEmail } from '../notifications/providers/email';
import { getVoiceSettings, type VoiceLanguage } from '../system/voice-bridge';
import { announce, announcementStatus, voiceFor, type ReminderLanguage } from './reminders';

/**
 * A daily check-in for someone who lives alone: if nothing at home shows they're up and about
 * by a set time, the family is told, and told again as soon as something does.
 *
 * Signs someone is there, between `from` and `by` each day (the home's local time):
 * - a light or plug switched by a person: a wall switch or the device's own app ("outside"),
 *   a voice or chat command, the HomeHub app, or a scene one of those ran. Schedules, timers and
 *   HomeHub's own switching don't count. App use counts only for the people chosen, so a
 *   daughter switching her mother's lamp from across town doesn't read as her mother being up.
 * - a voice command that was understood. A miss doesn't count: a TV left on wakes the speaker.
 * - water starting to run, from a flow sensor: a tap, a toilet, the kettle.
 * - motion from a motion sensor. Ring cameras don't count by default: they see the street.
 *
 * It can ask at home first: at the check time a speaker asks "亞娘，你冇事吖嘛？" and listens. "冇事"
 * (any "I'm OK", in the person's language) means no alert; "唔舒服" (I'm not OK) tells the family at
 * once; no answer, and it asks once more 5 minutes later, then tells them. Any other sign while it
 * waits counts too. Speakers that can't listen straight after need the wake word first.
 *
 * Checked by the active server only, so a paired backup doesn't send the same alert again.
 * Days and times are local: the process clock runs in the home's time zone.
 */

export interface Checkin {
  id: number;
  name: string;
  enabled: boolean;
  from: string;
  by: string;
  days: number[];
  devices: number[] | null;
  motion: number[] | null;
  appUsers: string[] | null;
  voice: boolean;
  water: boolean;
  /** Ask at home before telling the family. */
  askFirst: boolean;
  /** The language to ask in: 'auto' reads it from the name. */
  askLang: ReminderLanguage;
  pausedUntil: string | null;
  lastDay: string | null;
  lastResult: 'ok' | 'asking' | 'alerted' | 'all-clear' | 'missed' | null;
  lastSignAt: string | null;
  lastSign: string | null;
  alertedAt: string | null;
  /** The question asked at home on lastDay, if it asked. */
  lastAsk: CheckinAsk | null;
}

interface Row {
  id: number; name: string; enabled: number; from_time: string; by_time: string; days: string;
  devices: string | null; motion: string | null; app_users: string | null; voice: number; water: number;
  ask_first: number; ask_lang: string; paused_until: string | null; last_day: string | null; last_result: string | null;
  last_sign_at: string | null; last_sign: string | null; alerted_at: string | null;
}

export interface Sign { at: string; what: string }

export class CheckinError extends Error {}

/** How late a check can still be made, when HomeHub was off at the time. */
const LATE_LIMIT_MS = 3 * 60 * 60 * 1000;
/** Below this share of the window with HomeHub running, the alert says it may have missed something. */
const MOSTLY_RUNNING = 0.9;
const TICK_MS = 60_000;

const PERSON_SOURCES = ['outside', 'voice', 'chat', 'assistant'];
const APP_SOURCES = ['app'];
const STARTED_BY_PERSON = ['app', 'voice', 'chat', 'assistant'];

const json = <T>(s: string | null): T | null => { try { return s ? JSON.parse(s) as T : null; } catch { return null; } };
const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** A local day and "HH:MM" as a time. A time skipped when clocks go forward lands just after. */
export function localTime(day: string, hhmm: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  return new Date(y, m - 1, d, h, min).getTime();
}
const sqlUtc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const fromSql = (s: string) => new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).toISOString();
export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function toCheckin(r: Row): Checkin {
  return {
    id: r.id, name: r.name, enabled: !!r.enabled, from: r.from_time, by: r.by_time,
    days: [...r.days].map(Number), devices: json<number[]>(r.devices), motion: json<number[]>(r.motion),
    appUsers: json<string[]>(r.app_users), voice: !!r.voice, water: !!r.water,
    askFirst: !!r.ask_first, askLang: (r.ask_lang || 'auto') as ReminderLanguage,
    pausedUntil: r.paused_until, lastDay: r.last_day, lastResult: r.last_result as Checkin['lastResult'],
    lastSignAt: r.last_sign_at, lastSign: r.last_sign, alertedAt: r.alerted_at,
    lastAsk: r.last_day ? todaysAsk(r.id, r.last_day) : null,
  };
}

export function listCheckins(): Checkin[] {
  return (getDb().prepare('SELECT * FROM checkins ORDER BY id').all() as Row[]).map(toCheckin);
}

export function getCheckin(id: number): Checkin | null {
  const r = getDb().prepare('SELECT * FROM checkins WHERE id = ?').get(id) as Row | undefined;
  return r ? toCheckin(r) : null;
}

// ── Settings ────────────────────────────────────────────────────

export type CheckinSettings = Pick<Checkin, 'from' | 'by' | 'devices' | 'motion' | 'appUsers' | 'voice' | 'water'>;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ids = (v: unknown, what: string): number[] | null => {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v) || v.length > 500 || !v.every((x) => Number.isInteger(x) && x > 0)) throw new CheckinError(`${what} must be a list of ids, or null for all`);
  return [...new Set(v as number[])];
};

/** The parts that decide what counts and when, checked. */
export function readSettings(input: Record<string, unknown>, base?: CheckinSettings): CheckinSettings {
  const from = input['from'] ?? base?.from ?? '05:00';
  const by = input['by'] ?? base?.by ?? '11:00';
  if (typeof from !== 'string' || !HHMM.test(from)) throw new CheckinError('from must be a time, HH:MM');
  if (typeof by !== 'string' || !HHMM.test(by)) throw new CheckinError('by must be a time, HH:MM');
  if (from >= by) throw new CheckinError('The check time must be after the time it starts looking');
  const appUsers = 'appUsers' in input ? input['appUsers'] : base?.appUsers ?? null;
  if (appUsers !== null && (!Array.isArray(appUsers) || appUsers.length > 50 || !appUsers.every((u) => typeof u === 'string'))) {
    throw new CheckinError('appUsers must be a list of names, or null for everyone');
  }
  const bool = (k: 'voice' | 'water') => (k in input ? input[k] === true : base?.[k] ?? true);
  return {
    from, by,
    devices: 'devices' in input ? ids(input['devices'], 'devices') : base?.devices ?? null,
    motion: 'motion' in input ? ids(input['motion'], 'motion') : base?.motion ?? null,
    appUsers: appUsers as string[] | null,
    voice: bool('voice'), water: bool('water'),
  };
}

export function saveCheckin(input: unknown, id?: number): Checkin {
  if (!input || typeof input !== 'object') throw new CheckinError('Expected an object');
  const b = input as Record<string, unknown>;
  const existing = id ? getCheckin(id) : null;
  if (id && !existing) throw new CheckinError('No such check-in');
  const name = typeof b['name'] === 'string' ? b['name'].trim() : existing?.name ?? '';
  if (!name || name.length > 60) throw new CheckinError('A name is required, up to 60 characters');
  const s = readSettings(b, existing ?? undefined);
  const days = b['days'] ?? existing?.days ?? [0, 1, 2, 3, 4, 5, 6];
  if (!Array.isArray(days) || !days.length || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    throw new CheckinError('days must be a list of weekdays, 0 (Sunday) to 6');
  }
  const enabled = 'enabled' in b ? b['enabled'] === true : existing?.enabled ?? true;
  const askFirst = 'askFirst' in b ? b['askFirst'] === true : existing?.askFirst ?? false;
  const askLang = (b['askLang'] ?? existing?.askLang ?? 'auto') as ReminderLanguage;
  if (!ASK_LANGUAGES.includes(askLang)) throw new CheckinError(`askLang must be one of ${ASK_LANGUAGES.join(', ')}`);
  if (askFirst && !askLanguage(name, askLang)) {
    throw new CheckinError('To ask at home, turn on voice control and the language to ask in, in Settings → Voice control');
  }
  const paused = 'pausedUntil' in b ? b['pausedUntil'] : existing?.pausedUntil ?? null;
  if (paused !== null && (typeof paused !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(paused))) throw new CheckinError('pausedUntil must be a day, YYYY-MM-DD, or null');
  const values = [
    name, enabled ? 1 : 0, s.from, s.by, [...new Set(days as number[])].sort().join(''),
    s.devices ? JSON.stringify(s.devices) : null, s.motion ? JSON.stringify(s.motion) : null,
    s.appUsers ? JSON.stringify(s.appUsers) : null, s.voice ? 1 : 0, s.water ? 1 : 0, paused, askFirst ? 1 : 0, askLang,
  ];
  const db = getDb();
  if (existing) {
    // A new check time today is checked again, unless an alert already went out.
    const recheck = existing.lastDay === dayKey(new Date()) && existing.lastResult !== 'alerted' && existing.lastResult !== 'all-clear'
      && existing.lastResult !== 'asking' && (existing.by !== s.by || existing.from !== s.from);
    db.prepare(`UPDATE checkins SET name = ?, enabled = ?, from_time = ?, by_time = ?, days = ?, devices = ?, motion = ?,
      app_users = ?, voice = ?, water = ?, paused_until = ?, ask_first = ?, ask_lang = ?${recheck ? ', last_day = NULL, last_result = NULL' : ''} WHERE id = ?`).run(...values, existing.id);
    return getCheckin(existing.id)!;
  }
  // A new check-in starts tomorrow if today's check time has passed: no alert for a morning it wasn't watching.
  const today = dayKey(new Date());
  const startsLater = Date.now() >= localTime(today, s.by);
  const r = db.prepare(`INSERT INTO checkins (name, enabled, from_time, by_time, days, devices, motion, app_users, voice, water, paused_until,
    ask_first, ask_lang, last_day, last_result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...values, startsLater ? today : null, null);
  return getCheckin(Number(r.lastInsertRowid))!;
}

export function deleteCheckin(id: number): boolean {
  return getDb().prepare('DELETE FROM checkins WHERE id = ?').run(id).changes > 0;
}

// ── Signs someone is there ──────────────────────────────────────

interface EventRow { at: string; device_id: number | null; device_alias: string; state: number; source: string; detail: string | null; via: string | null; user_name: string | null }

/** Motion rules that count: those chosen, else every one but those watching through a Ring camera. */
function countedRules(s: CheckinSettings): { id: number; name: string }[] {
  const rules = getDb().prepare('SELECT id, name, ring_camera_id FROM motion_rules').all() as { id: number; name: string; ring_camera_id: number | null }[];
  return rules.filter((r) => (s.motion ? s.motion.includes(r.id) : r.ring_camera_id === null));
}

const HOW: Record<string, string> = {
  outside: 'at the switch', voice: 'by voice', chat: 'from Chat', assistant: 'by the AI assistant', app: 'in the app',
};

/** Every sign between two times, earliest first. `limit` stops at the first few. */
export function signsBetween(s: CheckinSettings, from: number, to: number, limit = 50): Sign[] {
  const db = getDb();
  const out: Sign[] = [];
  const devices = s.devices ? new Set(s.devices) : null;
  const rules = countedRules(s);
  const ruleNames = new Set(rules.map((r) => r.name));
  const events = db.prepare(`SELECT at, device_id, device_alias, state, source, detail, via, user_name FROM device_events
    WHERE kind = 'power' AND at >= ? AND at < ? ORDER BY at LIMIT 2000`).all(new Date(from).toISOString(), new Date(to).toISOString()) as EventRow[];
  for (const e of events) {
    if (devices && (e.device_id === null || !devices.has(e.device_id))) continue;
    const appOk = (who: string | null) => !s.appUsers || (who !== null && s.appUsers.includes(who));
    let how: string | null = null;
    if (PERSON_SOURCES.includes(e.source)) how = HOW[e.source];
    else if (APP_SOURCES.includes(e.source) && appOk(e.user_name)) how = `${HOW.app}${e.user_name ? ` by ${e.user_name}` : ''}`;
    else if (e.source === 'scene' && e.via && STARTED_BY_PERSON.includes(e.via) && (e.via !== 'app' || appOk(e.user_name))) how = `by the scene ${e.detail ?? ''}`.trim();
    else if (e.source === 'motion' && e.detail && ruleNames.has(e.detail)) how = 'by motion';
    if (!how) continue;
    out.push({ at: e.at, what: `${e.device_alias} turned ${e.state ? 'on' : 'off'} ${how}` });
  }
  if (s.voice) {
    const rows = db.prepare('SELECT text, created_at FROM voice_commands WHERE understood = 1 AND created_at >= ? AND created_at < ? ORDER BY id LIMIT ?')
      .all(sqlUtc(from), sqlUtc(to), limit) as { text: string; created_at: string }[];
    for (const r of rows) out.push({ at: fromSql(r.created_at), what: `a voice command: “${r.text.slice(0, 60)}”` });
  }
  if (s.water) {
    const rows = db.prepare('SELECT start_time FROM flow_events WHERE start_time >= ? AND start_time < ? ORDER BY start_time LIMIT ?')
      .all(sqlUtc(from), sqlUtc(to), limit) as { start_time: string }[];
    for (const r of rows) out.push({ at: fromSql(r.start_time), what: 'water used' });
  }
  if (rules.length) {
    const rows = db.prepare(`SELECT rule_id, at FROM motion_seen WHERE at >= ? AND at < ? AND rule_id IN (${rules.map(() => '?').join(',')}) ORDER BY at LIMIT ?`)
      .all(new Date(from).toISOString(), new Date(to).toISOString(), ...rules.map((r) => r.id), limit) as { rule_id: number; at: string }[];
    const names = new Map(rules.map((r) => [r.id, r.name]));
    for (const r of rows) out.push({ at: r.at, what: `motion: ${names.get(r.rule_id)}` });
  }
  // A call for help shows they're up too; the SOS tells the family itself, so the check-in needn't.
  const sos = db.prepare('SELECT started_at, via FROM sos_alerts WHERE started_at >= ? AND started_at < ? ORDER BY started_at LIMIT ?')
    .all(new Date(from).toISOString(), new Date(to).toISOString(), limit) as { started_at: string; via: string }[];
  for (const r of sos) out.push({ at: r.started_at, what: `a call for help (${r.via})` });
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(0, limit);
}

/** The share of a time HomeHub was running, 0 to 1. */
export function runningShare(from: number, to: number): number {
  if (to <= from) return 1;
  const up = upIntervals(from, to).reduce((t, [s, e]) => t + (e - s), 0);
  return Math.min(1, up / (to - from));
}

// ── The last two weeks, to choose a time ────────────────────────

export interface PreviewDay { day: string; weekday: number; first: Sign | null; alert: boolean; homehubOff: boolean }

/** What these settings would have done on each of the last `days` finished days. */
export function preview(s: CheckinSettings, checkDays: number[] = [0, 1, 2, 3, 4, 5, 6], days = 14, now = new Date()): PreviewDay[] {
  const out: PreviewDay[] = [];
  for (let i = days; i >= 1; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const day = dayKey(d);
    const from = localTime(day, s.from);
    const by = localTime(day, s.by);
    const first = signsBetween(s, from, by, 1)[0] ?? null;
    // A morning HomeHub wasn't running at all says nothing either way.
    const homehubOff = runningShare(from, by) < 0.05;
    out.push({ day, weekday: d.getDay(), first, alert: !first && !homehubOff && checkDays.includes(d.getDay()), homehubOff });
  }
  return out;
}

// ── Who is told ─────────────────────────────────────────────────

/** Who would be told: phones with notifications on (and whose they are), and email addresses. */
export interface Audience { phones: number; people: string[]; emails: number }

export function audience(): Audience {
  const rows = getDb().prepare(`
    SELECT u.name, COUNT(*) n FROM push_subscriptions p JOIN users u ON u.id = p.user_id GROUP BY u.id ORDER BY u.name
  `).all() as { name: string; n: number }[];
  const phones = (getDb().prepare('SELECT COUNT(*) n FROM push_subscriptions').get() as { n: number }).n;
  return { phones, people: rows.map((r) => r.name), emails: emailConfigured() ? emailRecipients().length : 0 };
}

/**
 * Push and email. An alert is urgent: it reaches a sleeping phone at once, buzzes longer and stays on
 * screen. The all-clear after it takes its place on the phone.
 */
let tell = async (title: string, body: string, urgent = false): Promise<void> => {
  sendPushToAll(title, body, { url: '/family', tag: 'homehub-checkin', ...(urgent ? { urgent: true } : {}) });
  if (emailConfigured()) {
    await sendEmail({ subject: title, text: `${body}\n\n— HomeHub` }).catch((err) => logger.warn({ err }, 'Check-in email failed'));
  }
};
export function setTellForTests(fn: typeof tell): void { tell = fn; }

export async function sendTest(c: Checkin): Promise<Audience> {
  await tell(`Test: daily check-in for ${c.name}`, `This is how HomeHub will tell you if there's no sign of ${c.name} by ${clock(localTime(dayKey(new Date()), c.by))}. Nothing is wrong.`, true);
  return audience();
}

// ── Checking ────────────────────────────────────────────────────

function nothingSeen(s: CheckinSettings): string {
  const kinds = ['no lights or plugs switched'];
  if (s.voice) kinds.push('no voice commands');
  if (s.water) kinds.push('no water used');
  if (countedRules(s).length) kinds.push('no motion');
  return kinds.join(', ');
}

function setResult(id: number, fields: Partial<Record<'last_day' | 'last_result' | 'last_sign_at' | 'last_sign' | 'alerted_at', string | null>>): void {
  const keys = Object.keys(fields);
  getDb().prepare(`UPDATE checkins SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k as keyof typeof fields] ?? null), id);
}

/** One check of one check-in. Returns what it did, for tests and the log. */
export async function checkOne(c: Checkin, now = Date.now()): Promise<'waiting' | 'ok' | 'asking' | 'alerted' | 'all-clear' | 'missed' | 'skipped'> {
  const today = dayKey(new Date(now));
  if (!c.enabled) return 'skipped';
  if (c.lastDay === today && c.lastResult === 'asking') return whileAsking(c, today, now);
  // After an alert, the rest of the day is watched for the first sign, to say all is well.
  if (c.lastDay === today && c.lastResult === 'alerted') {
    const since = localTime(today, c.by);
    const sign = signsBetween(c, since, now, 1)[0];
    if (!sign) return 'waiting';
    setResult(c.id, { last_result: 'all-clear', last_sign_at: sign.at, last_sign: sign.what });
    await tell(`${c.name}: activity at home`, `Activity at home at ${clock(Date.parse(sign.at))}: ${sign.what}.`);
    logger.info({ checkin: c.name, sign: sign.what }, 'Check-in: activity after the alert');
    return 'all-clear';
  }
  if (c.lastDay === today) return 'skipped';
  if (!c.days.includes(new Date(now).getDay())) return 'skipped';
  if (c.pausedUntil && c.pausedUntil >= today) return 'skipped';
  const from = localTime(today, c.from);
  const by = localTime(today, c.by);
  // Away mode, or back later today: nobody's expected home, so the day isn't checked, then or after.
  if (awayPausesFamily(from)) {
    if (now >= by) setResult(c.id, { last_day: today, last_result: 'away', last_sign_at: null, last_sign: null });
    return 'skipped';
  }
  if (now < by) return 'waiting';
  if (now - by > LATE_LIMIT_MS) {
    setResult(c.id, { last_day: today, last_result: 'missed', last_sign_at: null, last_sign: null });
    logger.warn({ checkin: c.name }, 'Check-in: HomeHub was off at the check time, too long ago to check now');
    return 'missed';
  }
  // Checked late (HomeHub was off at the time): anything up to now counts.
  const sign = signsBetween(c, from, Math.max(by, now), 1)[0];
  if (sign) {
    setResult(c.id, { last_day: today, last_result: 'ok', last_sign_at: sign.at, last_sign: sign.what });
    return 'ok';
  }
  if (c.askFirst) {
    const lang = askLanguage(c.name, c.askLang);
    if (lang) {
      startAsking(c, today, lang, now);
      setResult(c.id, { last_day: today, last_result: 'asking', last_sign_at: null, last_sign: null });
      logger.info({ checkin: c.name, lang }, 'Check-in: no activity, asking at home first');
      return 'asking';
    }
    return alert(c, today, now, ' HomeHub couldn\'t ask at home: voice control, or the language to ask in, is off.');
  }
  return alert(c, today, now);
}

async function alert(c: Checkin, today: string, now: number, note = '', title?: string): Promise<'alerted'> {
  const from = localTime(today, c.from);
  const by = localTime(today, c.by);
  const share = runningShare(from, by);
  const off = share < MOSTLY_RUNNING ? ' HomeHub was off for part of that time, so it may have missed something.' : '';
  setResult(c.id, { last_day: today, last_result: 'alerted', last_sign_at: null, last_sign: null, alerted_at: new Date(now).toISOString() });
  logger.warn({ checkin: c.name, running: Math.round(share * 100), note: note.trim() || undefined }, 'Check-in: no activity, telling the family');
  await tell(
    title ?? `No sign of ${c.name} this morning`,
    `Nothing at home since ${clock(from)}: ${nothingSeen(c)}.${off}${note} You may want to call ${c.name}. HomeHub will tell you when it sees activity.`,
    true,
  );
  return 'alerted';
}

// ── Asking at home first ────────────────────────────────────────

export const ASK_LANGUAGES: ReminderLanguage[] = ['auto', 'en', 'yue', 'zh', 'vi'];
/** How long to wait for an answer before asking again, and how many times to ask. */
export const CHECKIN_ASK_AGAIN_MS = 5 * 60_000;
export const CHECKIN_MAX_ASKS = 2;

/** The language to ask in, if voice control is on and has it. 'auto' reads it from the name: 亞娘 is Cantonese. */
export function askLanguage(name: string, lang: ReminderLanguage): VoiceLanguage | null {
  const voice = getVoiceSettings();
  if (!voice.enabled) return null;
  return voiceFor(name, lang, voice.languages);
}

/** "亞娘，你冇事吖嘛？冇事就講「冇事」。" The answer it suggests is one the speaker understands. */
export function askText(name: string, lang: VoiceLanguage): string {
  switch (lang) {
    case 'yue': return `${name}，你冇事吖嘛？冇事就講「冇事」。`;
    case 'zh': return `${name}，你还好吗？没事就说“没事”。`;
    case 'vi': return `${name} ơi, có khỏe không? Không sao thì nói “không sao” nhé.`;
    default: return `${name}, are you OK? If you're fine, say "I'm OK".`;
  }
}

interface AskRow { id: number; checkin_id: number; day: string; lang: string; first_at: string; last_at: string; asks: number; said: number; answer: string | null; answered_at: string | null; closed_at: string | null }

/** Today's question, if it asked. */
export interface CheckinAsk { firstAt: string; asks: number; said: number; answer: 'yes' | 'no' | null; answeredAt: string | null; closed: boolean }

export function todaysAsk(checkinId: number, today: string): CheckinAsk | null {
  const a = getDb().prepare('SELECT * FROM checkin_asks WHERE checkin_id = ? AND day = ?').get(checkinId, today) as AskRow | undefined;
  return a ? { firstAt: a.first_at, asks: a.asks, said: a.said, answer: a.answer as CheckinAsk['answer'], answeredAt: a.answered_at, closed: !!a.closed_at } : null;
}

/** The announcement saying each question, to learn whether a speaker said it. */
const saying = new Map<number, string>();

function startAsking(c: Checkin, today: string, lang: VoiceLanguage, now: number): void {
  const at = new Date(now).toISOString();
  const db = getDb();
  db.prepare('DELETE FROM checkin_asks WHERE checkin_id = ? AND day = ?').run(c.id, today);
  const id = Number(db.prepare('INSERT INTO checkin_asks (checkin_id, day, lang, first_at, last_at) VALUES (?, ?, ?, ?, ?)')
    .run(c.id, today, lang, at, at).lastInsertRowid);
  saying.set(id, announce(askText(c.name, lang), lang, null, Date.now(), id, 'checkin'));
}

function closeAsk(id: number, now: number): void {
  saying.delete(id);
  getDb().prepare('UPDATE checkin_asks SET closed_at = ? WHERE id = ?').run(new Date(now).toISOString(), id);
}

/** Whether a speaker said the last question: true, false (none could), or null (not known yet, or forgotten after a restart). */
function lastSaid(a: AskRow): boolean | null {
  const announcement = saying.get(a.id);
  const st = announcement ? announcementStatus(announcement) : null;
  if (!st || st.state === 'waiting') return null;
  saying.delete(a.id);
  if (st.state === 'said') getDb().prepare('UPDATE checkin_asks SET said = said + 1 WHERE id = ?').run(a.id);
  return st.state === 'said';
}

async function whileAsking(c: Checkin, today: string, now: number): Promise<'asking' | 'ok' | 'alerted'> {
  const a = getDb().prepare('SELECT * FROM checkin_asks WHERE checkin_id = ? AND day = ?').get(c.id, today) as AskRow | undefined;
  if (!a) return alert(c, today, now);
  const first = Date.parse(a.first_at);
  // Something at home while it waited, or since the morning began: they're up.
  const sign = signsBetween(c, localTime(today, c.from), now, 1)[0];
  if (sign || a.answer === 'yes') {
    closeAsk(a.id, now);
    const what = sign ? sign.what : `said they're OK when asked at home`;
    setResult(c.id, { last_result: 'ok', last_sign_at: sign ? sign.at : a.answered_at, last_sign: what });
    logger.info({ checkin: c.name, sign: what }, 'Check-in: fine after asking at home');
    return 'ok';
  }
  if (a.answer === 'no') {
    closeAsk(a.id, now);
    return alert(c, today, now, ` When HomeHub asked at home at ${clock(first)}, ${c.name} said they're not OK.`, `${c.name} said they're not OK`);
  }
  const said = lastSaid(a);
  const saidAny = a.said + (said ? 1 : 0) > 0;
  if (said === false && !saidAny) {
    closeAsk(a.id, now);
    return alert(c, today, now, ' HomeHub tried to ask at home first, but no speaker could say it.');
  }
  if (now - Date.parse(a.last_at) < CHECKIN_ASK_AGAIN_MS) return 'asking';
  if (a.asks < CHECKIN_MAX_ASKS) {
    const lang = a.lang as VoiceLanguage;
    getDb().prepare('UPDATE checkin_asks SET asks = asks + 1, last_at = ? WHERE id = ?').run(new Date(now).toISOString(), a.id);
    saying.set(a.id, announce(askText(c.name, lang), lang, null, Date.now(), a.id, 'checkin'));
    return 'asking';
  }
  closeAsk(a.id, now);
  const times = [first, Date.parse(a.last_at)].filter((t, i, all) => all.indexOf(t) === i).map(clock).join(' and ');
  return alert(c, today, now, saidAny
    ? ` HomeHub asked at home at ${times} and nobody answered.`
    : ' HomeHub tried to ask at home first, but it isn\'t known whether a speaker said it.');
}

/** Questions waiting for an answer, for the bridge: "冇事" or "唔舒服" heard now answers one. */
export function openCheckinAsks(): { id: number; lang: VoiceLanguage; kind: 'checkin' }[] {
  const rows = getDb().prepare('SELECT id, lang FROM checkin_asks WHERE closed_at IS NULL AND answer IS NULL').all() as { id: number; lang: string }[];
  return rows.map((r) => ({ id: r.id, lang: r.lang as VoiceLanguage, kind: 'checkin' }));
}

/** An answer heard: yes (I'm OK) or no (I'm not). The next check acts on it, straight away. False if it isn't asking. */
export function answerCheckinAsk(id: number, answer: 'yes' | 'no', now = Date.now()): boolean {
  const r = getDb().prepare('UPDATE checkin_asks SET answer = ?, answered_at = ? WHERE id = ? AND closed_at IS NULL AND answer IS NULL')
    .run(answer, new Date(now).toISOString(), id);
  if (!r.changes) return false;
  void checkAll(now);
  return true;
}

/** One check at a time: an answer heard checks straight away, and mustn't race the minute's check. */
let checking: Promise<void> = Promise.resolve();
export function checkAll(now?: number): Promise<void> {
  checking = checking.then(async () => {
    if (!isActiveServer()) return;
    for (const c of listCheckins()) {
      try { await checkOne(c, now ?? Date.now()); } catch (err) { logger.error({ err, checkin: c.name }, 'Check-in failed'); }
    }
  });
  return checking;
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startCheckins(): void {
  timer = setInterval(() => { void checkAll(); }, TICK_MS);
  timer.unref?.();
  void checkAll();
}
export function stopCheckins(): void { if (timer) clearInterval(timer); timer = undefined; }
