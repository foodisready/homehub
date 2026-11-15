import { randomBytes } from 'node:crypto';
import { getDb } from '../db';
import { logger } from '../logger';
import { sendPushToAll } from '../push/push.service';
import { emailConfigured, emailRecipients, sendEmail } from '../notifications/providers/email';
import { placeCall, readTwilioConfig, sendTexts, twilioReady } from '../notifications/providers/sms';
import { isActiveServer } from '../system/role';
import { getVoiceSettings, type VoiceLanguage } from '../system/voice-bridge';
import { announce } from './reminders';
import { listCheckins } from './checkin';

/**
 * SOS: a way for someone at home to call for help, by voice ("救命", "cứu tôi", "help me"), with a
 * button, or in the app. It goes out at once, with no "are you sure?" (someone who has fallen may
 * not manage a second exchange), and is said again every few minutes until someone in the family
 * says they're on it. The speaker at home then says who's coming.
 *
 * Push and email are free and always used. Texts and phone calls go out too if Twilio is set up:
 * a text to every number on the first round, and a call to one number each round, in turn, so it
 * doesn't ring everyone at once in the night unless nobody answers.
 *
 * It doesn't call 911 and isn't a monitored service; the Family page says so.
 */

export const ROUND_EVERY_MS = 5 * 60_000;
export const ROUNDS = 6;
/** A second call for help within this long is the same one. */
export const SAME_ALERT_MS = 60 * 60_000;
const TICK_MS = 30_000;

export type Via = 'voice' | 'button' | 'app';
export type SosState = 'raised' | 'already' | 'cancelled' | 'nothing';

export interface SosAlert {
  id: number;
  startedAt: string;
  via: Via;
  place: string | null;
  who: string;
  lang: VoiceLanguage | null;
  heard: string | null;
  rounds: number;
  lastRoundAt: string | null;
  told: Told | null;
  ackedAt: string | null;
  ackedBy: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  endedAt: string | null;
}

/** Who was told on the first round. */
export interface Told { phones: number; emails: number; texts: number; calls: number }

export interface SosSettings {
  /** The person it's for, as the family says it: "Mum". Null: the check-in's name, or "Someone". */
  who: string | null;
  /** Phone calls each round, with Twilio. Off unless chosen: they cost money. */
  calls: boolean;
}

interface Row {
  id: number; started_at: string; via: Via; place: string | null; who: string | null; lang: string | null; heard: string | null;
  rounds: number; last_round_at: string | null; told: string | null; acked_at: string | null; acked_by: string | null;
  cancelled_at: string | null; cancelled_by: string | null; ended_at: string | null;
}

const toAlert = (r: Row): SosAlert => ({
  id: r.id, startedAt: r.started_at, via: r.via, place: r.place, who: r.who ?? 'Someone', lang: (r.lang as VoiceLanguage) ?? null,
  heard: r.heard, rounds: r.rounds, lastRoundAt: r.last_round_at, told: r.told ? JSON.parse(r.told) : null,
  ackedAt: r.acked_at, ackedBy: r.acked_by, cancelledAt: r.cancelled_at, cancelledBy: r.cancelled_by, endedAt: r.ended_at,
});

// ── Settings ────────────────────────────────────────────────────

const SETTINGS_KEY = 'sos_settings';

export function getSosSettings(): SosSettings {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined;
    const v = row ? JSON.parse(row.value) : {};
    return { who: typeof v.who === 'string' && v.who.trim() ? v.who.trim() : null, calls: v.calls === true };
  } catch {
    return { who: null, calls: false };
  }
}

