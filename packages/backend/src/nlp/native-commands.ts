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
import { CAMERA_PAUSE_REFUSED, DOOR_OPEN_REFUSED, isGarageDoor, runPowerCommand } from './commands';
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

export function parseVietnamese(text: string): NativeCommand | null {
  let words = text.toLowerCase().replace(/[.!?,;:。！？，]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  words = strip(words, VI_BEFORE, 'start');
  if (words.length < 2) return null;
  const first = words[0].normalize('NFC');
  const verb = first in VI_VERBS ? first : VI_PLAIN_VERBS[first];
  if (!verb) return null;
  let rest = strip(words.slice(1), VI_BETWEEN, 'start');
  rest = strip(rest, VI_AFTER, 'end');
  if (!rest.length) return null;
  return { lang: 'vi', state: VI_VERBS[verb], name: rest.join(' '), verb: first in VI_VERBS ? first : undefined };
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
const MANDARIN = /[开关灯厅门帮请这吧么们厨书边头楼区细写办闭灭闩个后车库卧风电视机热气饭园帘间儿把]/;

const hasChinese = (text: string) => /[㐀-鿿]/.test(text);

const takeFirst = (text: string, verbs: string[]) => verbs.find((v) => text.startsWith(v));
const takeLast = (text: string, verbs: string[]) => verbs.find((v) => text.endsWith(v));

export function parseChinese(text: string): NativeCommand | null {
  if (!hasChinese(text)) return null;
  const lang: NativeLang = MANDARIN.test(text) ? 'zh' : 'yue';
  let t = text.replace(/[\s.!?,;:。！？，、～~]+/g, '').replace(ZH_BEFORE, '').replace(ZH_AFTER, '');
  if (!t) return null;

  const on = takeFirst(t, ZH_ON), off = takeFirst(t, ZH_OFF);
  const first = [on, off].filter(Boolean).sort((a, b) => b!.length - a!.length)[0];
  if (first) {
    // 開下廚房燈, 熄咗個燈: the 下 or 咗 after the verb isn't part of the name.
    const name = t.slice(first.length).replace(/^(?:下|咗|埋|返|個|个|一下)/, '');
    return name ? { lang, state: first === on, name } : null;
  }

  t = t.replace(ZH_BA, '');
  const onLast = takeLast(t, ZH_ON_LAST), offLast = takeLast(t, ZH_OFF_LAST);
  const last = [onLast, offLast].filter(Boolean).sort((a, b) => b!.length - a!.length)[0];
  if (!last) return null;
  const name = t.slice(0, -last.length);
  return name ? { lang, state: last === onLast, name } : null;
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
    closing:    (name: string) => `Đang đóng ${name}.`,
    unreached:  (names: string) => `Không kết nối được ${names}.`,
    which:      (names: string) => `Ý bạn là cái nào: ${names}?`,
    protected:  (name: string) => `${name} được bảo vệ, nên tôi không bật tắt nó từ đây. Hãy dùng nút của nó trên trang chủ.`,
    doorOpen:   'Vì an toàn, tôi không mở cửa ga-ra từ đây. Hãy dùng nút của nó trên trang chủ. Tôi có thể đóng cửa.',
    cameraStop: 'Vì an toàn, tôi không thể tạm dừng camera theo cách này.',
  },
  yue: {
    done:       (c: NativeCommand, name: string) => `${c.state ? '開' : '熄'}咗${name}。`,
    closing:    (name: string) => `閂緊${name}。`,
    unreached:  (names: string) => `連唔到${names}。`,
    which:      (names: string) => `你指邊個：${names}？`,
    protected:  (name: string) => `${name}受保護，我唔會喺度開關佢。請用主頁上面個掣。`,
    doorOpen:   '為咗安全，我唔會喺度開車房門。請用主頁上面個掣。我可以幫你閂。',
    cameraStop: '為咗安全，我唔可以咁樣暫停鏡頭。',
  },
  zh: {
    done:       (c: NativeCommand, name: string) => `已${c.state ? '打开' : '关掉'}${name}。`,
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
      return { response: say.done(command, command.name), actions };
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
export async function runNativeCommand(text: string): Promise<Handled | null> {
  const command = parseNativeCommand(text);
  if (!command) return null;
  const name = homeName(command.name);
  // Vietnamese typed without accents is answered with them; Chinese keeps the characters typed.
  if (command.lang === 'vi') command.name = name;
  // "mở cửa ga-ra", "閂車房門": a garage door is closed (and never opened); anything else switched.
  const door = isGarageDoorName(name);
  const result = await runPowerCommand(door ? `${command.state ? 'open' : 'close'} ${name}` : `turn ${command.state ? 'on' : 'off'} ${name}`);
  return result ? inLanguage(result, command) : null;
}
