/**
 * The time, the date and the weather, typed in Chat in Cantonese, Mandarin or Vietnamese:
 * "幾點", "今日天氣點", "聽日會唔會落雨", "现在几点", "Mấy giờ rồi?", "Thời tiết hôm nay thế nào?".
 *
 * Answered by HomeHub's own rules from the clock and Open-Meteo, in the language typed, the way the
 * voice bridge already answers them spoken (voice-bridge/homehub_voice/questions.py). Without this,
 * the chat model answered them, and a small one makes the weather up.
 */
import { describeWeather, type DayForecast, type Weather } from '../home/weather';
import { answerClock, answerWeather, degrees, type WeatherAsked } from './questions';
import { fold, hasChinese, MANDARIN, parseChinese, parseVietnamese } from './native-commands';
import type { ActionTaken } from './nlp.service';

type Handled = { response: string; actions: ActionTaken[] };
export type QuestionLang = 'yue' | 'zh' | 'vi';
export type Asked = 'time' | 'date' | WeatherAsked;

// ── Which question ──────────────────────────────────────────────

const ZH_TIME = /幾點|几点|幾多點|几多点|咩時間|乜嘢時間|什麼時間|什么时间|甚麼時間/;
const ZH_DATE = /幾號|几号|星期幾|星期几|禮拜幾|礼拜几|幾月幾|几月几|咩日子|什麼日子|什么日子|日期/;
const ZH_WEATHER = /天氣|天气|幾度|几度|溫度|温度|氣溫|气温|熱唔熱|凍唔凍|冷唔冷|熱不熱|热不热|冷不冷|幾熱|几热|幾凍|幾冷|几冷|落雪|下雪/;
const ZH_RAIN = /落雨|下雨|帶遮|帶傘|带伞/;
const ZH_TOMORROW = /聽日|听日|明天|明日/;
// Written only in Mandarin, or in simplified characters, beyond those the commands know.
const ZH_ONLY = /[几现吗说钟温号礼听带伞]|今天|明天|下雨|什么|甚麼/;

const VI_TIME = ['may gio'];
const VI_DATE = ['thu may', 'ngay may', 'ngay bao nhieu', 'mung may', 'hom nay la ngay'];
const VI_WEATHER = ['thoi tiet', 'nhiet do', 'bao nhieu do', 'may do', 'nong khong', 'lanh khong', 'troi nong', 'troi lanh'];
const VI_TOMORROW = ['ngay mai'];

function kindOf(time: boolean, date: boolean, weather: boolean, rain: boolean, tomorrow: boolean): Asked | null {
  // "聽日幾點落雨" asks about rain, not the clock: the weather first.
  if (rain && !weather) return tomorrow ? 'rain-tomorrow' : 'rain-today';
  if (weather || rain) return tomorrow ? 'tomorrow' : 'today';
  if (time) return 'time';
  if (date) return 'date';
  return null;
}

