/**
 * Setting things up from Chat: spoken reminders, daily check-ins, and who gets told.
 *
 *   "remind Mum to take her medicine at 9 every morning and check she did"
 *     → "Should I add this reminder? At 9 AM every day the speakers will say "Time to take your
 *        medicine", then ask if it's done. If nobody says yes, the family is told."
 *   "yes" → saved, as if added on the Family page.
 *
 * The model fills in the tool's arguments; HomeHub checks them exactly as the Family page does,
 * reads them back in the person's language, and saves only on a yes. A model can misread "9" as
 * 9 PM, or Mum's check-in as everyone's, so nothing is saved on its word alone.
 *
 * Reminders are anyone's to add, as on the Family page; check-ins are an admin's. These tools are
 * offered to Claude only: the small local model mixes up tools as the list grows (the command test
 * set), and light switching matters more.
 */
import { getDb } from '../db';
import { deleteReminder, listReminders, readReminder, ReminderError, saveReminder, type Reminder } from '../family/reminders';
import { audience, CheckinError, deleteCheckin, listCheckins, saveCheckin, type Checkin } from '../family/checkin';
import type { Lang } from './confirm';

// ── What's waiting for a yes, per person ────────────────────────

export interface Plan {
  lang: Lang;
  /** The question asked: what a yes will do. */
  question: string;
  /** Does it, and says what was done. */
  run: () => string;
}

const PLAN_MS = 2 * 60_000;
const plans = new Map<string, { plan: Plan; until: number }>();

export function setPlan(who: string, plan: Plan, now = Date.now()): void { plans.set(who, { plan, until: now + PLAN_MS }); }

/** The plan `who` was last asked about, if still waiting. Taken: a second answer finds nothing. */
export function takePlan(who: string, now = Date.now()): Plan | null {
  const w = plans.get(who);
  plans.delete(who);
  return w && w.until > now ? w.plan : null;
}

export const PLAN_DECLINED: Record<Lang, string> = {
  en: 'OK, I didn’t set anything up.', vi: 'Được, tôi chưa cài đặt gì.', yue: '好，我冇設定任何嘢。', zh: '好的，我什么都没设置。',
};

// ── The tools ───────────────────────────────────────────────────

const LANG_ARG = { type: 'string', enum: ['en', 'yue', 'zh', 'vi'], description: 'The language the user wrote in: en, yue (Cantonese), zh (Mandarin) or vi' };
const DAYS_ARG = {
  type: 'array', items: { type: 'integer' },
  description: 'Weekdays, 0 = Sunday to 6 = Saturday. Leave out for every day. Weekdays: [1,2,3,4,5]',
};

export const SETUP_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_reminder',
      description: 'Add a spoken reminder: the home’s speakers say it out loud at the times given, such as "Time to take your medicine" at 09:00, '
        + 'or "Time to drink some water" every 2 hours from 9 to 5 (times 09:00, 11:00, 13:00, 15:00, 17:00). The user is asked to confirm before it is saved. '
        + 'If they didn’t say when, ask them first. Not for switching devices: use create_schedule for that.',
      parameters: {
        type: 'object',
        properties: {
          text:  { type: 'string', description: 'What the speakers say, written as it should be said, in the language it should be said in, e.g. "Time to take your medicine" or "食藥喇"' },
          times: { type: 'array', items: { type: 'string' }, description: 'Times of day, 24-hour HH:MM, at most 12, e.g. ["09:00"] or ["09:00","21:00"]' },
          days:  DAYS_ARG,
          ask:   { type: 'boolean', description: 'True to ask afterwards if it was done ("did you take it?"), and tell the family if nobody says yes. For medicine, usually true.' },
          lang:  LANG_ARG,
        },
        required: ['text', 'times', 'lang'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: 'List the spoken reminders, with their ids, times and days',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_reminder',
      description: 'Delete spoken reminders by id (from list_reminders). The user is asked to confirm first.',
      parameters: {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'integer' } }, lang: LANG_ARG },
        required: ['ids', 'lang'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_checkin',
      description: 'Set up a daily check-in: if there is no sign of anyone at home (a light or plug switched, motion, the app, voice, water) '
        + 'between "from" and "by", HomeHub tells the family. E.g. "tell us if there’s no activity at Mum’s by 10 AM". Admins only. The user is asked to confirm first.',
      parameters: {
        type: 'object',
        properties: {
          name:      { type: 'string', description: 'Who or what it watches over, as the family says it, e.g. "Mum" or "Grandpa"' },
          by:        { type: 'string', description: 'The time by which there should be a sign of activity, 24-hour HH:MM, e.g. "10:00"' },
          from:      { type: 'string', description: 'When it starts looking, 24-hour HH:MM. Leave out for 05:00.' },
          days:      DAYS_ARG,
          ask_first: { type: 'boolean', description: 'True to ask out loud at home first ("are you OK?") before telling the family' },
          lang:      LANG_ARG,
        },
        required: ['name', 'by', 'lang'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_checkins',
      description: 'List the daily check-ins, with their ids and what they watch for',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_checkin',
      description: 'Delete a daily check-in by id (from list_checkins). Admins only. The user is asked to confirm first.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer' }, lang: LANG_ARG },
        required: ['id', 'lang'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'who_gets_alerts',
      description: 'Who HomeHub tells when a check-in sees no activity, a reminder goes unanswered, or someone asks for help: the phones with HomeHub’s notifications on, and email',
      parameters: { type: 'object', properties: {} },
    },
  },
] as const;

