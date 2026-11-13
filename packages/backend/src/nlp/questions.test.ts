/**
 * The time, the date and the weather, answered without a model, against a temp
 * DB and a fake Open-Meteo. Modules load in before(), after DB_PATH is set.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-questions-test-'));

let db: Database.Database;
let q: typeof import('./questions');
let weather: typeof import('../home/weather');

const FORECAST = {
  current: { temperature_2m: 61.6, apparent_temperature: 60.2, weather_code: 2 },
  daily: {
    time: ['2026-11-13', '2026-11-14'],
    temperature_2m_max: [67.8, 59.1],
    temperature_2m_min: [50.6, 47.9],
    precipitation_probability_max: [10, 70],
    weather_code: [2, 63],
  },
};

function fakeFetch(body: unknown = FORECAST, status = 200) {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, urls };
}

const setHome = (lat: number | null, lon: number | null, tz = 'America/Los_Angeles') => {
  db.prepare("DELETE FROM settings WHERE key LIKE 'home_%'").run();
  const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  if (lat !== null && lon !== null) { put.run('home_latitude', String(lat)); put.run('home_longitude', String(lon)); }
  put.run('home_timezone', tz);
};

describe('time, date and weather questions', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    delete process.env.LATITUDE; delete process.env.LONGITUDE; delete process.env.TEMPERATURE_UNIT;
    db = (await import('../db')).getDb();
    q = await import('./questions');
    weather = await import('../home/weather');
  });

  after(() => {
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    weather.clearWeatherCache();
    setHome(47.60621, -122.33207);
  });

  const at = new Date('2026-11-13T23:45:00Z');   // 3:45 PM in Seattle

  it('tells the time in the home time zone', async () => {
    for (const text of ['What time is it?', "what's the time", 'Do you know what time it is?', 'time', 'What time is it right now?', 'Hey HomeHub, what time is it']) {
      const a = await q.answerQuestion(text, { now: at });
      assert.equal(a?.response, "It's 3:45 PM.", text);
      assert.deepEqual((a?.actions[0].result as any), { asked: 'time', hour: 15, minute: 45, weekday: 5, day: 13, month: 11, year: 2026, timezone: 'America/Los_Angeles' });
    }
  });

  it('tells the date', async () => {
    for (const text of ["What's the date?", "what's today's date", 'What day is it today?', 'what day of the week is it']) {
      assert.equal((await q.answerQuestion(text, { now: at }))?.response, "It's Friday, November 13.", text);
    }
  });

  it('leaves commands and other questions alone', async () => {
    for (const text of ['turn on the kitchen light', 'is the kitchen light on', 'set a timer for the lamp', 'is the rain sensor on', 'time the porch light', 'hello']) {
      assert.equal(await q.answerQuestion(text, { now: at, fetchImpl: fakeFetch().impl }), null, text);
    }
  });

  it('reads which weather question it is', () => {
    const cases: Array<[string, string]> = [
      ["What's the weather?", 'today'], ['How is the weather today', 'today'], ["what's the temperature", 'today'],
      ['How cold is it outside?', 'today'], ["What's the forecast for tomorrow?", 'tomorrow'],
      ['Will it rain today?', 'rain-today'], ['Is it going to rain tomorrow', 'rain-tomorrow'],
      ['Do I need an umbrella?', 'rain-today'], ["what's the weather like tomorrow", 'tomorrow'],
    ];
    for (const [text, kind] of cases) assert.equal(q.weatherQuestion(text), kind, text);
  });

  it('answers the weather in °F in the United States, from a rounded location', async () => {
    const f = fakeFetch();
    const a = await q.answerQuestion("What's the weather?", { fetchImpl: f.impl });
    assert.equal(a?.response, "Right now it's 62 degrees and partly cloudy. Today's high is 68 and the low is 51.");
    const url = new URL(f.urls[0]);
    assert.equal(url.hostname, 'api.open-meteo.com');
    assert.equal(url.searchParams.get('latitude'), '47.61');
    assert.equal(url.searchParams.get('longitude'), '-122.33');
    assert.equal(url.searchParams.get('temperature_unit'), 'fahrenheit');
    const result = a?.actions[0].result as any;
    assert.equal(result.unit, 'F');
    assert.deepEqual(result.tomorrow, { date: '2026-11-14', high: 59, low: 48, rain: 70, code: 63 });
  });

  it('answers tomorrow and rain, and asks Open-Meteo once in ten minutes', async () => {
    const f = fakeFetch();
    assert.equal((await q.answerQuestion('Weather tomorrow?', { fetchImpl: f.impl }))?.response,
      "Tomorrow: rain, with a high of 59 and a low of 48 degrees. There's a 70% chance of rain.");
    assert.equal((await q.answerQuestion('Will it rain tomorrow?', { fetchImpl: f.impl }))?.response, 'Yes, rain is likely tomorrow: a 70% chance.');
    assert.equal((await q.answerQuestion('Will it rain today?', { fetchImpl: f.impl }))?.response, "Rain isn't likely today: a 10% chance.");
    assert.equal(f.urls.length, 1);
  });

  it('uses °C outside the United States', async () => {
    setHome(10.82302, 106.62965, 'Asia/Ho_Chi_Minh');
    const f = fakeFetch();
    await q.answerQuestion('weather', { fetchImpl: f.impl });
    assert.equal(new URL(f.urls[0]).searchParams.get('temperature_unit'), 'celsius');
  });

  it('says what is wrong when the home has no location or Open-Meteo is down', async () => {
    setHome(null, null);
    const f = fakeFetch();
    const a = await q.answerQuestion("What's the weather?", { fetchImpl: f.impl });
    assert.match(a!.response, /Settings → Home/);
    assert.equal((a!.actions[0].result as any).code, 'NOT_LOCATED');
    assert.equal(f.urls.length, 0);

    setHome(47.6, -122.3);
    const down = await q.answerQuestion("What's the weather?", { fetchImpl: fakeFetch({}, 503).impl });
    assert.equal(down?.response, "I can't get the weather right now.");
    assert.equal((down!.actions[0].result as any).code, 'UNREACHABLE');
  });
});
