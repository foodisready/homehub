/**
 * Questions the rules don't read, with the household's Claude key: Claude Haiku says what was asked
 * (the time, the date, the weather, rain or what to wear), for which day and which city, and HomeHub
 * answers from the clock and Open-Meteo as it does for the rules. The model never answers itself, so it
 * can't make the weather up.
 *
 * It also reads a weather question the rules did catch, since the rules can't tell a city
 * ("紐約嘅氣溫係幾多" is New York, not home) or a follow-up ("我應該着啲咩" after asking about New York).
 *
 * Without a key, or when Claude can't be reached, the rules answer as before. This HomeHub's own model
 * isn't used: on the question test set (homehub-business/evals/questions.json) qwen2.5:1.5b took 499 of
 * 632 commands and stray talk for questions; Haiku took 1.
 */
import { findPlace, WeatherError, type Place, type Weather } from '../home/weather';
import { logger } from '../logger';
import { claudeErrorText, claudeInUse, CLAUDE_MODEL, recordClaudeFailure, recordClaudeUse } from './ai-choice';
import type { Lang } from './confirm';
import type { ActionTaken } from './nlp.service';
import { answerNativeQuestion, clockText, dateText, nativeQuestion, NOT_LOCATED, questionLang, UNREACHABLE, weatherText } from './native-questions';
import { answerClock, answerQuestion, answerWeather, englishQuestion, weatherReply, type WeatherAsked } from './questions';

type Handled = { response: string; actions: ActionTaken[] };

export type ReadAsk = 'none' | 'time' | 'date' | 'weather' | 'rain' | 'wear';
export interface Reading {
  ask:       ReadAsk;
  day:       'today' | 'tomorrow' | 'other';
  /** The city in English, or null for home. */
  place:     string | null;
  /** The city as it was said ("紐約", "Hà Nội"), to say it back in that language. */
  placeSaid: string | null;
}

export const QUESTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    ask:        { type: 'string', enum: ['none', 'time', 'date', 'weather', 'rain', 'wear'] },
    day:        { type: 'string', enum: ['today', 'tomorrow', 'other'] },
    place:      { type: ['string', 'null'] },
    place_said: { type: ['string', 'null'] },
  },
  required: ['ask', 'day', 'place', 'place_said'],
} as const;

export const QUESTION_PROMPT = `You read what someone said to a smart-home speaker and fill in a form. They may speak English, Cantonese, Mandarin or Vietnamese. Speech recognition makes mistakes, and a lot of what reaches you is background talk, TV or a half-sentence that was never meant for the speaker.

ask, what they want to know:
- "time": the current time.
- "date": today's date or day of the week.
- "weather": the weather outside: temperature, hot or cold, how it is out.
- "rain": whether it will rain, or whether to take an umbrella.
- "wear": what to wear, or whether they need a coat or jacket.
- "none": anything else. Commands (turn on, switch off, open, set the thermostat), questions about the temperature inside the house or a room, questions about anything other than the above, greetings, thanks, chatter, and anything unclear are all "none". When unsure, say "none".

day, for weather, rain and wear: "today" (also "now"), "tomorrow", or "other" for any other day. Use "today" when no day is said.

place: the city they ask about, written in English (New York, Hong Kong, Hanoi, Ho Chi Minh City, Beijing...), or null for here at home. This is for the time as well as the weather: "what time is it in Tokyo?" is Tokyo. Null unless these words name a city, or are a fragment that only carries on the question before (see below).
place_said: that city's proper name in the language they are speaking and its script, or null. For Cantonese or Mandarin that is always Chinese characters, even when the city was said in English letters: "new york" → 紐約, "London" → 倫敦, "Ho Chi Minh City" → 胡志明市. Speech recognition can mix scripts or mishear a name ("New约", "Hà Lội"): write the proper name instead (紐約, Hà Nội).

The conversation so far may come first. Most questions stand on their own: a question with its own verb that names no city is about here at home, place null, even straight after a question about a city. After "紐約嘅氣溫係幾多" (New York), "我應該着啲咩", "聽日會唔會落雨", "听日会，唔会落雨", "do I need an umbrella" and "what should I wear" are all about home: place null.
Only a fragment carries the earlier city or question on: after "the weather in New York?", "and tomorrow?" (聽日呢, 明天呢, ngày mai thì sao) asks the same thing about New York for tomorrow, and "what about Hong Kong?" (咁香港呢) asks it about Hong Kong.`;

