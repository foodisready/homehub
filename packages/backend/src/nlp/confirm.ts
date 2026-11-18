/**
 * "Did you mean…?": what HomeHub does with a model's reading of a command it didn't know.
 *
 * The rules act on names the home already has. Anything else goes to a model, and a model can be
 * wrong (the command test set: even qwen2.5:7b switched the wrong device, or the right one the wrong
 * way, in about one answer in five). So a model never switches anything itself. It proposes, and the
 * person confirms:
 *
 *   "tắt hết đèn phòng khách"  →  "Tắt Living room statue, Living room lamps và Woman statue?"
 *   "có"                        →  switched, and "hết đèn phòng khách" saved as their nickname,
 *
 * so the next time the same words are said, the rules act on them at once, with no model and no
 * question. A household teaches HomeHub its own words by using it, rather than anyone writing rules.
 *
 * Whether on or off, open or close, comes from the rules' own reading of the verb when they have one
 * (they're exact about "tắt", "熄" and "turn of"), and from the model only when they don't. A garage
 * door is only ever closed, and cameras are never paused this way, as everywhere else in Chat.
 */
import { getDb } from '../db';
import type { PowerDevice } from '../devices/power';
import { doorReply, isCamera, isGarageDoor, parseDoorCommand, parsePowerCommand, runGroupCommand } from './commands';
import { normalize } from './find-device';
import { fold, inLanguage, parseNativeCommand } from './native-commands';
import { resolve as resolveMiss, saveDeviceNickname, suggestPhrase, TeachError } from './teach';
import type { ActionTaken } from './nlp.service';
import type { Understanding } from './understand';

export type Lang = 'en' | 'yue' | 'zh' | 'vi';

export interface Proposal {
  deviceIds: number[];
  aliases:   string[];
  /** The same devices, named as people say them in `lang` (their nicknames), for saying back. */
  names?:    string[];
  /** On, or for a garage door, false: close. */
  state:     boolean;
  minutes:   number | null;
  door:      boolean;
  lang:      Lang;
  /** The words to save as the devices' nickname once confirmed: what the rules will look up next time. */
  phrase:    string | null;
  /** The command as given: once confirmed, it's no longer a miss to teach. */
  text:      string;
}

export type Reading =
  | { kind: 'ask'; proposal: Proposal }
  /** Something HomeHub won't do from Chat or voice, whatever was meant. */
  | { kind: 'refuse'; why: 'door-open' | 'camera-pause'; lang: Lang };

// ── What the rules can read, even of a name they don't know ─────

interface RuleReading { name: string; state: boolean; lang: Lang }

/** The verb and the name as the rules read them: "turn of uffice lighs" → off, "uffice lighs". */
export function readCommand(text: string): RuleReading | null {
  const native = parseNativeCommand(text);
  if (native) return { name: native.name, state: native.state, lang: native.lang };
  const english = parseDoorCommand(text) ?? parsePowerCommand(text);
  return english ? { name: english.name, state: english.state, lang: 'en' } : null;
}

// Words that name every light, or none in particular: never one device's nickname.
const GENERIC = new Set([
  'light', 'lights', 'lamp', 'lamps', 'all', 'everything', 'it', 'them', 'all lights', 'all the lights', 'the lights',
  'den', 'het den', 'tat ca', 'tat ca den', 'tat ca cac den', 'cac den', 'nhung den', 'het',
  '燈', '全部', '全部燈', '所有燈', '啲燈', '個燈', '燈仔',
].map((w) => fold(w)));

