/**
 * On and off typed in Chat in Vietnamese, Cantonese or Mandarin, answered in the same language:
 *
 *   "bật đèn bếp"  →  "Đã bật đèn bếp."
 *   "熄廚房燈啦"   →  "熄咗廚房燈。"
 *   "把厨房灯打开" →  "已打开厨房灯。"
 *
 * By voice the bridge reads these itself and sends HomeHub an English command. Typed, they used to
 * reach the chat model, which on a Pi is small: it translated the name ("厨房灯"), found nothing by
 * it, and answered in Chinese. Typing is exact, so unlike speech nothing here guesses at sounds: a
 * verb, then a name the home knows (or the name, then the verb, as Mandarin also says it). Accents
 * left off ("bat den bep") and simplified characters (厨房灯 for 廚房燈) still find the name.
 * The switching itself is the English rules' (runPowerCommand), so protected devices, garage
 * doors (closed, never opened) and cameras behave exactly as when typed in English.
 */
import { CAMERA_PAUSE_REFUSED, DOOR_OPEN_REFUSED, isGarageDoor, parseDuration, runPowerCommand, type ThermostatAsk } from './commands';
import { findDeviceByName, findDeviceGroup, listDeviceNames, listSceneNames, normalize } from './find-device';
import type { ActionTaken } from './nlp.service';

export type NativeLang = 'vi' | 'yue' | 'zh';

export interface NativeCommand {
  lang:  NativeLang;
  state: boolean;
  /** The name as typed. */
  name:  string;
  /** Vietnamese only: the verb as typed, with its accents ("mở" for a door, "bật" for a light). */
  verb?: string;
  /** "bật quạt 30 phút", 開風扇半個鐘: on for this long, then off. */
  minutes?: number;
}

type Handled = { response: string; actions: ActionTaken[] };

// ── Folding: what's compared when looking a name up ─────────────

/** Simplified characters that appear in home names, as the traditional ones nicknames are written in. */
const S2T: Record<string, string> = Object.fromEntries(
  [...'开開关關灯燈厅廳门門厨廚书書边邊头頭楼樓区區细細写寫办辦闭閉灭滅闩閂个個后後车車库庫阳陽卧臥风風电電视視机機热熱气氣饭飯园園帘簾间間儿兒'.matchAll(/(.)(.)/g)]
    .map(([, s, t]) => [s, t]),
);

/** Lower case, no accents (đ as d), traditional characters: "Đèn Bếp" and "den bep", 厨房灯 and 廚房燈, fold the same. */
export const fold = (text: string) =>
  normalize(text)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^\x00-\x7f]/g, (c) => S2T[c] ?? c)
    .replace(/\s+/g, ' ');

/**
 * The home's own spelling of a typed name, when only accents or simplified characters differ and
 * exactly one name fits. Otherwise the name as typed, for the rules to match or ask about.
 */
export function homeName(typed: string, names: string[] = [...listDeviceNames(), ...listSceneNames()]): string {
  const wanted = fold(typed);
  const fits = new Map<string, string>();
  for (const n of names) if (fold(n) === wanted && !fits.has(normalize(n))) fits.set(normalize(n), n);
  return fits.size === 1 ? [...fits.values()][0] : typed;
}

// ── Vietnamese ─────────────────────────────────────────────────

const VI_VERBS: Record<string, boolean> = { 'bật': true, 'mở': true, 'tắt': false, 'đóng': false };
// Typed without accents. "bat" and "tat" can't be anything else at the start of a home command.
const VI_PLAIN_VERBS: Record<string, string> = { bat: 'bật', mo: 'mở', tat: 'tắt', dong: 'đóng' };
// Before the verb ("làm ơn bật …"), between it and the name ("bật giúp đèn"), and after the name
// ("bật đèn bếp đi nhé"). Compared without accents. "hết" (all) stays, so "tắt hết đèn" names no
// device and goes to the chat model rather than being asked about as one light.
const VI_BEFORE = ['lam on', 'hay', 'xin', 'giup toi', 'giup minh', 'ban oi', 'homehub oi'];
const VI_BETWEEN = ['giup toi', 'giup minh', 'cho toi', 'cho minh', 'giup', 'gium', 'dum', 'cai'];
const VI_AFTER = ['di', 'nhe', 'nha', 'gium', 'dum', 'giup', 'voi', 'a', 'len', 'luon', 'giup toi', 'gium toi', 'cho toi', 'cho minh', 'di nhe', 'di nha'];

