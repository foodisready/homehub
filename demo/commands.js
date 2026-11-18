/**
 * Reading a kitchen command in English, Cantonese, Mandarin or Vietnamese, and HomeHub's reply in
 * the same language. A small stand-in for HomeHub's real command reader, for the demo only: it
 * knows one room and three lights.
 *
 *   "dim the pendants to 30%"   → { kind: 'set', targets: ['pendants'], on: true, level: 30 }
 *   "bật đèn thả 10 phút"       → { kind: 'set', targets: ['pendants'], on: true, when: { type: 'for', minutes: 10 } }
 *   "夜晚七點半食飯"             → { kind: 'scene', scene: 'dinner', when: { type: 'at', h: 7, m: 30, period: 'pm' } }
 *
 * Pure functions, no DOM: the tests run them under Node.
 */

export const LIGHT_IDS = ['ceiling', 'counter', 'pendants'];
export const SCENE_IDS = ['cooking', 'dinner', 'nightlight', 'goodnight'];

/* ── Language ──────────────────────────────────────────────── */

const HAN = /[㐀-鿿]/;
const VI_MARKS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
// Characters written one way in Hong Kong (Cantonese) and another in mainland Mandarin, and
// words only one of them uses (咗, 唔, 嘅 are Cantonese; 了, 吗 are Mandarin).
const SIMPLIFIED = /[开关厨灯调钟点后个么吗时饭现这了吧]/g;
const TRADITIONAL = /[開關閂熄廚燈調鐘點後個咗唔嘅啦喺飯時嗰呢唞瞓晒啲]/g;

/** Lower case, accents off, đ → d: "Bật Đèn" → "bat den". */
export function fold(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
}

export function detectLanguage(text) {
  if (HAN.test(text)) {
    const s = (text.match(SIMPLIFIED) || []).length;
    const t = (text.match(TRADITIONAL) || []).length;
    if (s !== t) return s > t ? 'zh' : 'yue';
    return /晚安|睡觉|吃饭/.test(text) ? 'zh' : 'yue';
  }
  if (VI_MARKS.test(text)) return 'vi';
  // Typed without accents: "bat den bep".
  if (/\b(bat|tat|mo) den\b|\bden (bep|tran|tha|tu)\b/.test(fold(text))) return 'vi';
  return 'en';
}

/* ── Numbers ───────────────────────────────────────────────── */

const EN_NUM = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, fifty: 50, sixty: 60, ninety: 90,
};
const EN_NUM_RE = `\\d+|${Object.keys(EN_NUM).sort((a, b) => b.length - a.length).join('|')}`;
const enNumber = (s) => (/^\d+$/.test(s) ? +s : EN_NUM[s]);

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_NUM_RE = '[0-9]+|[零〇一二兩两三四五六七八九十百]+';
/** 七 → 7, 十五 → 15, 二十 → 20, 一百 → 100, 30 → 30. */
export function cnNumber(s) {
  if (/^\d+$/.test(s)) return +s;
  if (/^一?百$/.test(s)) return 100;
  if (s.includes('十')) {
    const [tens, ones] = s.split('十');
    return (tens ? CN_DIGIT[tens] : 1) * 10 + (ones ? CN_DIGIT[ones] : 0);
  }
  return s.length === 1 && s in CN_DIGIT ? CN_DIGIT[s] : NaN;
}

const VI_DIGIT = { một: 1, mốt: 1, hai: 2, ba: 3, bốn: 4, tư: 4, năm: 5, lăm: 5, sáu: 6, bảy: 7, tám: 8, chín: 9 };
const VI_NUM_RE = '\\d+|(?:(?:một|hai|ba|bốn|năm|sáu|bảy|tám|chín)\\s+mươi(?:\\s+(?:mốt|hai|ba|bốn|tư|lăm|sáu|bảy|tám|chín))?)|(?:mười(?:\\s+(?:một|hai|ba|bốn|lăm|sáu|bảy|tám|chín))?)|một|hai|ba|bốn|năm|sáu|bảy|tám|chín';
/** "hai mươi" → 20, "mười lăm" → 15, "năm" → 5, "45" → 45. Words keep their accents: "ba" is three, "bà" is grandma. */
export function viNumber(s) {
  if (/^\d+$/.test(s)) return +s;
  const w = s.trim().split(/\s+/);
  if (w[0] === 'mười') return 10 + (w[1] ? VI_DIGIT[w[1]] : 0);
  if (w[1] === 'mươi') return VI_DIGIT[w[0]] * 10 + (w[2] ? VI_DIGIT[w[2]] : 0);
  return VI_DIGIT[w[0]] ?? NaN;
}