export function saveSosSettings(input: unknown): SosSettings {
  const v = (input ?? {}) as Record<string, unknown>;
  const now = getSosSettings();
  const next: SosSettings = { ...now };
  if ('who' in v) {
    if (v.who !== null && typeof v.who !== 'string') throw new SosError('The name must be text');
    const who = typeof v.who === 'string' ? v.who.trim() : '';
    if (who.length > 40) throw new SosError('The name is too long');
    next.who = who || null;
  }
  if ('calls' in v) {
    if (typeof v.calls !== 'boolean') throw new SosError('calls must be true or false');
    next.calls = v.calls;
  }
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export class SosError extends Error {}

/** Who the SOS is for: the name set here, else the only check-in's, else "Someone". */
export function personName(): string {
  const set = getSosSettings().who;
  if (set) return set;
  const checkins = listCheckins();
  return checkins.length === 1 ? checkins[0].name : 'Someone';
}

// ── Alerts ──────────────────────────────────────────────────────

export function getAlert(id: number): SosAlert | null {
  const r = getDb().prepare('SELECT * FROM sos_alerts WHERE id = ?').get(id) as Row | undefined;
  return r ? toAlert(r) : null;
}

/** The call for help still going: not cancelled, not given up on, and recent. */
export function openAlert(now = Date.now()): SosAlert | null {
  const r = getDb().prepare(`SELECT * FROM sos_alerts WHERE cancelled_at IS NULL AND ended_at IS NULL AND started_at >= ?
    ORDER BY id DESC LIMIT 1`).get(new Date(now - SAME_ALERT_MS).toISOString()) as Row | undefined;
  return r ? toAlert(r) : null;
}

export function recentAlerts(limit = 10): SosAlert[] {
  return (getDb().prepare('SELECT * FROM sos_alerts ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map(toAlert);
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** "by voice on Kitchen speaker", "with the Bedside button", "in the app (Mum)". */
export function howText(a: Pick<SosAlert, 'via' | 'place'>): string {
  if (a.via === 'voice') return a.place ? `by voice on ${a.place}` : 'by voice';
  if (a.via === 'button') return a.place ? `with the ${a.place} button` : 'with a button';
  return a.place ? `in the app (${a.place})` : 'in the app';
}

const remote = () => process.env.HOMEHUB_REMOTE_URL?.replace(/\/+$/, '') || null;

/** How each way of telling is done: replaced in tests. */
export interface Senders {
  push(title: string, body: string): void;
  email(subject: string, text: string): Promise<number>;
  texts(text: string): Promise<number>;
  call(to: string, text: string): Promise<boolean>;
  callNumbers(): string[];
  announce(text: string, lang: VoiceLanguage): void;
}

const realSenders: Senders = {
  push: (title, body) => sendPushToAll(title, body, { url: '/family', urgent: true }),
  email: async (subject, text) => {
    if (!emailConfigured()) return 0;
    try {
      await sendEmail({ subject, text: `${text}\n\n— HomeHub` });
      return emailRecipients().length;
    } catch (err) {
      logger.warn({ err }, 'SOS email failed');
      return 0;
    }
  },
  texts: async (text) => sendTexts(text).catch((err) => { logger.warn({ err }, 'SOS texts failed'); return 0; }),
  call: async (to, text) => placeCall(to, text).then(() => true, (err) => { logger.warn({ err }, 'SOS call failed'); return false; }),
  callNumbers: () => (getSosSettings().calls && twilioReady() ? readTwilioConfig().recipients : []),
  announce: (text, lang) => { announce(text, lang); },
};
let senders: Senders = realSenders;
export function setSendersForTests(s: Partial<Senders> | null): void { senders = s ? { ...realSenders, ...s } : realSenders; }

/** How many phones, email addresses and text numbers a call for help reaches. */
export function reach(): number {
  return phones() + (emailConfigured() ? emailRecipients().length : 0) + (twilioReady() ? readTwilioConfig().recipients.length : 0);
}

const phones = () => (getDb().prepare('SELECT COUNT(*) n FROM push_subscriptions').get() as { n: number }).n;

/** One round of telling the family. The first also emails and texts; each calls the next number. */
async function round(a: SosAlert, now: number): Promise<void> {
  const n = a.rounds + 1;
  getDb().prepare('UPDATE sos_alerts SET rounds = ?, last_round_at = ? WHERE id = ?').run(n, new Date(now).toISOString(), a.id);
  const how = howText(a);
  const at = clock(a.startedAt);
  const again = n > 1 ? ` (still no answer, ${Math.round((now - Date.parse(a.startedAt)) / 60_000)} min)` : '';
  const title = `SOS: ${a.who} asked for help${again}`;
  const body = `${how[0].toUpperCase()}${how.slice(1)} at ${at}. Open HomeHub and tap “I’m on it”.`;
  senders.push(title, body);
  let emails = 0, texts = 0, calls = 0;
  if (n === 1) {
    const link = remote() ? `\n\nOpen HomeHub: ${remote()}/family` : '';
    const words = a.heard ? `\nWhat they said: “${a.heard}”` : '';
    [emails, texts] = await Promise.all([
      senders.email(title, `${a.who} asked for help ${how} at ${at}.${words}\n\nIf you’re going to help, open HomeHub and tap “I’m on it”, so the others know and ${a.who} hears that someone is coming.${link}\n\nHomeHub doesn’t call 911. If you can’t reach ${a.who}, call them or emergency services.`),
      senders.texts(`HomeHub SOS: ${a.who} asked for help ${how} at ${at}. Open HomeHub and tap “I’m on it”.${remote() ? ` ${remote()}/family` : ''}`),
    ]);
  }
  const numbers = senders.callNumbers();
  if (numbers.length) {
    const to = numbers[(n - 1) % numbers.length];
    if (await senders.call(to, `This is HomeHub. ${a.who} asked for help ${how} at ${at}. Open HomeHub and tap I’m on it, or call ${a.who}.`)) calls = 1;
  }
  if (n === 1) {
    const told: Told = { phones: phones(), emails, texts, calls };
    getDb().prepare('UPDATE sos_alerts SET told = ? WHERE id = ?').run(JSON.stringify(told), a.id);
  }
  logger.warn({ id: a.id, round: n, via: a.via, place: a.place }, 'SOS: the family was told');
}

/**
 * A call for help. Starts telling the family straight away; `done` settles when the first round
 * has gone out. A second call while one is going
 * isn't a new one: the family is told it was asked again, and whoever is on it is reminded.
 */
export function raise(input: { via: Via; place?: string | null; lang?: VoiceLanguage | null; heard?: string | null }, now = Date.now()): { state: SosState; alert: SosAlert; done: Promise<void> } {
  const open = openAlert(now);
  if (open) {
    const how = howText({ via: input.via, place: input.place ?? null });
    senders.push(`SOS: ${open.who} asked for help again`, `${how[0].toUpperCase()}${how.slice(1)} at ${clock(new Date(now).toISOString())}.${open.ackedBy ? ` ${open.ackedBy} is on it.` : ' Open HomeHub and tap “I’m on it”.'}`);
    return { state: 'already', alert: open, done: Promise.resolve() };
  }
  const place = input.place?.trim().slice(0, 60) || null;
  const heard = input.heard?.trim().slice(0, 120) || null;
  const id = Number(getDb().prepare('INSERT INTO sos_alerts (started_at, via, place, who, lang, heard) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date(now).toISOString(), input.via, place, whoFor(input.via, place), input.lang ?? null, heard).lastInsertRowid);
  const alert = getAlert(id)!;
  // The family is told in the background: the speaker answers straight away, and email, texts
  // and calls can take seconds each.
  const done = round(alert, now).catch((err) => logger.error({ err, id }, 'SOS round failed'));
  return { state: 'raised', alert, done };
}

/** The person: from the app with no name set anywhere, whoever is signed in is the one asking. */
function whoFor(via: Via, place: string | null): string {
  const who = personName();
  return who === 'Someone' && via === 'app' && place ? place : who;
}

/** Someone in the family is on it: the others are told, and so is the person, out loud. */
export function acknowledge(id: number, by: string, now = Date.now()): SosAlert {
  const a = getAlert(id);
  if (!a) throw new SosError('That call for help isn’t there any more');
  if (a.cancelledAt) throw new SosError(`${a.who} already said they’re OK`);
  if (a.ackedAt) return a;
  getDb().prepare('UPDATE sos_alerts SET acked_at = ?, acked_by = ? WHERE id = ?').run(new Date(now).toISOString(), by, id);
  senders.push(`${by} is on it`, `${by} is helping ${a.who}. HomeHub has stopped calling the others.`);
  const lang = a.lang ?? personLanguage();
  senders.announce(ON_IT[lang](by), lang);
  logger.warn({ id, by }, 'SOS: someone is on it');
  return getAlert(id)!;
}

/** They're OK after all. Everyone told is told it's cancelled, the same ways. */
export async function cancel(id: number, by: string, now = Date.now()): Promise<SosAlert> {
  const a = getAlert(id);
  if (!a) throw new SosError('That call for help isn’t there any more');
  if (a.cancelledAt) return a;
  getDb().prepare('UPDATE sos_alerts SET cancelled_at = ?, cancelled_by = ? WHERE id = ?').run(new Date(now).toISOString(), by, id);
  const title = `Cancelled: ${a.who} is OK`;
  const body = `${a.who}’s call for help at ${clock(a.startedAt)} was cancelled ${by === a.who ? `by ${a.who}` : `by ${by}`}.`;
  senders.push(title, body);
  if (a.told?.emails) await senders.email(title, body);
  if (a.told?.texts) await senders.texts(`HomeHub: ${body}`);
  logger.warn({ id, by }, 'SOS cancelled');
  return getAlert(id)!;
}

/** The language the person speaks: the first voice language that isn't English, else English. */
export function personLanguage(): VoiceLanguage {
  const langs = getVoiceSettings().languages;
  return langs.find((l) => l !== 'en') ?? 'en';
}

const ON_IT: Record<VoiceLanguage, (by: string) => string> = {
  yue: (by) => `${by}已經知道，就嚟幫你。`,
  zh: (by) => `${by}已经知道了，马上来帮你。`,
  vi: (by) => `${by} đã biết rồi, đang đến giúp.`,
  en: (by) => `${by} knows, and help is on the way.`,
};

/** Rounds every few minutes until someone is on it, then gives up after the last one. */
export async function tick(now = Date.now()): Promise<void> {
  const a = openAlert(now);
  if (!a || a.ackedAt) return;
  const since = a.lastRoundAt ? now - Date.parse(a.lastRoundAt) : Infinity;
  if (since < ROUND_EVERY_MS) return;
  if (a.rounds >= ROUNDS) {
    getDb().prepare('UPDATE sos_alerts SET ended_at = ? WHERE id = ?').run(new Date(now).toISOString(), a.id);
    senders.push(`Nobody said they’re on ${a.who}’s call for help`, `HomeHub has stopped asking. If you haven’t, call ${a.who}.`);
    return;
  }
  await round(a, now);
}

/** A test of every way the family is told, labelled a test, once, with no repeats. */
export async function testSos(by: string): Promise<Told> {
  const who = personName();
  const title = `Test: SOS from HomeHub`;
  const body = `${by} sent a test. If ${who} asks for help, it looks like this. Nothing is wrong.`;
  senders.push(title, body);
  const [emails, texts] = await Promise.all([senders.email(title, body), senders.texts(`HomeHub test: ${body}`)]);
  const numbers = senders.callNumbers();
  const calls = numbers.length && await senders.call(numbers[0], `This is a test from HomeHub, sent by ${by}. If ${who} asks for help, you'll get a call like this. Nothing is wrong.`) ? 1 : 0;
  return { phones: phones(), emails, texts, calls };
}

// ── Buttons ─────────────────────────────────────────────────────

export interface SosButton { id: number; name: string; token: string; lastUsedAt: string | null }

export function listButtons(): SosButton[] {
  return (getDb().prepare('SELECT id, name, token, last_used_at FROM sos_buttons ORDER BY name').all() as
    { id: number; name: string; token: string; last_used_at: string | null }[]).map((b) => ({ id: b.id, name: b.name, token: b.token, lastUsedAt: b.last_used_at }));
}

export function addButton(name: unknown): SosButton {
  if (typeof name !== 'string' || !name.trim()) throw new SosError('Give the button a name, such as Bedside');
  if (name.trim().length > 40) throw new SosError('The name is too long');
  const token = randomBytes(16).toString('hex');
  const id = Number(getDb().prepare('INSERT INTO sos_buttons (name, token) VALUES (?, ?)').run(name.trim(), token).lastInsertRowid);
  return listButtons().find((b) => b.id === id)!;
}

export function deleteButton(id: number): boolean {
  return getDb().prepare('DELETE FROM sos_buttons WHERE id = ?').run(id).changes > 0;
}

/** A button was pressed (help) or double-pressed (cancel). False for a token that isn't a button. */
export async function buttonPressed(token: string, what: 'help' | 'cancel', now = Date.now()): Promise<boolean> {
  const b = getDb().prepare('SELECT id, name FROM sos_buttons WHERE token = ?').get(token) as { id: number; name: string } | undefined;
  if (!b) return false;
  getDb().prepare('UPDATE sos_buttons SET last_used_at = ? WHERE id = ?').run(new Date(now).toISOString(), b.id);
  if (what === 'help') {
    await raise({ via: 'button', place: b.name }, now).done;
  } else {
    const open = openAlert(now);
    if (open) await cancel(open.id, personName(), now);
  }
  return true;
}

// ── Running ─────────────────────────────────────────────────────

let timer: NodeJS.Timeout | undefined;

export function startSos(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (!isActiveServer()) return;
    tick().catch((err) => logger.error({ err }, 'SOS round failed'));
  }, TICK_MS);
  timer.unref();
}

export function stopSos(): void { if (timer) clearInterval(timer); timer = undefined; }