/** The question and its language, or null. A command ("開廳燈", "bật đèn") is never one. */
export function nativeQuestion(text: string): { lang: QuestionLang; asked: Asked } | null {
  if (hasChinese(text)) {
    if (parseChinese(text)) return null;
    const asked = kindOf(ZH_TIME.test(text), ZH_DATE.test(text), ZH_WEATHER.test(text), ZH_RAIN.test(text), ZH_TOMORROW.test(text));
    return asked ? { lang: MANDARIN.test(text) || ZH_ONLY.test(text) ? 'zh' : 'yue', asked } : null;
  }
  if (parseVietnamese(text)) return null;
  const p = ` ${fold(text).replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const has = (phrases: string[]) => phrases.some((x) => p.includes(` ${x} `));
  // "mưa" (rain) only with its accent: "mua" is "buy".
  const rain = /(?:^|[^\p{L}])mưa(?:$|[^\p{L}])/u.test(text.toLowerCase());
  const asked = kindOf(has(VI_TIME), has(VI_DATE), has(VI_WEATHER), rain, has(VI_TOMORROW));
  return asked ? { lang: 'vi', asked } : null;
}

// ── Saying it ───────────────────────────────────────────────────

const CONDITIONS: Record<QuestionLang, Record<string, string>> = {
  yue: {
    'clear': '天晴', 'mostly clear': '大致天晴', 'partly cloudy': '間中有雲', 'cloudy': '多雲', 'foggy': '有霧',
    'drizzly': '有毛毛雨', 'light rain': '有微雨', 'rain': '有雨', 'heavy rain': '有大雨', 'freezing rain': '有凍雨',
    'light snow': '有小雪', 'snow': '落雪', 'thunderstorms': '有雷暴', 'mixed': '天氣多變',
  },
  zh: {
    'clear': '晴天', 'mostly clear': '大致晴朗', 'partly cloudy': '局部多云', 'cloudy': '多云', 'foggy': '有雾',
    'drizzly': '有毛毛雨', 'light rain': '有小雨', 'rain': '有雨', 'heavy rain': '有大雨', 'freezing rain': '有冻雨',
    'light snow': '有小雪', 'snow': '下雪', 'thunderstorms': '有雷暴', 'mixed': '天气多变',
  },
  vi: {
    'clear': 'trời quang', 'mostly clear': 'trời khá quang', 'partly cloudy': 'có mây rải rác', 'cloudy': 'nhiều mây',
    'foggy': 'có sương mù', 'drizzly': 'có mưa phùn', 'light rain': 'có mưa nhẹ', 'rain': 'có mưa', 'heavy rain': 'mưa to',
    'freezing rain': 'mưa băng', 'light snow': 'có tuyết nhẹ', 'snow': 'có tuyết', 'thunderstorms': 'có giông', 'mixed': 'thời tiết thay đổi',
  },
};
const WEEKDAYS_ZH = '日一二三四五六';
const WEEKDAYS_VI = ['Chủ nhật', 'thứ hai', 'thứ ba', 'thứ tư', 'thứ năm', 'thứ sáu', 'thứ bảy'];
const raining = (code: number) => (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;

function clockText(lang: QuestionLang, hour: number, minute: number): string {
  const h = hour % 12 || 12;
  if (lang === 'vi') {
    const period = hour === 0 || hour >= 22 ? 'đêm' : hour < 11 ? 'sáng' : hour < 13 ? 'trưa' : hour < 18 ? 'chiều' : 'tối';
    return `Bây giờ là ${h} giờ${minute ? ` ${minute} phút` : ''} ${period}.`;
  }
  const yue = lang === 'yue';
  const period = hour < 6 ? '凌晨' : hour < 12 ? (yue ? '朝早' : '早上') : hour < 13 ? '中午' : hour < 18 ? (yue ? '下晝' : '下午') : (yue ? '夜晚' : '晚上');
  const dian = yue ? '點' : '点';
  const mins = !minute ? (yue ? '正' : '整') : minute === 30 ? '半' : `${String(minute).padStart(2, '0')}分`;
  return `${yue ? '而家係' : '现在是'}${period}${h}${dian}${mins}。`;
}

function dateText(lang: QuestionLang, c: { weekday: number; day: number; month: number }): string {
  if (lang === 'vi') return `Hôm nay là ${WEEKDAYS_VI[c.weekday]}, ngày ${c.day} tháng ${c.month}.`;
  return lang === 'yue'
    ? `今日係${c.month}月${c.day}號，星期${WEEKDAYS_ZH[c.weekday]}。`
    : `今天是${c.month}月${c.day}号，星期${WEEKDAYS_ZH[c.weekday]}。`;
}

function rainText(lang: QuestionLang, day: DayForecast, tomorrow: boolean): string {
  const n = `${day.rain}%`;
  if (lang === 'vi') {
    const when = tomorrow ? 'ngày mai' : 'hôm nay';
    if (day.rain >= 60) return `Có, ${when} nhiều khả năng mưa, ${n}.`;
    if (day.rain >= 30) return `Có thể, ${when} khả năng mưa ${n}.`;
    return `${when[0].toUpperCase()}${when.slice(1)} ít khả năng mưa, ${n}.`;
  }
  if (lang === 'yue') {
    const when = tomorrow ? '聽日' : '今日';
    if (day.rain >= 60) return `會，${when}好大機會落雨，機會${n}。`;
    if (day.rain >= 30) return `可能會，${when}落雨機會${n}。`;
    return `${when}唔多會落雨，機會${n}。`;
  }
  const when = tomorrow ? '明天' : '今天';
  if (day.rain >= 60) return `会，${when}很可能下雨，概率${n}。`;
  if (day.rain >= 30) return `可能会，${when}下雨的概率是${n}。`;
  return `${when}不太会下雨，概率${n}。`;
}

/** The weather in the language asked, with the home's unit written: 35°F, 2°C. */
export function weatherText(lang: QuestionLang, w: Weather, asked: WeatherAsked): string {
  const deg = (n: number) => degrees(n, w.unit);
  const cond = (code: number) => CONDITIONS[lang][describeWeather(code)] ?? CONDITIONS[lang]['mixed'];
  if (asked === 'rain-today' && raining(w.now.code)) {
    return { yue: '係，而家落緊雨。', zh: '是的，现在正在下雨。', vi: 'Có, trời đang mưa.' }[lang];
  }
  if (asked === 'rain-today' || asked === 'rain-tomorrow') return rainText(lang, asked === 'rain-today' ? w.today : w.tomorrow, asked === 'rain-tomorrow');

  const day = asked === 'tomorrow' ? w.tomorrow : w.today;
  const chance = day.rain >= 30
    ? { yue: `落雨機會${day.rain}%。`, zh: `下雨概率${day.rain}%。`, vi: ` Khả năng mưa ${day.rain}%.` }[lang]
    : '';
  if (lang === 'vi') {
    return asked === 'tomorrow'
      ? `Ngày mai ${cond(day.code)}, cao nhất ${deg(day.high)}, thấp nhất ${deg(day.low)}.${chance}`
      : `Bây giờ trời ${deg(w.now.temperature)}, ${cond(w.now.code)}. Hôm nay cao nhất ${deg(day.high)}, thấp nhất ${deg(day.low)}.${chance}`;
  }
  if (lang === 'yue') {
    return asked === 'tomorrow'
      ? `聽日${cond(day.code)}，最高${deg(day.high)}，最低${deg(day.low)}。${chance}`
      : `而家${deg(w.now.temperature)}，${cond(w.now.code)}。今日最高${deg(day.high)}，最低${deg(day.low)}。${chance}`;
  }
  return asked === 'tomorrow'
    ? `明天${cond(day.code)}，最高${deg(day.high)}，最低${deg(day.low)}。${chance}`
    : `现在${deg(w.now.temperature)}，${cond(w.now.code)}。今天最高${deg(day.high)}，最低${deg(day.low)}。${chance}`;
}

const NOT_LOCATED = {
  yue: 'HomeHub未知你屋企喺邊，請喺設定 → Home度揀位置。',
  zh: 'HomeHub还不知道你家在哪里，请在设置 → Home里选择位置。',
  vi: 'HomeHub chưa biết nhà bạn ở đâu. Hãy đặt vị trí trong Cài đặt → Home.',
};
const UNREACHABLE = { yue: '而家攞唔到天氣資料。', zh: '现在获取不到天气信息。', vi: 'Hiện không lấy được thông tin thời tiết.' };

/** The answer in the language typed, or null when the text isn't one of these questions. */
export async function answerNativeQuestion(text: string, opts: { now?: Date; fetchImpl?: typeof fetch } = {}): Promise<Handled | null> {
  const q = nativeQuestion(text);
  if (!q) return null;
  if (q.asked === 'time' || q.asked === 'date') {
    const done = answerClock(q.asked, opts.now ?? new Date());
    const c = done.actions[0].result as { hour: number; minute: number; weekday: number; day: number; month: number };
    return { ...done, response: q.asked === 'time' ? clockText(q.lang, c.hour, c.minute) : dateText(q.lang, c) };
  }
  const done = await answerWeather(q.asked, false, opts.fetchImpl);
  const r = done.actions[0].result as Weather & { error?: string; code?: string };
  const response = r.error ? (r.code === 'NOT_LOCATED' ? NOT_LOCATED : UNREACHABLE)[q.lang] : weatherText(q.lang, r, q.asked);
  return { ...done, response };
}