/* ── Reading a command ─────────────────────────────────────── */

const EMPTY = () => ({ kind: 'unknown', targets: [], on: null, level: null, relative: null, scene: null, when: null });

export function parseCommand(input) {
  const text = input.trim().normalize('NFC');
  const lang = detectLanguage(text);
  const r = { ...EMPTY(), lang };
  if (!text) return r;
  ({ en: readEn, vi: readVi, yue: readChinese, zh: readChinese }[lang])(text, r, lang);
  if (r.kind === 'unknown' && r.scene) r.kind = 'scene';
  if (r.kind === 'unknown' && (r.on !== null || r.level !== null || r.relative !== null)) r.kind = 'set';
  if (r.kind === 'unknown' && (r.targets.length || r.light)) r.kind = 'ask';   // "kitchen lights": on or off?
  delete r.light;
  if (r.kind === 'set' && r.on === null) r.on = true;              // a level or "brighter" turns it on
  return r;
}

function addTarget(r, id) { if (!r.targets.includes(id)) r.targets.push(id); }

function readEn(text, r) {
  const p = text.toLowerCase().replace(/[’']/g, "'");
  if (/\b(help|what can (i|you) (say|do)|examples?)\b/.test(p)) { r.kind = 'help'; return; }

  if (/\b(ceiling|overhead|main lights?|recessed|downlights?|can lights?|cans)\b/.test(p)) addTarget(r, 'ceiling');
  if (/\b(counter(top)?s?|under[- ]?cabinets?|cabinet|pucks?|task lights?)\b/.test(p)) addTarget(r, 'counter');
  if (/\b(pendants?|island|hanging)\b/.test(p)) addTarget(r, 'pendants');

  if (/\bcook(ing)?\b/.test(p)) r.scene = 'cooking';
  else if (/\bdinner\b/.test(p)) r.scene = 'dinner';
  else if (/\bnight ?light\b/.test(p)) r.scene = 'nightlight';
  else if (/\b(good ?night|bed ?time|going to bed)\b/.test(p)) r.scene = 'goodnight';

  r.light = /\b(lights?|lamps?)\b/.test(p);
  const lightWord = r.light || r.targets.length > 0;
  if (!lightWord && !r.scene && /\b(garage|door|camera|fan|tv|thermostat|lock|music)\b/.test(p)) { r.kind = 'elsewhere'; return; }

  const command = /\b(turn|switch|set|dim|brighten|put|make|run|start)\b/.test(p);
  if (!command && (/^(is|are|what|which)\b/.test(p) || /\bstatus\b/.test(p) || (p.endsWith('?') && !r.scene))) {
    r.kind = 'status'; return;
  }

  if (/\b(off|shut|kill)\b/.test(p)) r.on = false;
  else if (/\b(on|light up)\b/.test(p)) r.on = true;

  const pct = p.match(/(\d{1,3})\s*(%|percent)/) || p.match(/\bto\s+(\d{1,3})\b(?!\s*(?:minutes?|mins?|hours?|am|pm|:|o'clock))/);
  if (pct) r.level = clampLevel(+pct[1]);
  else if (/\b(half|halfway)\b/.test(p) && !/half an hour/.test(p)) r.level = 50;
  else if (/\b(full|max(imum)?|all the way|brightest|100)\b/.test(p)) r.level = 100;
  else if (/\b(brighter|turn (it |them )?up|up a bit|more light)\b/.test(p)) r.relative = 25;
  else if (/\b(dimmer|darker|turn (it |them )?down|less light|lower)\b/.test(p)) r.relative = -25;
  else if (/\bdim\b/.test(p)) r.level = 30;
  if (r.on === false) { r.level = null; r.relative = null; }

  r.when = enWhen(p);
}

function enWhen(p) {
  const dur = (word, n) => {
    if (word.startsWith('half')) return 30;
    const v = enNumber(n);
    return /^h/.test(word) ? v * 60 : v;
  };
  let m = p.match(new RegExp(`\\bfor\\s+(?:(half an hour)|(${EN_NUM_RE})\\s*(minutes?|mins?|hours?|hrs?))\\b`));
  if (m) return { type: 'for', minutes: m[1] ? 30 : dur(m[3], m[2]) };
  m = p.match(new RegExp(`\\bin\\s+(?:(half an hour)|(${EN_NUM_RE})\\s*(minutes?|mins?|hours?|hrs?))\\b`));
  if (m) return { type: 'in', minutes: m[1] ? 30 : dur(m[3], m[2]) };
  if (/\bat noon\b/.test(p)) return { type: 'at', h: 12, m: 0, period: 'pm' };
  if (/\bat midnight\b/.test(p)) return { type: 'at', h: 12, m: 0, period: 'am' };
  m = p.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|o'clock)?/) || p.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=\s|$|[.,!?])/);
  if (m) {
    let period = m[3] ? (m[3][0] === 'a' ? 'am' : m[3][0] === 'p' ? 'pm' : null) : null;
    if (!period && /\b(tonight|this evening|in the evening)\b/.test(p)) period = 'pm';
    if (!period && /\b(in the morning|tomorrow morning)\b/.test(p)) period = 'am';
    return { type: 'at', h: +m[1], m: m[2] ? +m[2] : 0, period };
  }
  return null;
}

function readVi(text, r) {
  const low = text.toLowerCase();
  const p = fold(text);
  const words = low.split(/[\s,.!?;:]+/).filter(Boolean);
  if (/\b(giup|huong dan)\b|noi gi/.test(p)) { r.kind = 'help'; return; }

  if (/\bden tran\b|\btran nha\b/.test(p)) addTarget(r, 'ceiling');
  if (/duoi tu|\bden tu\b|tu bep|\bquay\b|ke bep/.test(p)) addTarget(r, 'counter');
  if (/\bden tha\b|\bden treo\b|\bdao\b/.test(p)) addTarget(r, 'pendants');

  if (/nau an|nau com/.test(p)) r.scene = 'cooking';
  else if (/an toi|bua toi/.test(p)) r.scene = 'dinner';
  else if (/den ngu/.test(p)) r.scene = 'nightlight';
  else if (/chuc ngu ngon|di ngu|ngu ngon/.test(p)) r.scene = 'goodnight';

  r.light = words.includes('đèn');
  if (!r.light && !r.targets.length && !r.scene && /cửa|quạt|camera|ti ?vi|máy lạnh/.test(low)) { r.kind = 'elsewhere'; return; }
  if (/đèn nào|đang bật|bật chưa|tắt chưa|có bật không|có tắt không|còn bật không/.test(low)) { r.kind = 'status'; return; }

  if (words.includes('tắt')) r.on = false;
  else if (words.includes('bật') || words.includes('mở')) r.on = true;

  const pct = low.match(/(\d{1,3})\s*(%|phần trăm)/);
  if (pct) r.level = clampLevel(+pct[1]);
  else if (/tối đa|sáng nhất|hết cỡ/.test(low)) r.level = 100;
  else if (/sáng hơn|tăng/.test(low)) r.relative = 25;
  else if (/tối hơn|giảm|mờ hơn/.test(low)) r.relative = -25;
  if (r.on === false) { r.level = null; r.relative = null; }
  if (r.on === null && /\b(chỉnh|để)\b/.test(low) && r.level !== null) r.on = true;

  r.when = viWhen(low);
}

function viWhen(low) {
  const num = `(${VI_NUM_RE})`;
  const minutes = (n, unit) => viNumber(n) * (unit === 'tiếng' ? 60 : 1);
  let m;
  if (/nửa tiếng nữa|sau nửa tiếng/.test(low)) return { type: 'in', minutes: 30 };
  if ((m = low.match(new RegExp(`(?:sau\\s+)?${num}\\s*(phút|tiếng)\\s+nữa`))) || (m = low.match(new RegExp(`sau\\s+${num}\\s*(phút|tiếng)`)))) {
    return { type: 'in', minutes: minutes(m[1], m[2]) };
  }
  if (/nửa tiếng/.test(low)) return { type: 'for', minutes: 30 };
  if ((m = low.match(new RegExp(`(?:trong\\s+)?${num}\\s*(phút|tiếng)`)))) return { type: 'for', minutes: minutes(m[1], m[2]) };
  m = low.match(new RegExp(`(?:lúc\\s*)?(\\d{1,2})\\s*(?:giờ|h(?![a-zà-ỹ])|:)\\s*(\\d{1,2}|rưỡi)?\\s*(sáng|trưa|chiều|tối|đêm)?`))
    || low.match(new RegExp(`(?:lúc\\s*)?${num}\\s+giờ\\s*(rưỡi)?\\s*(sáng|trưa|chiều|tối|đêm)?`));
  if (m && /lúc|giờ|h|:/.test(m[0])) {
    const h = viNumber(m[1]);
    const mm = m[2] === 'rưỡi' ? 30 : m[2] ? +m[2] : 0;
    const part = m[3];
    let period = null;
    if (part === 'sáng') period = 'am';
    else if (part === 'chiều' || part === 'tối') period = 'pm';
    else if (part === 'trưa') period = h === 12 || h < 4 ? 'pm' : 'am';
    else if (part === 'đêm') period = h >= 8 ? 'pm' : 'am';
    if (h > 12) period = null;
    return { type: 'at', h, m: mm, period };
  }
  return null;
}

function readChinese(text, r, lang) {
  const t = text.replace(/\s+/g, '');
  if (/幫助|帮助|點用|怎么用|可以講咩|可以说什么/.test(t)) { r.kind = 'help'; return; }

  let rest = t;
  if (/吊頂|吊顶|天花|頂燈|顶灯/.test(rest)) { addTarget(r, 'ceiling'); rest = rest.replace(/吊頂|吊顶/g, ''); }
  if (/櫃|柜|枱面|檯面|台面/.test(rest)) addTarget(r, 'counter');
  if (/吊燈|吊灯|吊/.test(rest)) addTarget(r, 'pendants');

  if (/煮飯|煮饭|煮嘢食|做饭|做飯/.test(t)) r.scene = 'cooking';
  else if (/食飯|吃饭|吃飯|晚飯|晚饭|晚餐/.test(t)) r.scene = 'dinner';
  else if (/夜燈|夜灯|細燈|小夜灯/.test(t)) r.scene = 'nightlight';
  else if (/早唞|瞓覺|晚安|睡觉|睡覺/.test(t)) r.scene = 'goodnight';

  r.light = /[燈灯]/.test(t);
  if (!r.light && !r.targets.length && !r.scene && /車房|车库|門|门|風扇|风扇|鏡頭|摄像头|電視|电视|冷氣|空调/.test(t)) { r.kind = 'elsewhere'; return; }
  if (/邊啲|邊盞|開咗未|開住未|係咪開|有冇開|熄咗未|哪些|哪个|开着吗|开了吗|是不是开|有没有开|关了吗|關咗未/.test(t)) { r.kind = 'status'; return; }

  if (/[熄閂關关]/.test(t)) r.on = false;
  else if (/[開开着著]/.test(t)) r.on = true;

  const pct = t.match(/(\d{1,3})(%|％)/) || t.match(new RegExp(`百分之(${CN_NUM_RE})`));
  if (pct) r.level = clampLevel(pct[2] && /%|％/.test(pct[2]) ? +pct[1] : cnNumber(pct[1]));
  else if (/最光|最亮|全光/.test(t)) r.level = 100;
  else if (/光啲|光一[點点]|亮一[點点]|调亮|調亮|亮些/.test(t)) r.relative = 25;
  else if (/暗啲|暗一[點点]|调暗|調暗|暗些/.test(t)) r.relative = -25;
  if (r.on === false) { r.level = null; r.relative = null; }

  r.when = chineseWhen(t, lang);
}

function chineseWhen(t, lang) {
  const n = `(${CN_NUM_RE})`;
  const unit = '(分鐘|分钟|個鐘|个钟|小時|小时|鐘頭|钟头)';
  const minutes = (num, u) => cnNumber(num) * (/鐘$|钟$|時|时|頭|头/.test(u) && !/分/.test(u) ? 60 : 1);
  let m;
  if (/半個鐘(之?後|後)|半小时(以?后)|过半小时|過半個鐘/.test(t)) return { type: 'in', minutes: 30 };
  if ((m = t.match(new RegExp(`${n}${unit}(?:之後|之后|以後|以后|後|后)`))) || (m = t.match(new RegExp(`[過过]${n}${unit}`)))) {
    return { type: 'in', minutes: minutes(m[1], m[2]) };
  }
  if (/半個鐘|半小时/.test(t)) return { type: 'for', minutes: 30 };
  if ((m = t.match(new RegExp(`${n}${unit}`)))) return { type: 'for', minutes: minutes(m[1], m[2]) };

  const part = '(朝早|朝頭早|早上|上晝|上午|中午|晏晝|下晝|下午|夜晚|今晚|晚上|夜里|夜)?';
  m = t.match(new RegExp(`${part}${n}[點点](半|${n}(?:分|個字)?)?`));
  // 光一點, 亮一点: "a bit", not one o'clock.
  if (m && !(m[2] === '一' && /[光亮暗大小高低多少啲]$/.test(t.slice(0, m.index + (m[1] || '').length)))) {
    const h = cnNumber(m[2]);
    let mm = 0;
    if (m[3] === '半') mm = 30;
    else if (m[4]) mm = cnNumber(m[4]) * (m[3].endsWith('個字') ? 5 : 1);
    let period = null;
    if (/朝早|朝頭早|早上|上晝|上午/.test(m[1] || '')) period = 'am';
    else if (/中午/.test(m[1] || '')) period = h === 12 || h < 4 ? 'pm' : 'am';
    else if (m[1]) period = 'pm';
    if (h > 12) period = null;
    if (!Number.isNaN(h)) return { type: 'at', h, m: mm, period };
  }
  return null;
}

function clampLevel(n) { return Math.max(1, Math.min(100, Math.round(n))); }

/* ── Replies ───────────────────────────────────────────────── */

export const NAMES = {
  en:  { ceiling: 'the ceiling lights', counter: 'the under-cabinet lights', pendants: 'the island pendants', all: 'the kitchen lights' },
  vi:  { ceiling: 'đèn trần', counter: 'đèn dưới tủ', pendants: 'đèn thả', all: 'đèn bếp' },
  yue: { ceiling: '天花燈', counter: '櫃底燈', pendants: '吊燈', all: '廚房燈' },
  zh:  { ceiling: '顶灯', counter: '橱柜灯', pendants: '吊灯', all: '厨房灯' },
};

export const SCENE_NAMES = {
  en:  { cooking: 'Cooking', dinner: 'Dinner', nightlight: 'Night light', goodnight: 'Goodnight' },
  vi:  { cooking: 'Nấu ăn', dinner: 'Ăn tối', nightlight: 'Đèn ngủ', goodnight: 'Chúc ngủ ngon' },
  yue: { cooking: '煮飯', dinner: '食飯', nightlight: '夜燈', goodnight: '早唞' },
  zh:  { cooking: '做饭', dinner: '吃饭', nightlight: '夜灯', goodnight: '晚安' },
};

function names(lang, targets) {
  const n = NAMES[lang];
  if (!targets.length || targets.length === LIGHT_IDS.length) return n.all;
  const list = targets.map((id) => n[id]);
  if (lang === 'en') return list.length === 2 ? `${list[0]} and ${list[1]}` : list.join(', ');
  if (lang === 'vi') return list.join(' và ');
  return list.join(lang === 'yue' ? '同' : '和');
}

export function duration(lang, minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  if (lang === 'en') {
    const parts = [];
    if (h) parts.push(`${h} hour${h > 1 ? 's' : ''}`);
    if (m || !h) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
    return parts.join(' ');
  }
  if (lang === 'vi') return [h && `${h} tiếng`, (m || !h) && `${m} phút`].filter(Boolean).join(' ');
  if (lang === 'yue') return h ? `${h}個鐘${m ? `${m}分鐘` : ''}` : `${m}分鐘`;
  return h ? `${h}小时${m ? `${m}分钟` : ''}` : `${m}分钟`;
}

/** A time of day, as each language says it: 7:30 pm, 7 giờ 30 tối, 夜晚7點半, 晚上7点半. */
export function clock(lang, minuteOfDay) {
  const total = ((Math.round(minuteOfDay) % 1440) + 1440) % 1440;
  const h24 = Math.floor(total / 60), m = total % 60;
  const h12 = h24 % 12 || 12;
  if (lang === 'en') return `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'am' : 'pm'}`;
  if (lang === 'vi') {
    const part = h24 < 4 || h24 >= 22 ? 'đêm' : h24 < 11 ? 'sáng' : h24 < 13 ? 'trưa' : h24 < 18 ? 'chiều' : 'tối';
    return `${h12} giờ${m ? ` ${m === 30 ? 'rưỡi' : m}` : ''} ${part}`;
  }
  const yue = lang === 'yue';
  const part = h24 < 5 ? (yue ? '凌晨' : '凌晨') : h24 < 12 ? (yue ? '朝早' : '早上') : h24 < 13 ? '中午' : h24 < 18 ? (yue ? '下晝' : '下午') : (yue ? '夜晚' : '晚上');
  const pt = yue ? '點' : '点';
  return `${part}${h12}${pt}${m ? (m === 30 ? '半' : `${m}分`) : ''}`;
}

/**
 * What HomeHub says back. `d` comes from the demo's planner:
 *   { kind: 'done'|'later'|'scene'|'status'|'ask'|'help'|'elsewhere'|'unknown',
 *     verb: 'on'|'off'|'level', targets, level, scene, when: {type, minutes, atMinute}, lit: [{id, level|null}] }
 */
export function replyText(lang, d) {
  const T = TEXT[lang];
  switch (d.kind) {
    case 'help': case 'elsewhere': case 'unknown': case 'ask': return T[d.kind];
    case 'status': return d.lit.length ? T.statusOn(d.lit.map((l) => NAMES[lang][l.id] + (l.level != null && l.level < 100 ? `${lang === 'en' || lang === 'vi' ? ' ' : ''}${lang === 'en' ? 'at ' : ''}${l.level}%` : ''))) : T.statusOff;
    case 'scene': return T.scene(SCENE_NAMES[lang][d.scene]);
    case 'done': {
      const n = names(lang, d.targets);
      if (d.when?.type === 'for') return T.doneFor(d.verb, n, d.level, duration(lang, d.when.minutes));
      return T.done(d.verb, n, d.level);
    }
    case 'later': {
      const what = d.scene ? T.vpScene(SCENE_NAMES[lang][d.scene]) : T.vp(d.verb, names(lang, d.targets), d.level);
      return d.when.type === 'in' ? T.laterIn(what, duration(lang, d.when.minutes)) : T.laterAt(what, clock(lang, d.when.atMinute));
    }
    default: return T.unknown;
  }
}

const TEXT = {
  en: {
    done: (v, n, l) => (v === 'off' ? `Turned off ${n}.` : v === 'level' ? `Set ${n} to ${l}%.` : `Turned on ${n}.`),
    doneFor: (v, n, l, dur) => (v === 'off' ? `Turned off ${n} for ${dur}.` : v === 'level' ? `Set ${n} to ${l}% for ${dur}.` : `Turned on ${n} for ${dur}.`),
    vp: (v, n, l) => (v === 'off' ? `turn off ${n}` : v === 'level' ? `set ${n} to ${l}%` : `turn on ${n}`),
    vpScene: (s) => `run ${s}`,
    laterIn: (what, dur) => `OK. I'll ${what} in ${dur}.`,
    laterAt: (what, time) => `OK. I'll ${what} at ${time}.`,
    scene: (s) => `Ran ${s}.`,
    statusOn: (list) => `On now: ${list.join(', ')}.`,
    statusOff: 'All the kitchen lights are off.',
    ask: 'On or off?',
    help: 'Try “turn on the kitchen lights”, “dim the pendants to 30%”, “ceiling lights on for 10 minutes” or “dinner at 7 pm”. Cantonese, Mandarin and Vietnamese work too.',
    elsewhere: 'This demo has just the kitchen. Try the ceiling lights, the under-cabinet lights or the island pendants.',
    unknown: 'Sorry, I didn’t understand that. Try “turn on the kitchen lights”.',
  },
  vi: {
    done: (v, n, l) => (v === 'off' ? `Đã tắt ${n}.` : v === 'level' ? `Đã chỉnh ${n} ${l}%.` : `Đã bật ${n}.`),
    doneFor: (v, n, l, dur) => (v === 'off' ? `Đã tắt ${n} trong ${dur}.` : v === 'level' ? `Đã chỉnh ${n} ${l}% trong ${dur}.` : `Đã bật ${n} trong ${dur}.`),
    vp: (v, n, l) => (v === 'off' ? `tắt ${n}` : v === 'level' ? `chỉnh ${n} ${l}%` : `bật ${n}`),
    vpScene: (s) => `chạy cảnh ${s}`,
    laterIn: (what, dur) => `Được, ${dur} nữa tôi sẽ ${what}.`,
    laterAt: (what, time) => `Được, tôi sẽ ${what} lúc ${time}.`,
    scene: (s) => `Đã chạy cảnh ${s}.`,
    statusOn: (list) => `Đang bật: ${list.join(', ')}.`,
    statusOff: 'Đèn bếp đang tắt hết.',
    ask: 'Bật hay tắt?',
    help: 'Thử nói: “bật đèn bếp”, “tắt đèn trần”, “bật đèn thả 10 phút”, “ăn tối lúc 7 giờ tối”.',
    elsewhere: 'Bản demo này chỉ có nhà bếp. Thử với đèn trần, đèn dưới tủ hoặc đèn thả.',
    unknown: 'Xin lỗi, tôi chưa hiểu. Thử nói “bật đèn bếp”.',
  },
  yue: {
    done: (v, n, l) => (v === 'off' ? `熄咗${n}。` : v === 'level' ? `${n}調到${l}%。` : `開咗${n}。`),
    doneFor: (v, n, l, dur) => (v === 'off' ? `熄咗${n}，${dur}之後再開。` : v === 'level' ? `${n}調到${l}%，${dur}之後還原。` : `開咗${n}，${dur}之後熄。`),
    vp: (v, n, l) => (v === 'off' ? `熄${n}` : v === 'level' ? `將${n}調到${l}%` : `開${n}`),
    vpScene: (s) => `開「${s}」`,
    laterIn: (what, dur) => `好，${dur}之後${what}。`,
    laterAt: (what, time) => `好，${time}${what}。`,
    scene: (s) => `搞掂，開咗「${s}」。`,
    statusOn: (list) => `而家開住：${list.join('、')}。`,
    statusOff: '廚房燈全部熄咗。',
    ask: '開定熄？',
    help: '試吓講：「開廚房燈」、「熄天花燈」、「開吊燈十分鐘」、「夜晚七點食飯」。',
    elsewhere: '呢個示範得廚房。試吓天花燈、櫃底燈或者吊燈。',
    unknown: '唔好意思，我聽唔明。試吓講「開廚房燈」。',
  },
  zh: {
    done: (v, n, l) => (v === 'off' ? `已关掉${n}。` : v === 'level' ? `${n}已调到${l}%。` : `已打开${n}。`),
    doneFor: (v, n, l, dur) => (v === 'off' ? `已关掉${n}，${dur}后再打开。` : v === 'level' ? `${n}已调到${l}%，${dur}后恢复。` : `已打开${n}，${dur}后关掉。`),
    vp: (v, n, l) => (v === 'off' ? `关掉${n}` : v === 'level' ? `把${n}调到${l}%` : `打开${n}`),
    vpScene: (s) => `启动「${s}」`,
    laterIn: (what, dur) => `好的，${dur}后${what}。`,
    laterAt: (what, time) => `好的，${time}${what}。`,
    scene: (s) => `好的，已启动「${s}」。`,
    statusOn: (list) => `现在开着：${list.join('、')}。`,
    statusOff: '厨房灯都关着。',
    ask: '开还是关？',
    help: '试试说：“打开厨房灯”“关掉顶灯”“打开吊灯十分钟”“晚上七点吃饭”。',
    elsewhere: '这个演示只有厨房。试试顶灯、橱柜灯或吊灯。',
    unknown: '抱歉，我没听懂。试试说“打开厨房灯”。',
  },
};