export const SETUP_TOOL_NAMES = new Set<string>(SETUP_TOOLS.map((t) => t.function.name));

// ── Saying times and days ───────────────────────────────────────

const asLang = (v: unknown): Lang => (v === 'yue' || v === 'zh' || v === 'vi' ? v : 'en');

/** "9 AM", "9:30 PM"; 上午9點; 9 giờ sáng. */
export function timeWords(hhmm: string, lang: Lang): string {
  const [h, m] = hhmm.split(':').map(Number);
  const mm = m ? `:${String(m).padStart(2, '0')}` : '';
  const h12 = h % 12 || 12;
  if (lang === 'en') return h === 0 && !m ? 'midnight' : h === 12 && !m ? 'noon' : `${h12}${mm} ${h < 12 ? 'AM' : 'PM'}`;
  if (lang === 'vi') return `${h12}${m ? ` giờ ${m}` : ' giờ'} ${h < 11 ? 'sáng' : h < 13 ? 'trưa' : h < 18 ? 'chiều' : 'tối'}`;
  const part = h < 6 ? '凌晨' : h < 12 ? '上午' : h < 13 ? '中午' : h < 18 ? '下午' : '晚上';
  const point = lang === 'yue' ? '點' : '点';
  return `${part}${h12}${point}${m ? `${m}分` : ''}`;
}

function listWords(items: string[], lang: Lang): string {
  if (items.length < 2) return items.join('');
  const and = { en: ' and ', vi: ' và ', yue: '同', zh: '和' }[lang];
  const sep = lang === 'en' || lang === 'vi' ? ', ' : '、';
  return items.slice(0, -1).join(sep) + and + items[items.length - 1];
}

const DAY_NAMES: Record<Lang, string[]> = {
  en:  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  vi:  ['Chủ nhật', 'thứ Hai', 'thứ Ba', 'thứ Tư', 'thứ Năm', 'thứ Sáu', 'thứ Bảy'],
  yue: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
  zh:  ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
};

/** "every day", "on weekdays", "on Monday and Thursday". */
export function dayWords(days: number[], lang: Lang): string {
  const key = [...days].sort().join('');
  const every = { en: 'every day', vi: 'mỗi ngày', yue: '每日', zh: '每天' }[lang];
  if (key === '0123456') return every;
  if (key === '12345') return { en: 'on weekdays', vi: 'các ngày trong tuần', yue: '星期一至五', zh: '周一到周五' }[lang];
  if (key === '06') return { en: 'at weekends', vi: 'cuối tuần', yue: '週末', zh: '周末' }[lang];
  const names = listWords([...days].sort().map((d) => DAY_NAMES[lang][d]), lang);
  return lang === 'en' ? `on ${names}` : lang === 'vi' ? `vào ${names}` : names;
}

// ── Running a tool ──────────────────────────────────────────────

export interface SetupContext { who: string; admin: boolean }