/** What the model is given: the words, after the questions asked just before them. */
export function questionInput(text: string, before: string[] = []): string {
  if (!before.length) return text;
  return 'Earlier in this conversation they asked:\n' + before.map((b) => `- ${b}`).join('\n') + `\n\nNow they say: ${text}`;
}

const ASKS: ReadAsk[] = ['none', 'time', 'date', 'weather', 'rain', 'wear'];
const DAYS = ['today', 'tomorrow', 'other'] as const;
const str = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim().slice(0, 80) : null);

/** The model's form, checked again: anything outside it is no reading. */
export function parseReading(raw: string): Reading | null {
  let v: Record<string, unknown>;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || !ASKS.includes(v.ask as ReadAsk)) return null;
  return {
    ask: v.ask as ReadAsk,
    day: DAYS.includes(v.day as typeof DAYS[number]) ? v.day as Reading['day'] : 'today',
    place: str(v.place),
    placeSaid: str(v.place_said),
  };
}

export interface ReadResult { reading: Reading | null; ms: number; inputTokens?: number; outputTokens?: number; error?: string; status?: number }

/** Asks Claude Haiku to fill in the form. */
export async function readQuestion(text: string, before: string[], opts: { apiKey: string; timeoutMs: number; model?: string }): Promise<ReadResult> {
  const t0 = Date.now();
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs, maxRetries: 1 });
  try {
    // One deadline for the whole read, its retry included: someone is waiting at a speaker.
    const res = await client.messages.create({
      model: opts.model ?? CLAUDE_MODEL,
      max_tokens: 1024,
      system: QUESTION_PROMPT,
      messages: [{ role: 'user', content: questionInput(text, before) }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: QUESTION_SCHEMA as unknown as Record<string, unknown> } },
    }, { signal: AbortSignal.timeout(opts.timeoutMs) });
    const usage = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
    if (res.stop_reason === 'refusal') return { reading: null, ms: Date.now() - t0, error: 'refused', ...usage };
    const raw = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return { reading: parseReading(raw), ms: Date.now() - t0, ...usage };
  } catch (err) {
    const status = err instanceof Anthropic.APIError ? err.status : undefined;
    return { reading: null, ms: Date.now() - t0, error: (err as Error).message, ...(status !== undefined ? { status } : {}) };
  }
}

// ── The questions just asked, for follow-ups ───────────────────────

/** How long a question is remembered for a follow-up: someone at a speaker asks the next one straight away. */
export const FOLLOW_UP_MS = { voice: 2 * 60_000, chat: 5 * 60_000 };
const recent = new Map<string, { text: string; at: number; tongue: string }[]>();

/**
 * A follow-up carries on only from questions in its own language: in a home that speaks several, a question
 * in another language is most likely someone else's. Cantonese and Mandarin count as one, since speech
 * recognition often labels one as the other.
 */
const tongue = (lang: Lang) => (lang === 'yue' || lang === 'zh' ? 'zh' : lang);

export function rememberQuestion(who: string, text: string, lang: Lang, now = Date.now()): void {
  const list = [...(recent.get(who) ?? []), { text: text.trim().slice(0, 200), at: now, tongue: tongue(lang) }].slice(-3);
  recent.set(who, list);
  if (recent.size > 100) recent.delete(recent.keys().next().value!);
}

export function recentQuestions(who: string, lang: Lang, windowMs: number, now = Date.now()): string[] {
  return (recent.get(who) ?? []).filter((q) => now - q.at <= windowMs && q.tongue === tongue(lang)).map((q) => q.text);
}

