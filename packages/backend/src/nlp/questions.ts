/**
 * "What time is it?", "what's the date?" and "what's the weather?", answered by
 * HomeHub's own rules: the clock needs no model, and the weather comes from
 * Open-Meteo (see home/weather.ts). Each answer also carries its numbers in
 * `actions`, so the voice bridge can say them in Vietnamese or Cantonese.
 */
import { getHomeSettings } from '../home/home-settings';
import { describeWeather, getWeather, WeatherError, type DayForecast, type Weather } from '../home/weather';
import { cleanUp } from './commands';
import type { ActionTaken } from './nlp.service';

type Handled = { response: string; actions: ActionTaken[] };

const NOW = String.raw`(?:\s+(?:now|right\s+now|at\s+the\s+moment|here))?`;
// "What time is it?", "what's the time?", "do you know what time it is?", "time?"
const TIME = new RegExp(String.raw`^(?:(?:so|ok|okay|hey)\s+)?(?:what\s+time\s+is\s+it|what(?:'?s|\s+is)\s+the\s+(?:current\s+)?time|(?:do\s+you\s+know|tell\s+me|say)\s+what\s+time\s+it\s+is|tell\s+me\s+the\s+time|(?:the\s+|current\s+)?time)${NOW}$`);
// "What's the date?", "what's today's date?", "what day is it?", "what day of the week is it?"
const DATE = new RegExp(String.raw`^(?:what(?:'?s|\s+is)\s+(?:the\s+date|today'?s\s+date|the\s+date\s+today)|what\s+(?:day|date)(?:\s+of\s+the\s+(?:week|month))?\s+is\s+(?:it|today)(?:\s+today)?|today'?s\s+date|(?:the\s+)?date)$`);

const WEATHER_WORDS = /\b(?:weather|forecast|temperature|temp|degrees|how\s+(?:hot|cold|warm|chilly)|(?:hot|cold|warm|chilly|nice)\s+(?:outside|out)|rain(?:ing|y)?|snow(?:ing|y)?|umbrella)\b/;
const QUESTION_START = /^(?:what|whats|how|hows|is|isnt|will|would|does|do|should|tell|give|any|the|weather|forecast|temperature|today|tomorrow|tonight|current|outside|it)\b/;
// Commands, and questions about devices, aren't weather questions.
const NOT_WEATHER = /\b(?:turn|switch|schedule|set|timer|lights?|lamps?|plugs?|sensor|camera)\b/;
const PRECIPITATION = /\b(?:rain(?:ing|y)?|snow(?:ing|y)?|umbrella|wet)\b/;
const OVERVIEW = /\b(?:weather|forecast|temperature|temp|degrees|hot|cold|warm|chilly)\b/;

