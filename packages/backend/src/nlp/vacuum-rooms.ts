/**
 * Robot vacuum jobs by voice and in Chat, in English, Cantonese, Mandarin and Vietnamese:
 *
 *   "vacuum the kitchen"              "clean the kitchen and the living room"
 *   "掃廚房" / "吸塵客廳同廚房"          "打扫厨房"
 *   "hút bụi nhà bếp"                 "vacuum the whole house"
 *
 * A room is one learned from the robot and named (roomba/rooms.ts), by its name or, when HomeHub
 * knows the words, its name in the other languages. Every room said must be known, so "clean the
 * kitchen light" is left for the other rules. The whole house is the robot's plain start.
 */
import { getDb } from '../db';
import { normalize } from './find-device';
import { placeNames } from './nickname-suggest';
import { runGroupCommand } from './commands';
import { cleanRooms, VacuumBusyError } from '../roomba/service';
import { roomsOf } from '../roomba/rooms';
import { assistantMaySwitch, type PowerDevice } from '../devices/power';
import type { ActionTaken } from './nlp.service';
import { logger } from '../logger';

export type VacuumLang = 'en' | 'yue' | 'zh' | 'vi';
type Handled = { response: string; actions: ActionTaken[]; lang: VacuumLang; ask?: never };
/** With its language, so a speaker says a Cantonese, Mandarin or Vietnamese answer in that voice. */
type Said = Handled & { said?: { lang: Exclude<VacuumLang, 'en'> } };

/** Simplified characters in room and verb words, as traditional, so 厨房 and 廚房 compare the same. */
const S2T: Record<string, string> = Object.fromEntries(
  [...'厨廚厅廳扫掃尘塵洁潔卫衛间間卧臥区區门門关關园園阳陽楼樓书書儿兒饭飯后後车車库庫'.matchAll(/(.)(.)/g)].map(([, s, t]) => [s, t]),
);

/** Lower case, no accents, traditional characters, single spaces. */
export const foldText = (text: string) =>
  normalize(text).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
    .replace(/[^\x00-\x7f]/g, (c) => S2T[c] ?? c).replace(/\s+/g, ' ').trim();

const WHOLE_HOUSE = /^(?:the )?(?:whole|entire) (?:house|home|place|floor)$|^(?:the )?(?:house|home)$|^everywhere$|^everything$|^all (?:the )?rooms$|^(?:成|全)(?:間)?屋$|^全家$|^所有房間$|^ca nha$|^toan bo nha$|^khap nha$/;

interface Heard { lang: VacuumLang; rooms: string[] }

/** The rooms a message asks the vacuum to clean, as said, or null if it isn't asking that. */
export function readVacuumCommand(text: string): Heard | null {
  const t = foldText(text).replace(/[.!?。！？]+$/, '').trim();
  let m = t.match(/^(?:please |can you |could you )?(?:(?:have|tell|ask|get|send|make) (?:the |my )?(?:vacuum|roomba|robot|robot vacuum) (?:to )?(?:go )?)?(?:vacuum|clean|hoover|sweep) (?:up )?(.+?)(?: please)?$/);
  if (!m) m = t.match(/^(?:the |my )?(?:vacuum|roomba|robot|robot vacuum),? (?:please )?(?:vacuum|clean|hoover|sweep) (.+?)(?: please)?$/);
  if (m) return { lang: 'en', rooms: m[1].split(/\s*(?:,|\band\b|&)\s*/).map((r) => r.replace(/^the /, '').trim()).filter(Boolean) };

  // Cantonese and Mandarin: an optional "have the robot go", a verb, then the rooms.
  m = t.match(/^(?:(?:請|麻煩)?(?:你)?(?:叫|讓|让|請)?(?:個)?(?:掃地機(?:械人)?|機械人|吸塵機|扫地机器人|扫地机)?(?:去)?)?(?:掃|吸塵|打掃|清潔|清掃)(?:一下|下)?(.+?)(?:啦|吖|呀|喇|吧|啊|喔)?$/);
  if (m) {
    const lang: VacuumLang = /[吖喇啦]|吸塵|掃地機/.test(text) && !/[吧让]/.test(text) ? 'yue' : /[们这吧让扫尘厨厅]/.test(text) ? 'zh' : 'yue';
    return { lang, rooms: m[1].split(/\s*(?:同|和|及|、|，|,|跟)\s*/).map((r) => r.replace(/^(?:個|間|那个|个)/, '').trim()).filter(Boolean) };
  }

  // Vietnamese, accents folded: "hút bụi nhà bếp", "quét phòng khách và nhà bếp".
  m = t.match(/^(?:(?:cho|bao|kêu|keu) (?:robot|may hut bui|robot hut bui) )?(?:hut bui|quet|don dep|don|ve sinh|lau) (?:o |cho )?(.+?)(?: di| nhe| nha)?$/);
  if (m) return { lang: 'vi', rooms: m[1].split(/\s*(?:,| va )\s*/).map((r) => r.trim()).filter(Boolean) };
  return null;
}

interface Robot extends PowerDevice { id: number; alias: string; is_protected: number }

/** A named room's names in each language, folded, for matching what was said. */
function namesFor(name: string): string[] {
  const p = placeNames(name);
  const english = foldText(name);
  return [...new Set([english, english.replace(/ room$/, ''), p.yue, p.zh, ...p.vi].filter((n): n is string => !!n).map(foldText))];
}

/** "Kitchen" in the message's language, for the reply. */
function sayName(name: string, lang: VacuumLang): string {
  if (lang === 'en') return name;
  const p = placeNames(name);
  return (lang === 'vi' ? p.vi[p.vi.length - 1] : lang === 'zh' ? p.zh : p.yue) ?? name;
}