/** A phrase worth remembering: specific, and long enough not to turn up inside other commands. */
export function learnable(phrase: string | null | undefined): string | null {
  if (!phrase) return null;
  const trimmed = phrase.trim().replace(/\s+/g, ' ').replace(/^(?:the|my)\s+/i, '');
  const key = fold(trimmed);
  if (!key || trimmed.length > 60 || GENERIC.has(key)) return null;
  // More than a name: "office light. turn off office light".
  if (/[.!?;。！？；]/.test(trimmed) || /\b(?:turn|switch|and|then)\b/.test(key)) return null;
  const chinese = (key.match(/[㐀-鿿]/g) ?? []).length;
  const latin = (key.match(/[a-z0-9]/g) ?? []).length;
  return chinese >= 2 || latin >= 3 ? trimmed : null;
}

/** The phrase to save: the name the rules read, else the part of the message that names something. */
function phraseOf(text: string, rule: RuleReading | null): string | null {
  if (rule) return learnable(rule.name);
  const suggested = suggestPhrase(text);
  return suggested.kind === 'device' ? learnable(suggested.phrase) : null;
}

// ── A model's reading, made into a question ─────────────────────

type Row = PowerDevice & { id: number; alias: string; driver_type?: string | null; nicknames?: string | null };

const HAN = /\p{Script=Han}/u;

/**
 * A device's name in the language it's being asked about: "Bật đèn của nhà vua?", not "Bật King's
 * lamp?". Of its nicknames in that language, the one most like what was said; its own name when it
 * has none. Vietnamese names are told by their accented letters, Chinese ones by their characters.
 */
export function nameIn(row: { alias: string; nicknames?: string | null }, lang: Lang, said: string): string {
  if (lang === 'en') return row.alias;
  let list: unknown = [];
  try { list = JSON.parse(row.nicknames ?? '[]'); } catch { /* none */ }
  if (!Array.isArray(list)) return row.alias;
  const fits = list.filter((n): n is string => typeof n === 'string' && !!n.trim()
    && (lang === 'vi' ? !HAN.test(n) && /[^\x00-\x7f]/.test(n) : HAN.test(n)));
  if (!fits.length) return row.alias;
  const heard = fold(said);
  const words = new Set(heard.split(' '));
  const score = (n: string) => {
    const f = fold(n);
    return lang === 'vi'
      ? f.split(' ').filter((w) => w && words.has(w)).length
      : [...new Set(f)].filter((ch) => HAN.test(ch) && heard.includes(ch)).length;
  };
  return fits.reduce((best, n) => (score(n) > score(best) ? n : best), fits[0]);
}

/**
 * What to ask, given what the model read. Null when the model didn't name any device to switch
 * (a question, a scene, or unclear): the caller answers that as it does today.
 */
export function propose(text: string, u: Understanding | null): Reading | null {
  if (!u || !['on', 'off', 'open', 'close'].includes(u.action) || !u.devices.length) return null;
  const rule = readCommand(text);
  const lang: Lang = rule?.lang ?? u.lang;
  const state = rule ? rule.state : u.action === 'on' || u.action === 'open';

  const rows = getDb().prepare(`SELECT * FROM devices WHERE alias IN (${u.devices.map(() => '?').join(',')})`)
    .all(...u.devices) as Row[];
  if (!rows.length) return null;
  const doors = rows.filter(isGarageDoor);
  // A garage door together with lights isn't one thing to ask about.
  if (doors.length && doors.length !== rows.length) return null;
  if (doors.length && state) return { kind: 'refuse', why: 'door-open', lang };
  if (!state && rows.some(isCamera)) return { kind: 'refuse', why: 'camera-pause', lang };

  return {
    kind: 'ask',
    proposal: {
      deviceIds: rows.map((r) => r.id).sort((a, b) => a - b),
      aliases:   rows.map((r) => r.alias),
      names:     rows.map((r) => nameIn(r, lang, text)),
      state,
      minutes:   state && !doors.length ? u.minutes : null,
      door:      doors.length > 0,
      lang,
      phrase:    phraseOf(text, rule),
      text,
    },
  };
}

// ── Saying it ───────────────────────────────────────────────────