/** For tests. */
export function forgetQuestions(): void { recent.clear(); }

// ── Answering what was read ────────────────────────────────────────

type AnswerLang = Lang;

const WEATHER_ASKS = new Set<ReadAsk>(['weather', 'rain', 'wear']);
export const isWeatherAsk = (a: ReadAsk) => WEATHER_ASKS.has(a);

function weatherAsked(r: Reading): WeatherAsked {
  const tomorrow = r.day === 'tomorrow';
  if (r.ask === 'rain') return tomorrow ? 'rain-tomorrow' : 'rain-today';
  if (r.ask === 'wear') return tomorrow ? 'wear-tomorrow' : 'wear-today';
  return tomorrow ? 'tomorrow' : 'today';
}

const OTHER_DAY: Record<AnswerLang, string> = {
  en: 'I only have the forecast for today and tomorrow.',
  yue: '我只有今日同聽日嘅天氣預報。',
  zh: '我只有今天和明天的天气预报。',
  vi: 'Tôi chỉ có dự báo thời tiết hôm nay và ngày mai.',
};
const NO_PLACE: Record<AnswerLang, (p: string) => string> = {
  en: (p) => `I couldn't find a place called ${p}.`,
  yue: (p) => `搵唔到「${p}」呢個地方。`,
  zh: (p) => `找不到“${p}”这个地方。`,
  vi: (p) => `Không tìm thấy nơi nào tên ${p}.`,
};
const UNREACHABLE_EN = "I can't get the weather right now.";

const CHINESE = /[一-鿿]/;
/** The city's name to say: as it was said when that's in the answer's language, else as Open-Meteo names it. */
function placeName(r: Reading, place: Place, lang: AnswerLang): string {
  const said = r.placeSaid;
  if (lang === 'en' || !said) return place.name;
  // A name mixing scripts ("New约") is a mishearing, not a name a Chinese voice can say.
  if (lang === 'yue' || lang === 'zh') return CHINESE.test(said) && !/[A-Za-z]/.test(said) ? said : place.name;
  return CHINESE.test(said) ? place.name : said;
}
const withPlace = (name: string, text: string, lang: AnswerLang) => `${name}${lang === 'yue' || lang === 'zh' ? '：' : ': '}${text}`;

/** The answer to what was read, in `lang`, from the clock or Open-Meteo. */
export async function answerReading(r: Reading, lang: AnswerLang, opts: { now?: Date; fetchImpl?: typeof fetch } = {}): Promise<Handled> {
  if (r.ask === 'none') throw new Error('Nothing was asked');
  if (isWeatherAsk(r.ask) && r.day === 'other') return { response: OTHER_DAY[lang], actions: [] };

  let place: Place | null = null;
  if (r.place) {
    try {
      place = await findPlace(r.place, { fetchImpl: opts.fetchImpl });
    } catch {
      return { response: lang === 'en' ? UNREACHABLE_EN : UNREACHABLE[lang], actions: [] };
    }
    if (!place) return { response: NO_PLACE[lang](r.placeSaid ?? r.place), actions: [] };
  }
  const name = place ? placeName(r, place, lang) : null;
  const named = (done: Handled, response: string): Handled => {
    if (place) Object.assign(done.actions[0].result as object, { place: { name: place.name, said: name } });
    return { ...done, response };
  };

  if (r.ask === 'time' || r.ask === 'date') {
    const done = answerClock(r.ask, opts.now ?? new Date(), place?.timezone);
    const c = done.actions[0].result as { hour: number; minute: number; weekday: number; day: number; month: number };
    if (lang === 'en') {
      return named(done, name ? `In ${name}, ${done.response.charAt(0).toLowerCase()}${done.response.slice(1)}` : done.response);
    }
    const text = r.ask === 'time' ? clockText(lang, c.hour, c.minute) : dateText(lang, c);
    return named(done, name ? withPlace(name, text, lang) : text);
  }

  const asked = weatherAsked(r);
  const done = await answerWeather(asked, false, opts.fetchImpl, place ?? undefined);
  const w = done.actions[0].result as Weather & { error?: string; code?: string };
  if (w.error) {
    const response = lang === 'en' ? done.response : (w.code === 'NOT_LOCATED' ? NOT_LOCATED : UNREACHABLE)[lang];
    return { ...done, response };
  }
  const text = lang === 'en' ? weatherReply(w, asked) : weatherText(lang, w, asked);
  return named(done, name ? withPlace(name, text, lang) : text);
}