const plainWords = (words: string[]) => words.map((w) => fold(w));

/** Takes the longest phrase from `phrases` off the front (or back) of `words`, as often as one fits. */
function strip(words: string[], phrases: string[], from: 'start' | 'end'): string[] {
  const lists = phrases.map((p) => p.split(' ')).sort((a, b) => b.length - a.length);
  let out = words;
  for (let again = true; again && out.length;) {
    again = false;
    const plain = plainWords(out);
    for (const p of lists) {
      if (p.length >= out.length) continue;   // never the whole name
      const part = from === 'start' ? plain.slice(0, p.length) : plain.slice(-p.length);
      if (part.join(' ') === p.join(' ')) {
        out = from === 'start' ? out.slice(p.length) : out.slice(0, -p.length);
        again = true;
        break;
      }
    }
  }
  return out;
}

// ── Durations ──────────────────────────────────────────────────

const VI_DIGIT: Record<string, number> = { 'một': 1, 'mốt': 1, 'hai': 2, 'ba': 3, 'bốn': 4, 'tư': 4, 'năm': 5, 'lăm': 5, 'sáu': 6, 'bảy': 7, 'tám': 8, 'chín': 9 };

/** "10", "mười", "mười lăm", "hai mươi", "hai mươi lăm" → the number. Words keep their accents: "ba" is three, "bà" grandma. */
export function viNumber(words: string[]): number | null {
  if (words.length === 1 && /^\d+$/.test(words[0])) return +words[0];
  const [a, b, c] = words;
  if (a === 'mười') return words.length === 1 ? 10 : words.length === 2 && b in VI_DIGIT ? 10 + VI_DIGIT[b] : null;
  if (b === 'mươi' && a in VI_DIGIT) return words.length === 2 ? VI_DIGIT[a] * 10 : words.length === 3 && c in VI_DIGIT ? VI_DIGIT[a] * 10 + VI_DIGIT[c] : null;
  return words.length === 1 && a in VI_DIGIT && a !== 'lăm' && a !== 'mốt' ? VI_DIGIT[a] : null;
}

/**
 * A duration at the end: "… 30 phút", "… trong hai mươi phút", "… một tiếng", "… nửa tiếng". `later` when
 * it's when to do it rather than for how long ("10 phút nữa", "sau 10 phút"): that's the chat model's.
 */
function viDuration(words: string[]): { rest: string[]; minutes: number } | { later: true } | null {
  const w = words.map((x) => x.normalize('NFC'));
  let end = w.length;
  const after = w[end - 1] === 'nữa';
  if (after) end--;
  const unit = w[end - 1];
  const per = unit === 'phút' ? 1 : unit === 'tiếng' ? 60 : 0;
  if (!per) return null;
  let start = end - 1, minutes: number | null = null;
  if (per === 60 && w[start - 1] === 'nửa') { start--; minutes = 30; }
  else {
    for (let n = 3; n >= 1 && minutes === null; n--) {
      if (start - n < 1) continue;
      const m = viNumber(w.slice(start - n, start));
      if (m !== null) { minutes = m * per; start -= n; }
    }
  }
  if (minutes === null) return null;
  if (after || w[start - 1] === 'sau') return { later: true };
  if (w[start - 1] === 'trong') start--;
  return { rest: words.slice(0, start), minutes };
}