function listNames(names: string[], lang: Lang): string {
  if (names.length < 2) return names.join('');
  const and = { en: ' and ', vi: ' và ', yue: '同', zh: '和' }[lang];
  const sep = lang === 'en' || lang === 'vi' ? ', ' : '、';
  return names.slice(0, -1).join(sep) + and + names[names.length - 1];
}

/** "Should I turn off My office lamp?", in the language the command was given in. */
export function askText(p: Proposal): string {
  const names = listNames(p.names ?? p.aliases, p.lang);
  const verb = p.door ? 'close' : p.state ? 'on' : 'off';
  const minutes = p.minutes;
  switch (p.lang) {
    // Said aloud, "Bật đèn bếp?" and "Turn on Porch light?" sound like HomeHub doing it, not
    // asking: the voice doesn't rise at the end. So they ask in words, as 係咪 and 吗 already do.
    case 'vi': {
      const v = { close: 'đóng', on: 'bật', off: 'tắt' }[verb];
      return `Có phải bạn muốn ${v} ${names}${minutes ? ` trong ${minutes} phút` : ''} không?`;
    }
    case 'yue': {
      const v = { close: '閂', on: '開', off: '熄' }[verb];
      return `係咪要${v}${names}${minutes ? `${minutes}分鐘` : ''}？`;
    }
    case 'zh': {
      const v = { close: '关上', on: '打开', off: '关掉' }[verb];
      return `要${v}${names}${minutes ? `${minutes}分钟` : ''}吗？`;
    }
    default: {
      const v = { close: 'close', on: 'turn on', off: 'turn off' }[verb];
      return `Should I ${v} ${names}${minutes ? ` for ${minutes} minutes` : ''}?`;
    }
  }
}

const REFUSED: Record<'door-open' | 'camera-pause', Record<Lang, string>> = {
  'door-open': {
    en:  "For safety, I won't open a garage door from here. Use its tile on the dashboard. I can close it.",
    vi:  'Vì an toàn, tôi không mở cửa ga-ra từ đây. Hãy dùng nút của nó trên trang chủ. Tôi có thể đóng cửa.',
    yue: '為咗安全，我唔會喺度開車房門。請用主頁上面個掣。我可以幫你閂。',
    zh:  '为了安全，我不会在这里打开车库门。请用主页上的按钮。我可以帮你关上。',
  },
  'camera-pause': {
    en:  "For safety, I can't pause cameras that way.",
    vi:  'Vì an toàn, tôi không thể tạm dừng camera theo cách này.',
    yue: '為咗安全，我唔可以咁樣暫停鏡頭。',
    zh:  '为了安全，我不能这样暂停摄像头。',
  },
};

export const refusedText = (r: Extract<Reading, { kind: 'refuse' }>) => REFUSED[r.why][r.lang];

const NOTHING_DONE: Record<Lang, string> = {
  en:  'OK, I left everything as it was.',
  vi:  'Được, tôi không thay đổi gì.',
  yue: '好，我乜都冇改。',
  zh:  '好的，我什么都没改。',
};

const REMEMBERED: Record<Lang, (phrase: string) => string> = {
  en:  (p) => `Next time I'll know "${p}".`,
  vi:  (p) => `Lần sau tôi sẽ hiểu "${p}".`,
  yue: (p) => `下次我會記得「${p}」。`,
  zh:  (p) => `下次我会记得“${p}”。`,
};

// ── The answer ──────────────────────────────────────────────────

const YES = new Set(['yes', 'y', 'yeah', 'yep', 'yup', 'ok', 'okay', 'sure', 'do it', 'yes please', 'please', 'correct', 'right', 'thats right',
  'co', 'u', 'uh', 'vang', 'da', 'dung', 'dung roi', 'phai', 'duoc', 'co a', 'vang a', 'da vang', 'dong y',
  '係', '系', '係呀', '系呀', '係啊', '好', '好呀', '好啊', '啱', '啱呀', '冇錯', '得', '得呀', '是', '是的', '对', '對', '对的', '嗯', '可以', '好的', '没错', '沒錯']
  .map((w) => fold(w)));