const NOW_RAINING = (code: number) => (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;
const NOW_SNOWING = (code: number) => (code >= 71 && code <= 77) || code === 85 || code === 86;

/** The clock in the home's time zone. */
export function homeClock(at = new Date(), timezone = getHomeSettings().timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', weekday: 'short',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(parts.weekday));
  return {
    hour: Number(parts.hour) % 24, minute: Number(parts.minute),
    weekday, day: Number(parts.day), month: Number(parts.month), year: Number(parts.year), timezone,
  };
}

export function answerClock(asked: 'time' | 'date', at: Date): Handled {
  const { timezone } = getHomeSettings();
  const clock = homeClock(at, timezone);
  const response = asked === 'time'
    ? `It's ${at.toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' })}.`
    : `It's ${at.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric' })}.`;
  return { response, actions: [{ tool: 'get_time', args: { asked }, result: { asked, ...clock } }] };
}

export type WeatherAsked = 'today' | 'tomorrow' | 'rain-today' | 'rain-tomorrow' | 'wear-today' | 'wear-tomorrow';

// "What should I wear?", "do I need a jacket?", "how should I dress tomorrow?"
const WEAR = new RegExp(String.raw`\b(?:what\s+(?:should|do|shall|can|could|would)\s+(?:i|we|you)\s+wear|what\s+(?:to|i\s+should|we\s+should)\s+wear|how\s+(?:should|do)\s+(?:i|we)\s+dress|dress\s+(?:for|warm(?:ly)?)\b|(?:do|should|will|would)\s+(?:i|we)\s+(?:need|want|wear|bring|take)\s+(?:a\s+|an\s+|my\s+|some\s+)?(?:jacket|coat|sweater|jumper|hoodie|gloves|hat|scarf|boots|layers|shorts|sweatshirt|parka)|(?:jacket|coat|sweater|shorts)\s+weather)\b`);

/** Which weather question this is, or null when it isn't one. */
export function weatherQuestion(text: string): WeatherAsked | null {
  const said = cleanUp(text).replace(/[’]/g, "'").replace(/\?+$/, '').trim();
  if (WEAR.test(said.replace(/'/g, ''))) return /\btomorrow\b/.test(said) ? 'wear-tomorrow' : 'wear-today';
  if (!WEATHER_WORDS.test(said) || !QUESTION_START.test(said.replace(/'/g, '')) || NOT_WEATHER.test(said)) return null;
  const tomorrow = /\btomorrow\b/.test(said);
  const rain = PRECIPITATION.test(said) && !OVERVIEW.test(said);
  return rain ? (tomorrow ? 'rain-tomorrow' : 'rain-today') : (tomorrow ? 'tomorrow' : 'today');
}

function chance(day: DayForecast, word: string, when: string): string {
  if (day.rain >= 60) return `Yes, ${word} is likely ${when}: a ${day.rain}% chance.`;
  if (day.rain >= 30) return `Maybe: there's a ${day.rain}% chance of ${word} ${when}.`;
  return `${word[0].toUpperCase()}${word.slice(1)} isn't likely ${when}: a ${day.rain}% chance.`;
}

/** 35°F, −2°C: as written in Chat. */
export const degrees = (n: number, unit: 'F' | 'C') => `${n < 0 ? '−' : ''}${Math.abs(n)}°${unit}`;

/** For a speaker: "35°F" read aloud as "35 degrees", as before the unit was written. */
export const spokenDegrees = (text: string) => text.replace(/(−?)(\d+)°[FC]/g, (_m, minus: string, n: string) => `${minus ? 'minus ' : ''}${n} degrees`);

export type Warmth = 'heavy' | 'warm' | 'jacket' | 'light' | 'tshirt' | 'hot';

/** What to wear, worked out from the forecast: the voice bridge says it in Cantonese, Mandarin or Vietnamese. */
export interface Wear {
  when: 'today' | 'tomorrow';
  /** The temperature dressed for, in the home's unit: feels-like now for today, the cool part of the day for tomorrow. */
  feels: number;
  high: number;
  low: number;
  warmth: Warmth;
  /** The warmer temperature later on, when it climbs enough that layers help; else null. */
  warmsTo: number | null;
  /** Take an umbrella: the chance of rain (100 while it's raining now), or null. */
  umbrella: number | null;
  raining: boolean;
  /** Snow is expected: boots. */
  snow: boolean;
}

const toF = (n: number, unit: 'F' | 'C') => (unit === 'C' ? n * 9 / 5 + 32 : n);
const SNOW_CODE = (code: number) => (code >= 71 && code <= 77) || code === 85 || code === 86;

/** The clothes for a temperature in °F (feels-like): a coat below 40, a jacket below 55, a T-shirt from 65. */
export function warmthFor(f: number): Warmth {
  if (f <= 25) return 'heavy';
  if (f < 40) return 'warm';
  if (f < 55) return 'jacket';
  if (f < 65) return 'light';
  if (f < 80) return 'tshirt';
  return 'hot';
}

/**
 * What to wear today or tomorrow. The thresholds are in °F and the home's unit is converted, so °C homes
 * get the same advice. Tomorrow is dressed for the cool part of the day, a third of the way from the low to
 * the high, since people dress in the morning; a climb of 15 °F (8 °C) or more adds layers.
 */
export function clothing(w: Weather, when: 'today' | 'tomorrow'): Wear {
  const day = when === 'today' ? w.today : w.tomorrow;
  const swing = w.unit === 'C' ? 8 : 15;
  const feels = when === 'today' ? w.now.feelsLike : Math.round(day.low + (day.high - day.low) / 3);
  const from = when === 'today' ? w.now.temperature : day.low;
  const raining = when === 'today' && NOW_RAINING(w.now.code) && !NOW_SNOWING(w.now.code);
  const snow = SNOW_CODE(day.code) || (when === 'today' && NOW_SNOWING(w.now.code));
  return {
    when, feels, high: day.high, low: day.low,
    warmth: warmthFor(toF(feels, w.unit)),
    warmsTo: day.high - from >= swing ? day.high : null,
    umbrella: raining ? 100 : !snow && day.rain >= 40 ? day.rain : null,
    raining,
    snow,
  };
}

const WEAR_EN: Record<Warmth, string> = {
  heavy: 'Wear a heavy winter coat, a hat, gloves and a scarf.',
  warm: 'Wear a warm coat, a hat and gloves.',
  jacket: 'Wear a jacket.',
  light: 'A sweater or a light jacket is enough.',
  tshirt: 'A T-shirt is fine.',
  hot: 'Wear light, loose clothes and drink plenty of water.',
};

export function wearReply(wear: Wear, unit: 'F' | 'C'): string {
  const deg = (n: number) => degrees(n, unit);
  const head = wear.when === 'today'
    ? `It feels like ${deg(wear.feels)} now, with a high of ${deg(wear.high)} today.`
    : `Tomorrow: a low of ${deg(wear.low)} and a high of ${deg(wear.high)}.`;
  const layers = wear.warmsTo === null ? ''
    : ` It warms up to ${deg(wear.warmsTo)} ${wear.when === 'today' ? 'later' : 'in the afternoon'}, so dress in layers.`;
  const umbrella = wear.umbrella === null ? ''
    : wear.raining ? " Take an umbrella: it's raining now." : ` Take an umbrella: there's a ${wear.umbrella}% chance of rain.`;
  const boots = wear.snow ? ' Wear boots: snow is expected.' : '';
  return `${head} ${WEAR_EN[wear.warmth]}${layers}${umbrella}${boots}`;
}

export function weatherReply(w: Weather, asked: WeatherAsked, snow = false): string {
  if (asked === 'wear-today' || asked === 'wear-tomorrow') return wearReply(clothing(w, asked === 'wear-today' ? 'today' : 'tomorrow'), w.unit);
  const word = snow ? 'snow' : 'rain';
  if (asked === 'rain-today') {
    if (!snow && NOW_RAINING(w.now.code)) return "Yes, it's raining now.";
    if (snow && NOW_SNOWING(w.now.code)) return "Yes, it's snowing now.";
    return chance(w.today, word, 'today');
  }
  if (asked === 'rain-tomorrow') return chance(w.tomorrow, word, 'tomorrow');
  const deg = (n: number) => degrees(n, w.unit);
  if (asked === 'tomorrow') {
    const t = w.tomorrow;
    const rain = t.rain >= 30 ? ` There's a ${t.rain}% chance of rain.` : '';
    return `Tomorrow: ${describeWeather(t.code)}, with a high of ${deg(t.high)} and a low of ${deg(t.low)}.${rain}`;
  }
  const t = w.today;
  const feels = Math.abs(w.now.feelsLike - w.now.temperature) >= 5 ? `, feeling like ${deg(w.now.feelsLike)},` : '';
  const rain = t.rain >= 30 ? ` There's a ${t.rain}% chance of rain.` : '';
  return `Right now it's ${deg(w.now.temperature)}${feels} and ${describeWeather(w.now.code)}. Today's high is ${deg(t.high)} and the low is ${deg(t.low)}.${rain}`;
}

const wearOf = (w: Weather, asked: WeatherAsked) =>
  asked === 'wear-today' || asked === 'wear-tomorrow' ? { wear: clothing(w, asked === 'wear-today' ? 'today' : 'tomorrow') } : {};

export async function answerWeather(asked: WeatherAsked, snow: boolean, fetchImpl?: typeof fetch): Promise<Handled> {
  try {
    const w = await getWeather({ fetchImpl });
    return {
      response: weatherReply(w, asked, snow),
      actions: [{ tool: 'get_weather', args: { asked }, result: { asked, snow, ...w, ...wearOf(w, asked) } }],
    };
  } catch (err) {
    const message = err instanceof WeatherError ? err.message : "I can't get the weather right now.";
    const code = err instanceof WeatherError ? err.code : 'UNREACHABLE';
    return { response: message, actions: [{ tool: 'get_weather', args: { asked }, result: { asked, error: message, code } }] };
  }
}

/** The answer, or null when the text isn't a question about the time, the date or the weather. */
export async function answerQuestion(text: string, opts: { now?: Date; fetchImpl?: typeof fetch } = {}): Promise<Handled | null> {
  const said = cleanUp(text).replace(/[’]/g, "'").replace(/\?+$/, '').trim();
  if (TIME.test(said)) return answerClock('time', opts.now ?? new Date());
  if (DATE.test(said)) return answerClock('date', opts.now ?? new Date());
  const asked = weatherQuestion(said);
  if (asked) return answerWeather(asked, /\bsnow/.test(said), opts.fetchImpl);
  return null;
}