/** A tool's answer for the model, and, when HomeHub is asking, the question to put to the person. */
export interface SetupResult { result: unknown; ask?: Plan }

const ADMIN_ONLY = { error: 'Only an admin can set up check-ins. Tell the user to ask an admin, or to use the Family page if they are one.' };

const asking = (plan: Plan): SetupResult => ({
  result: { asking: true, note: 'HomeHub is asking the user to confirm. Nothing is saved until they say yes.' }, ask: plan,
});

/** "9 AM and 9 PM every day"; in Chinese the days come first, with no spaces: 每日上午9點. */
function whenWords(times: string[], days: number[], lang: Lang): string {
  const t = listWords(times.map((x) => timeWords(x, lang)), lang);
  return lang === 'yue' || lang === 'zh' ? `${dayWords(days, lang)}${t}` : `${t} ${dayWords(days, lang)}`;
}

const reminderLine = (r: Pick<Reminder, 'text' | 'at' | 'days'>, lang: Lang) =>
  `${whenWords([r.at], r.days, lang)}${lang === 'yue' || lang === 'zh' ? '：' : ': '}“${r.text}”`;

function createReminder(args: Record<string, unknown>): SetupResult {
  const lang = asLang(args['lang']);
  const raw = Array.isArray(args['times']) ? args['times'] : typeof args['times'] === 'string' ? [args['times']] : [];
  // "9:00" is read as "09:00".
  const times = [...new Set(raw.map((t) => String(t).trim().replace(/^(\d):/, '0$1:')))].sort();
  if (!times.length) return { result: { error: 'Say when: times is required, 24-hour HH:MM. Ask the user when if they didn’t say.' } };
  if (times.length > 12) return { result: { error: 'At most 12 times a day. Ask the user to space them out.' } };
  const input = { text: args['text'], at: times[0], ask: args['ask'] === true, ...(args['days'] !== undefined ? { days: args['days'] } : {}) };
  let checked: ReturnType<typeof readReminder>;
  try {
    checked = readReminder(input);
    for (const at of times.slice(1)) readReminder({ ...input, at });
  } catch (err) {
    if (err instanceof ReminderError) return { result: { error: err.message } };
    throw err;
  }
  const when = whenWords(times, checked.days, lang);
  const q: Record<Lang, string> = {
    en:  `Should I add ${times.length > 1 ? 'these reminders' : 'this reminder'}? At ${when} the speakers will say “${checked.text}”${checked.ask ? ', then ask if it’s done. If nobody says yes, the family is told' : ''}.`,
    vi:  `Có phải bạn muốn thêm lời nhắc này không? Lúc ${when}, loa sẽ nói “${checked.text}”${checked.ask ? ', rồi hỏi đã làm chưa. Nếu không ai trả lời có, gia đình sẽ được báo' : ''}.`,
    yue: `要唔要加呢個提醒？${when}，喇叭會講「${checked.text}」${checked.ask ? '，再問做咗未。冇人答係嘅話，就會通知家人' : ''}。`,
    zh:  `要添加这个提醒吗？${when}，音箱会说“${checked.text}”${checked.ask ? '，然后问做了没有。没人回答是的话，就会通知家人' : ''}。`,
  };
  return asking({
    lang, question: q[lang],
    run: () => {
      const saved = times.map((at) => saveReminder({ ...input, at }));
      const done: Record<Lang, string> = {
        en: `Done. ${saved.length > 1 ? `${saved.length} reminders are` : 'The reminder is'} on the Family page, where you can change or pause ${saved.length > 1 ? 'them' : 'it'}.`,
        vi: 'Xong. Lời nhắc ở trang Gia đình, nơi bạn có thể sửa hoặc tạm dừng.',
        yue: '搞掂。提醒喺「家人」頁，可以喺嗰度改或者暫停。',
        zh: '好了。提醒在“家人”页面，可以在那里修改或暂停。',
      };
      return done[lang];
    },
  });
}