// ── With the household's key ───────────────────────────────────────

/** Reads `text` with Claude, counting what it costs. Null without a key, or when Claude couldn't answer. */
async function readWithClaude(text: string, who: string, lang: Lang, windowMs: number, timeoutMs: number): Promise<Reading | null> {
  const key = claudeInUse();
  if (!key) return null;
  const r = await readQuestion(text, recentQuestions(who, lang, windowMs), { apiKey: key, timeoutMs });
  if (r.inputTokens) recordClaudeUse(r.inputTokens, r.outputTokens ?? 0);
  if (r.error) {
    logger.warn({ err: r.error }, 'Claude did not read the question');
    recordClaudeFailure(r.error === 'refused' ? 'Claude declined to answer one message.' : claudeErrorText(r.status, r.error));
    return null;
  }
  logger.info({ ms: r.ms, read: r.reading }, 'Question read');
  return r.reading;
}

export interface AskedOpts {
  /** Who is asking, so a follow-up carries on from their last question: 'voice', or Chat's user. */
  who:       string;
  /** The language to answer in; from the words when not given. */
  lang?:     AnswerLang | null;
  /** What was said, when `text` is the bridge's English for it ("what's the weather today" for 紐約天氣點). */
  heard?:    string | null;
  timeoutMs: number;
  windowMs:  number;
  /** False keeps Claude out: a voice bridge too old to say HomeHub's own words. */
  read?:     boolean;
  now?:      Date;
  fetchImpl?: typeof fetch;
}

/** An answer, and whether it's in words to say as they are (`said`), rather than the rules' English. */
export type Answered = Handled & { said?: { lang: AnswerLang } };

/**
 * A question the rules know. A weather question is also read by Claude, at the same time as the
 * forecast is fetched, so a city or a follow-up is answered for that city. Null when it isn't one.
 */
export async function answerAsked(text: string, opts: AskedOpts): Promise<Answered | null> {
  const asked = englishQuestion(text) ?? nativeQuestion(text)?.asked ?? null;
  if (!asked) return null;
  const rules = async () => await answerQuestion(text, opts) ?? await answerNativeQuestion(text, opts);
  const weather = asked !== 'time' && asked !== 'date';
  const spoken = opts.heard?.trim() || text;
  const lang = opts.lang ?? questionLang(spoken);
  if (!weather || opts.read === false || !claudeInUse()) {
    const h = await rules();
    if (h) rememberQuestion(opts.who, spoken, lang);
    return h;
  }
  const [h, reading] = await Promise.all([rules(), readWithClaude(spoken, opts.who, lang, opts.windowMs, opts.timeoutMs)]);
  rememberQuestion(opts.who, spoken, lang);
  // Claude found what the rules can't: a city, or a day or kind from the question before.
  if (reading && isWeatherAsk(reading.ask) && (reading.place || weatherAsked(reading) !== asked)) {
    return { ...await answerReading(reading, lang, opts), said: { lang } };
  }
  return h;
}

/** A question the rules missed, read by Claude. Null without a key, or when it isn't one of these questions. */
export async function answerMissed(text: string, opts: AskedOpts): Promise<Answered | null> {
  const lang = opts.lang ?? questionLang(text);
  const reading = await readWithClaude(text, opts.who, lang, opts.windowMs, opts.timeoutMs);
  if (!reading || reading.ask === 'none') return null;
  rememberQuestion(opts.who, text, lang);
  return { ...await answerReading(reading, lang, opts), said: { lang } };
}