const join = (names: string[], lang: VacuumLang) => {
  if (names.length < 2) return names.join('');
  const and = lang === 'en' ? ' and ' : lang === 'vi' ? ' và ' : lang === 'zh' ? '和' : '同';
  return names.slice(0, -1).join(lang === 'en' ? ', ' : lang === 'vi' ? ', ' : '、') + and + names[names.length - 1];
};

const REPLIES = {
  rooms: { en: (r: string) => `Cleaning the ${r}.`, yue: (r: string) => `而家去掃${r}。`, zh: (r: string) => `正在打扫${r}。`, vi: (r: string) => `Đang hút bụi ${r}.` },
  house: { en: (a: string) => `Starting ${a} on the whole house.`, yue: () => '而家掃成間屋。', zh: () => '正在打扫整个家。', vi: () => 'Đang hút bụi cả nhà.' },
  busy: {
    en: (a: string) => `${a} is already cleaning. Send it home first, then start the rooms.`,
    yue: () => '掃地機而家做緊嘢，叫佢返去先，再叫佢掃。', zh: () => '扫地机正在打扫，请先让它回去充电，再开始。', vi: () => 'Robot đang hút bụi. Cho nó về sạc trước rồi bắt đầu lại.',
  },
  unreachable: { en: (a: string) => `I couldn't reach ${a}.`, yue: () => '連唔到掃地機。', zh: () => '连不上扫地机。', vi: () => 'Không kết nối được với robot hút bụi.' },
  protected: { en: (a: string) => `${a} is protected, so use its tile on the dashboard.`, yue: () => '掃地機受保護，請用主頁上面嘅掣。', zh: () => '扫地机受保护，请用主页上的按钮。', vi: () => 'Robot hút bụi được bảo vệ, hãy dùng nút trên trang chính.' },
};

/**
 * Cleans the rooms a message asks for, or the whole house, and answers in its language. Null when
 * the message isn't a vacuum job, or names a room no robot has, so other rules can try it.
 */
export async function runVacuumCommand(text: string): Promise<Said | null> {
  const done = await vacuumJob(text);
  return done && done.lang !== 'en' ? { ...done, said: { lang: done.lang } } : done;
}

async function vacuumJob(text: string): Promise<Handled | null> {
  const said = readVacuumCommand(text);
  if (!said || !said.rooms.length) return null;
  const robots = getDb().prepare("SELECT * FROM devices WHERE driver_type = 'roomba' ORDER BY id").all() as Robot[];
  if (!robots.length) return null;
  const { lang } = said;

  if (said.rooms.length === 1 && WHOLE_HOUSE.test(said.rooms[0])) {
    const robot = robots[0];
    if (!assistantMaySwitch(robot, true)) return { response: REPLIES.protected[lang](robot.alias), actions: [], lang };
    const result = await runGroupCommand([robot], { name: robot.alias, state: true });
    const ok = result.actions.every((a) => (a.result as { success?: boolean } | undefined)?.success);
    return { response: ok ? REPLIES.house[lang](robot.alias) : REPLIES.unreachable[lang](robot.alias), actions: result.actions, lang };
  }

  // Each room said must be one robot's named room.
  for (const robot of robots) {
    const rooms = roomsOf(robot.id).filter((r) => r.name);
    const keys: string[] = [];
    const names: string[] = [];
    for (const spoken of said.rooms) {
      const wanted = foldText(spoken);
      const room = rooms.find((r) => namesFor(r.name!).includes(wanted));
      if (!room) break;
      keys.push(room.key);
      names.push(room.name!);
    }
    if (keys.length !== said.rooms.length) continue;

    const args = { alias: robot.alias, rooms: names.join(', ') };
    if (!assistantMaySwitch(robot, true)) return { response: REPLIES.protected[lang](robot.alias), actions: [], lang };
    try {
      await cleanRooms(robot.id, keys);
      const spokenNames = join([...new Set(names)].map((n) => sayName(n, lang)), lang);
      return { response: REPLIES.rooms[lang](spokenNames), actions: [{ tool: 'clean_rooms', args, result: { success: true, ...args } }], lang };
    } catch (err) {
      const busy = err instanceof VacuumBusyError;
      if (!busy) logger.warn({ id: robot.id, reason: (err as Error).message }, 'Room clean by voice or Chat failed');
      return {
        response: busy ? REPLIES.busy[lang](robot.alias) : REPLIES.unreachable[lang](robot.alias),
        actions: [{ tool: 'clean_rooms', args, result: { error: (err as Error).message } }],
        lang,
      };
    }
  }
  return null;
}

/** For the chat models' clean_rooms tool: room names separated by commas, or "whole house". */
export async function cleanRoomsByName(rooms: string): Promise<{ success: true; note: string } | { error: string }> {
  const list = rooms.split(/\s*,\s*|\s+and\s+/).map((r) => r.trim()).filter(Boolean);
  if (!list.length) return { error: 'Say which rooms, or "whole house".' };
  const done = await runVacuumCommand(`vacuum ${list.join(', ')}`);
  if (!done) {
    const named = (getDb().prepare("SELECT id FROM devices WHERE driver_type = 'roomba'").all() as { id: number }[])
      .flatMap((r) => roomsOf(r.id).filter((x) => x.name).map((x) => x.name!));
    return { error: named.length ? `No room by that name. The robot's rooms are: ${named.join(', ')}.` : 'There is no robot vacuum, or none of its rooms has been named yet in HomeHub.' };
  }
  const failed = done.actions.some((a) => (a.result as { error?: string } | undefined)?.error);
  return failed ? { error: done.response } : { success: true, note: done.response };
}