function deleteReminders(args: Record<string, unknown>): SetupResult {
  const lang = asLang(args['lang']);
  const ids = (Array.isArray(args['ids']) ? args['ids'] : [args['ids']]).map(Number).filter(Number.isInteger);
  const all = listReminders();
  const found = all.filter((r) => ids.includes(r.id));
  if (!found.length) return { result: { error: 'No reminder has that id. Use list_reminders.' } };
  const lines = found.map((r) => reminderLine(r, lang)).join('; ');
  const q: Record<Lang, string> = {
    en: `Should I delete ${found.length > 1 ? `these ${found.length} reminders` : 'this reminder'}? ${lines}`,
    vi: `Có phải bạn muốn xoá lời nhắc này không? ${lines}`,
    yue: `要唔要刪除呢個提醒？${lines}`,
    zh: `要删除这个提醒吗？${lines}`,
  };
  return asking({
    lang, question: q[lang],
    run: () => {
      const n = found.filter((r) => deleteReminder(r.id)).length;
      return { en: `Deleted ${n === 1 ? 'it' : `${n} reminders`}.`, vi: 'Đã xoá.', yue: '已經刪咗。', zh: '已删除。' }[lang];
    },
  });
}

/** "the HomeHub app on 3 phones (Anna and Jeff) and 2 email addresses", or null when nobody would be told. */
function audienceWords(lang: Lang): string | null {
  const a = audience();
  if (!a.phones && !a.emails) return null;
  const parts: string[] = [];
  if (lang === 'en') {
    if (a.phones) parts.push(`the HomeHub app on ${a.phones} ${a.phones === 1 ? 'phone' : 'phones'}${a.people.length ? ` (${listWords(a.people, 'en')})` : ''}`);
    if (a.emails) parts.push(`${a.emails} email ${a.emails === 1 ? 'address' : 'addresses'}`);
    return parts.join(' and ');
  }
  if (a.phones) parts.push({ vi: `ứng dụng HomeHub trên ${a.phones} điện thoại`, yue: `${a.phones}部手機嘅HomeHub`, zh: `${a.phones}部手机上的HomeHub` }[lang]);
  if (a.emails) parts.push({ vi: `${a.emails} địa chỉ email`, yue: `${a.emails}個電郵地址`, zh: `${a.emails}个邮箱` }[lang]);
  return listWords(parts, lang);
}

const NOBODY: Record<Lang, string> = {
  en: 'Nobody would be told yet: turn on notifications in the HomeHub app on each phone that should hear, in Settings → Notifications.',
  vi: 'Hiện chưa ai nhận được thông báo: hãy bật thông báo trong ứng dụng HomeHub trên mỗi điện thoại, ở Cài đặt → Thông báo.',
  yue: '而家未有人會收到通知：喺每部要收嘅手機，打開HomeHub「設定 → 通知」。',
  zh: '现在还没有人会收到通知：在每部要收的手机上，打开HomeHub“设置 → 通知”。',
};