export function parseVietnamese(text: string): NativeCommand | null {
  let words = text.toLowerCase().replace(/[.!?,;:。！？，]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  words = strip(words, VI_BEFORE, 'start');
  if (words.length < 2) return null;
  const first = words[0].normalize('NFC');
  const verb = first in VI_VERBS ? first : VI_PLAIN_VERBS[first];
  if (!verb) return null;
  let rest = strip(words.slice(1), VI_BETWEEN, 'start');
  rest = strip(rest, VI_AFTER, 'end');
  let minutes: number | undefined;
  const d = viDuration(rest);
  if (d && 'later' in d) return null;
  if (d) { rest = strip(d.rest, VI_AFTER, 'end'); minutes = d.minutes; }
  if (!rest.length) return null;
  const state = VI_VERBS[verb];
  if (minutes && !state) return null;   // a timer only turns something off, as in English
  return { lang: 'vi', state, name: rest.join(' '), verb: first in VI_VERBS ? first : undefined, ...(minutes ? { minutes } : {}) };
}

// ── Cantonese and Mandarin ─────────────────────────────────────

// Longest first, so 打開 isn't read as 打 + 開… 着 (zoek) is Cantonese for switching a light on,
// as the voice bridge already reads it.
const ZH_ON = ['打開', '打开', '開返', '开返', '開着', '開', '开', '着返', '著返', '着', '著'];
const ZH_OFF = ['關閉', '关闭', '關掉', '关掉', '關埋', '关埋', '熄滅', '熄灭', '熄埋', '熄', '關', '关', '閂埋', '闩埋', '閂', '闩'];
// Mandarin's verb last: 把客厅灯打开, 厨房灯关了.
const ZH_ON_LAST = ['打開', '打开', '開', '开'];
const ZH_OFF_LAST = ['關掉', '关掉', '關閉', '关闭', '關上', '关上', '熄滅', '熄灭', '關', '关', '熄'];
const ZH_BEFORE = /^(?:(?:唔該|唔该|請|请|麻煩|麻烦|幫我|帮我|幫手|帮手|你|可唔可以|可不可以|可以|能不能|同我|給我|给我)\s*)+/;
const ZH_AFTER = /(?:\s*(?:啦|喇|吧|呀|啊|吖|了|一下|下|先|喎|嘞|唔該|唔该|謝謝|谢谢|得唔得|好嗎|好吗|好唔好|嗎|吗))+$/;
const ZH_BA = /^(?:把|將|将)/;
// Characters only written in simplified Chinese, or in Mandarin: then the reply is Mandarin.
export const MANDARIN = /[开关灯厅门帮请这吧么们厨书边头楼区细写办闭灭闩个后车库卧风电视机热气饭园帘间儿把]/;

export const hasChinese = (text: string) => /[㐀-鿿]/.test(text);

const CN_DIGIT: Record<string, number> = { 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 十 → 10, 十五 → 15, 二十 → 20, 三十五 → 35, 2 → 2. */
export function cnNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return +s;
  if (s.includes('十')) {
    const [tens, ones] = s.split('十');
    if (tens.length > 1 || ones.length > 1 || (tens && !(tens in CN_DIGIT)) || (ones && !(ones in CN_DIGIT))) return null;
    return (tens ? CN_DIGIT[tens] : 1) * 10 + (ones ? CN_DIGIT[ones] : 0);
  }
  return s.length === 1 && s in CN_DIGIT ? CN_DIGIT[s] : null;
}

const ZH_HOUR = '(?:個鐘頭?|个钟头?|鐘頭?|钟头?|小時|小时)';
// 十分鐘, 30分钟, 一個鐘, 個半鐘, 半個鐘, 一個半鐘, 两小时; then perhaps 之後 / 后, which makes it "later".
const ZH_DURATION = new RegExp(
  `(?:([0-9]+|[一二兩两三四五六七八九十]+)(分鐘|分钟)|([0-9]+|[一二兩两三四五六七八九十]+)?(個半|个半)?${ZH_HOUR}(半)?|半${ZH_HOUR})(之後|之后|以後|以后|後|后)?$`);

/** A duration at the end of a Cantonese or Mandarin command, in minutes; `later` for 十分鐘後. */
function zhDuration(t: string): { rest: string; minutes: number } | { later: true } | null {
  const m = t.match(ZH_DURATION);
  if (!m || m.index === 0) return null;
  let minutes: number | null;
  if (m[2]) minutes = cnNumber(m[1]);
  else if (m[0].startsWith('半')) minutes = 30;
  else {
    const hours = m[3] ? cnNumber(m[3]) : m[4] ? 1 : null;
    minutes = hours === null ? null : hours * 60 + (m[4] || m[5] ? 30 : 0);
  }
  if (!minutes) return null;
  if (m[6]) return { later: true };
  return { rest: t.slice(0, m.index), minutes };
}

/**
 * How long, said at the end of a short answer, in any of the home's languages: "yes, for two hours",
 * 係啦五十分鐘, "có, ba mươi phút". Null with no length of time, or with one that says when rather than
 * for how long (十分鐘後, "10 phút nữa").
 */
export function durationAtEnd(text: string): number | null {
  if (hasChinese(text)) {
    const t = text.replace(/[\s.!?,;:。！？，、～~]+/g, '').replace(/(?:啦|喇|呀|啊|吖|囉|咧|吧|了|嘅)+$/, '');
    // zhDuration wants something before the time: the answer word, or a stand-in for none.
    const d = zhDuration(`答${t}`);
    return d && !('later' in d) ? d.minutes : null;
  }
  const words = text.toLowerCase().normalize('NFC').split(/[\s,.!?;:]+/).filter(Boolean);
  if (/[\u00C0-\u1EF9]/.test(text) || /(?:^|\s)(?:phút|tiếng)(?:\s|$)/.test(words.join(' '))) {
    const d = viDuration(['', ...words.filter((w) => !['ạ', 'nhé', 'nha', 'đi'].includes(w))]);
    return d && !('later' in d) ? d.minutes : null;
  }
  for (let i = 0; i < words.length; i++) {
    const minutes = parseDuration(words.slice(i).join(' ').replace(/^for\s+/, ''));
    if (minutes) return minutes;
  }
  return null;
}

const takeFirst = (text: string, verbs: string[]) => verbs.find((v) => text.startsWith(v));
const takeLast = (text: string, verbs: string[]) => verbs.find((v) => text.endsWith(v));

export function parseChinese(text: string): NativeCommand | null {
  if (!hasChinese(text)) return null;
  const lang: NativeLang = MANDARIN.test(text) ? 'zh' : 'yue';
  let t = text.replace(/[\s.!?,;:。！？，、～~]+/g, '').replace(ZH_BEFORE, '').replace(ZH_AFTER, '');
  if (!t) return null;
  let minutes: number | undefined;
  const d = zhDuration(t);
  if (d && 'later' in d) return null;
  if (d) { t = d.rest.replace(ZH_AFTER, ''); minutes = d.minutes; }
  const timed = (c: NativeCommand | null): NativeCommand | null =>
    !c || !minutes ? c : c.state ? { ...c, minutes } : null;   // a timer only turns something off

  const on = takeFirst(t, ZH_ON), off = takeFirst(t, ZH_OFF);
  const first = [on, off].filter(Boolean).sort((a, b) => b!.length - a!.length)[0];
  if (first) {
    // 開下廚房燈, 熄咗個燈: the 下 or 咗 after the verb isn't part of the name.
    const name = t.slice(first.length).replace(/^(?:下|咗|埋|返|個|个|一下)/, '');
    return name ? timed({ lang, state: first === on, name }) : null;
  }

  t = t.replace(ZH_BA, '');
  const onLast = takeLast(t, ZH_ON_LAST), offLast = takeLast(t, ZH_OFF_LAST);
  const last = [onLast, offLast].filter(Boolean).sort((a, b) => b!.length - a!.length)[0];
  if (!last) return null;
  const name = t.slice(0, -last.length);
  return name ? timed({ lang, state: last === onLast, name }) : null;
}

export const parseNativeCommand = (text: string): NativeCommand | null =>
  parseChinese(text) ?? parseVietnamese(text);

// ── Replies, in the language typed ─────────────────────────────

const succeeded = (a: ActionTaken) => (a.result as { success?: boolean } | undefined)?.success === true;
const aliasOf = (a: ActionTaken) => String(a.args.alias);
const listOf = (names: string[], lang: NativeLang) => names.join(lang === 'vi' ? ', ' : '、');

const SAY = {
  vi: {
    done:       (c: NativeCommand, name: string) => `Đã ${c.verb ?? (c.state ? 'bật' : 'tắt')} ${name}.`,
    timer:      (c: NativeCommand, name: string, m: number) => `Đã ${c.verb ?? 'bật'} ${name} trong ${[Math.floor(m / 60) && `${Math.floor(m / 60)} tiếng`, m % 60 && `${m % 60} phút`].filter(Boolean).join(' ')}.`,
    closing:    (name: string) => `Đang đóng ${name}.`,
    unreached:  (names: string) => `Không kết nối được ${names}.`,
    which:      (names: string) => `Ý bạn là cái nào: ${names}?`,
    protected:  (name: string) => `${name} được bảo vệ, nên tôi không bật tắt nó từ đây. Hãy dùng nút của nó trên trang chủ.`,
    doorOpen:   'Vì an toàn, tôi không mở cửa ga-ra từ đây. Hãy dùng nút của nó trên trang chủ. Tôi có thể đóng cửa.',
    cameraStop: 'Vì an toàn, tôi không thể tạm dừng camera theo cách này.',
  },
  yue: {
    done:       (c: NativeCommand, name: string) => `${c.state ? '開' : '熄'}咗${name}。`,
    timer:      (_c: NativeCommand, name: string, m: number) => `開咗${name}，${m >= 60 ? `${Math.floor(m / 60)}個鐘${m % 60 ? `${m % 60}分鐘` : ''}` : `${m}分鐘`}之後熄。`,
    closing:    (name: string) => `閂緊${name}。`,
    unreached:  (names: string) => `連唔到${names}。`,
    which:      (names: string) => `你指邊個：${names}？`,
    protected:  (name: string) => `${name}受保護，我唔會喺度開關佢。請用主頁上面個掣。`,
    doorOpen:   '為咗安全，我唔會喺度開車房門。請用主頁上面個掣。我可以幫你閂。',
    cameraStop: '為咗安全，我唔可以咁樣暫停鏡頭。',
  },
  zh: {
    done:       (c: NativeCommand, name: string) => `已${c.state ? '打开' : '关掉'}${name}。`,
    timer:      (_c: NativeCommand, name: string, m: number) => `已打开${name}，${m >= 60 ? `${Math.floor(m / 60)}小时${m % 60 ? `${m % 60}分钟` : ''}` : `${m}分钟`}后关掉。`,
    closing:    (name: string) => `正在关${name}。`,
    unreached:  (names: string) => `连不上${names}。`,
    which:      (names: string) => `你是指哪一个：${names}？`,
    protected:  (name: string) => `${name}受保护，我不会在这里开关它。请用主页上的按钮。`,
    doorOpen:   '为了安全，我不会在这里打开车库门。请用主页上的按钮。我可以帮你关上。',
    cameraStop: '为了安全，我不能这样暂停摄像头。',
  },
};

/** The English rules' answer, said in the command's language. Anything without a translation stays as it was. */
export function inLanguage(result: Handled, command: NativeCommand): Handled {
  const say = SAY[command.lang];
  const { response, actions } = result;
  if (actions.length) {
    const ok = actions.filter(succeeded), failed = actions.filter((a) => !succeeded(a));
    if (!failed.length) {
      if (/^Closing /.test(response)) return { response: say.closing(command.name), actions };
      // A run of protected devices left alone is explained only in English.
      if (/protected/.test(response)) return result;
      return { response: command.minutes ? say.timer(command, command.name, command.minutes) : say.done(command, command.name), actions };
    }
    const parts = [
      ok.length ? say.done(command, listOf(ok.map(aliasOf), command.lang)) : '',
      say.unreached(listOf(failed.map(aliasOf), command.lang)),
    ];
    return { response: parts.filter(Boolean).join(command.lang === 'vi' ? ' ' : ''), actions };
  }
  if (response === DOOR_OPEN_REFUSED) return { response: say.doorOpen, actions };
  if (response === CAMERA_PAUSE_REFUSED) return { response: say.cameraStop, actions };
  const which = response.match(/^Which one do you mean: (.*)\?$/);
  if (which) return { response: say.which(which[1]), actions };
  const guarded = response.match(/^(.+) is protected, so Chat won’?'?t switch it/);
  if (guarded) return { response: say.protected(guarded[1]), actions };
  return result;
}

/** Whether a name means garage doors: by their own name or nickname, or a room's. */
function isGarageDoorName(name: string): boolean {
  if (findDeviceGroup(name).some((d) => isGarageDoor(d as { driver_type?: string | null }))) return true;
  const match = findDeviceByName(name);
  return 'device' in match && isGarageDoor(match.device as { driver_type?: string | null });
}

/**
 * Runs a Vietnamese, Cantonese or Mandarin on or off command, and answers in that language.
 * Null if it isn't one, or names nothing in the home: then the chat model has it, as before.
 */
export async function runNativeCommand(text: string): Promise<(Handled & { ask?: ThermostatAsk; lang?: NativeCommand['lang'] }) | null> {
  const command = parseNativeCommand(text);
  if (!command) return null;
  const name = homeName(command.name);
  // Vietnamese typed without accents is answered with them; Chinese keeps the characters typed.
  if (command.lang === 'vi') command.name = name;
  // "mở cửa ga-ra", "閂車房門": a garage door is closed (and never opened); anything else switched.
  const door = isGarageDoorName(name);
  const timer = command.minutes && !door ? ` for ${command.minutes} minutes` : '';
  const result = await runPowerCommand(door ? `${command.state ? 'open' : 'close'} ${name}` : `turn ${command.state ? 'on' : 'off'} ${name}${timer}`);
  if (result?.ask) return { ...result, lang: command.lang };   // the caller asks, in this language
  return result ? inLanguage(result, command) : null;
}