const NO = new Set(['no', 'n', 'nope', 'cancel', 'dont', 'stop', 'wrong', 'never mind', 'no thanks', 'not that',
  'khong', 'sai', 'dung lam', 'thoi', 'khong phai', 'khong a', 'huy',
  '唔係', '唔系', '唔好', '唔使', '唔要', '唔啱', '錯', '错', '不', '不是', '不要', '不用', '别', '別', '取消']
  .map((w) => fold(w)));

/** Yes, no, or neither (then the message is a new command), for a reply to "Did you mean…?". */
export function answerKind(text: string): 'yes' | 'no' | null {
  const key = fold(text)
    .replace(/[.!?,;:。！？，、~～'’]/g, ' ')
    .replace(/(?:啦|喇|呀|啊|吖|囉|咧|吧|了|嘅)+$/, '')
    .replace(/\s+(?:nhe|nha|a|di)$/, '')
    .trim().replace(/\s+/g, ' ');
  return YES.has(key) ? 'yes' : NO.has(key) ? 'no' : null;
}

export interface Confirmed { response: string; actions: ActionTaken[]; learned: string | null }

/**
 * The person said yes: switch, then save the words as the devices' nickname, if they're worth
 * keeping and HomeHub would then read them as exactly these devices.
 */
export async function confirm(p: Proposal): Promise<Confirmed> {
  const rows = getDb().prepare(`SELECT * FROM devices WHERE id IN (${p.deviceIds.map(() => '?').join(',')})`)
    .all(...p.deviceIds) as Row[];
  const name = p.aliases.join(', ');
  const switched = await runGroupCommand(rows, { name, state: p.state, ...(p.minutes ? { minutes: p.minutes } : {}) });
  // "Closing Garage Left.": a door takes a while, so not "turned off".
  const done = p.door ? doorReply(switched, false) : switched;
  const ok = done.actions.some((a) => (a.result as { success?: boolean } | undefined)?.success);

  let learned: string | null = null;
  if (ok && p.phrase && rows.length === p.deviceIds.length) {
    try {
      if (saveDeviceNickname(p.phrase, p.deviceIds).added) learned = p.phrase;
    } catch (err) {
      if (!(err instanceof TeachError)) throw err;
    }
  }

  // Dealt with: Settings → Teach HomeHub no longer lists it.
  if (ok) resolveMiss(p.text);

  const said = p.lang === 'en'
    ? done
    : inLanguage(done, { lang: p.lang, state: p.state, name: listNames(p.names ?? p.aliases, p.lang), verb: p.door ? 'đóng' : undefined });
  const response = learned ? `${said.response} ${REMEMBERED[p.lang](learned)}` : said.response;
  return { response, actions: done.actions, learned };
}

export const declined = (p: Proposal) => NOTHING_DONE[p.lang];

/** Whether two proposals mean the same thing: for tests and the command test set. */
export const sameProposal = (p: Proposal, aliases: string[], state: boolean) =>
  p.state === state && [...p.aliases].map(normalize).sort().join('|') === [...aliases].map(normalize).sort().join('|');

// ── The question waiting for an answer, per person ─────────────

/** How long a question waits: a yes much later is more likely meant for something else. */
export const PENDING_MS = 2 * 60_000;
const waiting = new Map<string, { proposal: Proposal; until: number }>();

export function setPending(who: string, proposal: Proposal, now = Date.now()): void {
  waiting.set(who, { proposal, until: now + PENDING_MS });
}

/** The question `who` was last asked, if it's still waiting. Taken: a second answer finds nothing. */
export function takePending(who: string, now = Date.now()): Proposal | null {
  const w = waiting.get(who);
  waiting.delete(who);
  return w && w.until > now ? w.proposal : null;
}