function createCheckin(args: Record<string, unknown>, ctx: SetupContext): SetupResult {
  if (!ctx.admin) return { result: ADMIN_ONLY };
  const lang = asLang(args['lang']);
  const hhmm = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/^(\d):/, '0$1:') : v);
  const input: Record<string, unknown> = {
    name: args['name'], by: hhmm(args['by']), ...(args['from'] !== undefined ? { from: hhmm(args['from']) } : {}),
    ...(args['days'] !== undefined ? { days: args['days'] } : {}), askFirst: args['ask_first'] === true,
  };
  // Checked the way saving checks it, without saving: in a transaction that's rolled back.
  let preview: Checkin;
  const db = getDb();
  try {
    db.exec('SAVEPOINT checkin_preview');
    try { preview = saveCheckin(input); } finally { db.exec('ROLLBACK TO checkin_preview'); db.exec('RELEASE checkin_preview'); }
  } catch (err) {
    if (err instanceof CheckinError) return { result: { error: err.message } };
    throw err;
  }
  const who = audienceWords(lang);
  const [f, b] = [timeWords(preview.from, lang), timeWords(preview.by, lang)];
  const days = dayWords(preview.days, lang);
  const span = { en: `between ${f} and ${b} ${days}`, vi: `từ ${f} đến ${b} ${days}`, yue: `${days}${f}至${b}`, zh: `${days}${f}到${b}` }[lang];
  const q: Record<Lang, string> = {
    en:  `Should I set up a check-in for ${preview.name}? If there’s no sign of activity at home ${span} (a light or plug switched, motion, the app, voice or water), `
      + `${preview.askFirst ? 'I’ll ask at home first, then ' : ''}${who ? `tell ${who}.` : 'tell the family.'}`,
    vi:  `Có phải bạn muốn cài kiểm tra hằng ngày cho ${preview.name} không? Nếu không có hoạt động nào trong nhà ${span}, ${preview.askFirst ? 'tôi sẽ hỏi trong nhà trước, rồi ' : ''}báo cho ${who ?? 'gia đình'}.`,
    yue: `要唔要幫${preview.name}設定每日報平安？如果${span}屋企冇任何動靜，${preview.askFirst ? '我會先喺屋企問一聲，再' : ''}通知${who ?? '家人'}。`,
    zh:  `要为${preview.name}设置每日报平安吗？如果${span}家里没有任何动静，${preview.askFirst ? '我会先在家里问一声，再' : ''}通知${who ?? '家人'}。`,
  };
  return asking({
    lang, question: `${q[lang]}${who ? '' : ` ${NOBODY[lang]}`}`,
    run: () => {
      saveCheckin(input);
      return {
        en: 'Done. It’s on the Family page, where you can choose which devices count, pause it, or send a test alert.',
        vi: 'Xong. Có thể xem ở trang Gia đình, để chọn thiết bị, tạm dừng hoặc gửi thông báo thử.',
        yue: '搞掂。喺「家人」頁可以揀邊啲裝置計、暫停，或者試發通知。',
        zh: '好了。在“家人”页面可以选择哪些设备算数、暂停，或者发送测试通知。',
      }[lang];
    },
  });
}

function removeCheckin(args: Record<string, unknown>, ctx: SetupContext): SetupResult {
  if (!ctx.admin) return { result: ADMIN_ONLY };
  const lang = asLang(args['lang']);
  const c = listCheckins().find((x) => x.id === Number(args['id']));
  if (!c) return { result: { error: 'No check-in has that id. Use list_checkins.' } };
  const q: Record<Lang, string> = {
    en: `Should I delete the check-in for ${c.name} (by ${timeWords(c.by, 'en')})? The family won’t be told if there’s no activity.`,
    vi: `Có phải bạn muốn xoá kiểm tra hằng ngày cho ${c.name} không?`,
    yue: `要唔要刪除${c.name}嘅每日報平安？`,
    zh: `要删除${c.name}的每日报平安吗？`,
  };
  return asking({
    lang, question: q[lang],
    run: () => (deleteCheckin(c.id) ? { en: 'Deleted.', vi: 'Đã xoá.', yue: '已經刪咗。', zh: '已删除。' }[lang] : 'It was already gone.'),
  });
}

/** Runs one of SETUP_TOOLS. */
export function runSetupTool(name: string, args: Record<string, unknown>, ctx: SetupContext): SetupResult {
  switch (name) {
    case 'create_reminder': return createReminder(args);
    case 'delete_reminder': return deleteReminders(args);
    case 'list_reminders':
      return { result: listReminders().map((r) => ({ id: r.id, text: r.text, at: r.at, when: reminderLine(r, 'en'), enabled: r.enabled, asksIfDone: r.ask })) };
    case 'create_checkin': return createCheckin(args, ctx);
    case 'delete_checkin': return removeCheckin(args, ctx);
    case 'list_checkins':
      return {
        result: listCheckins().map((c) => ({
          id: c.id, name: c.name, from: c.from, by: c.by, days: dayWords(c.days, 'en'), enabled: c.enabled, asksAtHomeFirst: c.askFirst, pausedUntil: c.pausedUntil,
        })),
      };
    case 'who_gets_alerts': {
      const a = audience();
      return {
        result: {
          phones: a.phones, people: a.people, emailAddresses: a.emails, summary: audienceWords('en') ?? NOBODY.en,
          howToChange: 'Each person turns on notifications in the HomeHub app on their own phone, in Settings → Notifications. Email addresses are set by an admin in Settings → Integrations → Email alerts.',
        },
      };
    }
    default: return { result: { error: `Unknown tool ${name}` } };
  }
}
