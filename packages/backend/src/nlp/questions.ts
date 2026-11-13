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

function answerClock(asked: 'time' | 'date', at: Date): Handled {
  const { timezone } = getHomeSettings();
  const clock = homeClock(at, timezone);
  const response = asked === 'time'
    ? `It's ${at.toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' })}.`
    : `It's ${at.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric' })}.`;
  return { response, actions: [{ tool: 'get_time', args: { asked }, result: { asked, ...clock } }] };
}

export type WeatherAsked = 'today' | 'tomorrow' | 'rain-today' | 'rain-tomorrow';

/** Which weather question this is, or null when it isn't one. */
export function weatherQuestion(text: string): WeatherAsked | null {
  const said = cleanUp(text).replace(/[’]/g, "'").replace(/\?+$/, '').trim();
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

export function weatherReply(w: Weather, asked: WeatherAsked, snow = false): string {
  const word = snow ? 'snow' : 'rain';
  if (asked === 'rain-today') {
    if (!snow && NOW_RAINING(w.now.code)) return "Yes, it's raining now.";
    if (snow && NOW_SNOWING(w.now.code)) return "Yes, it's snowing now.";
    return chance(w.today, word, 'today');
  }
  if (asked === 'rain-tomorrow') return chance(w.tomorrow, word, 'tomorrow');
  if (asked === 'tomorrow') {
    const t = w.tomorrow;
    const rain = t.rain >= 30 ? ` There's a ${t.rain}% chance of rain.` : '';
    return `Tomorrow: ${describeWeather(t.code)}, with a high of ${t.high} and a low of ${t.low} degrees.${rain}`;
  }
  const t = w.today;
  const feels = Math.abs(w.now.feelsLike - w.now.temperature) >= 5 ? `, feeling like ${w.now.feelsLike},` : '';
  const rain = t.rain >= 30 ? ` There's a ${t.rain}% chance of rain.` : '';
  return `Right now it's ${w.now.temperature} degrees${feels} and ${describeWeather(w.now.code)}. Today's high is ${t.high} and the low is ${t.low}.${rain}`;
}

async function answerWeather(asked: WeatherAsked, snow: boolean, fetchImpl?: typeof fetch): Promise<Handled> {
  try {
    const w = await getWeather({ fetchImpl });
    return {
      response: weatherReply(w, asked, snow),
      actions: [{ tool: 'get_weather', args: { asked }, result: { asked, snow, ...w } }],
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
