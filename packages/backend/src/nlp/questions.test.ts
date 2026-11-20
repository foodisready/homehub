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
let nq: typeof import('./native-questions');
let home: typeof import('../home/home-settings');

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
  db.prepare("DELETE FROM settings WHERE key LIKE 'home_%' OR key = 'temperature_unit'").run();
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
    nq = await import('./native-questions');
    home = await import('../home/home-settings');
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

  describe('what to wear', () => {
    it('is only answered when asked', () => {
      const cases: Array<[string, string]> = [
        ['What should I wear?', 'wear-today'], ['what should i wear today', 'wear-today'], ['What should I wear tomorrow?', 'wear-tomorrow'],
        ['Do I need a jacket?', 'wear-today'], ["Should I wear a coat tomorrow?", 'wear-tomorrow'], ['How should I dress today?', 'wear-today'],
        ['What to wear', 'wear-today'], ['Hey HomeHub, what do I wear tomorrow', 'wear-tomorrow'], ['Is it jacket weather?', 'wear-today'],
        // Weather questions without clothes stay as they were.
        ["What's the weather?", 'today'], ['Do I need an umbrella?', 'rain-today'], ["What's the forecast for tomorrow?", 'tomorrow'],
      ];
      for (const [text, kind] of cases) assert.equal(q.weatherQuestion(text), kind, text);
      assert.equal(q.weatherQuestion('turn on the closet light'), null);
    });

    it('picks clothes by the feels-like temperature, in °F', () => {
      const cases: Array<[number, string]> = [[10, 'heavy'], [25, 'heavy'], [26, 'warm'], [39, 'warm'], [40, 'jacket'], [54, 'jacket'],
        [55, 'light'], [64, 'light'], [65, 'tshirt'], [79, 'tshirt'], [80, 'hot'], [95, 'hot']];
      for (const [f, warmth] of cases) assert.equal(q.warmthFor(f), warmth, String(f));
    });

    it('says what to wear today and tomorrow, with an umbrella when rain is likely', async () => {
      const f = fakeFetch();
      assert.equal((await q.answerQuestion('What should I wear?', { fetchImpl: f.impl }))?.response,
        'It feels like 60°F now, with a high of 68°F today. A sweater or a light jacket is enough.');
      const a = await q.answerQuestion('What should I wear tomorrow?', { fetchImpl: f.impl });
      // Tomorrow is dressed for the cool part of the day: 48 + (59 − 48) / 3 ≈ 52°F.
      assert.equal(a?.response, "Tomorrow: a low of 48°F and a high of 59°F. Wear a jacket. Take an umbrella: there's a 70% chance of rain.");
      assert.deepEqual((a?.actions[0].result as any).wear,
        { when: 'tomorrow', feels: 52, high: 59, low: 48, warmth: 'jacket', warmsTo: null, umbrella: 70, raining: false, snow: false });
      assert.equal(((await q.answerQuestion("What's the weather?", { fetchImpl: f.impl }))?.actions[0].result as any).wear, undefined);
    });

    it('uses the unit chosen in Settings, with the same advice', async () => {
      home.saveHomeSettings({ temperatureUnit: 'C' });
      try {
        const cold = {
          current: { temperature_2m: 1, apparent_temperature: -4, weather_code: 3 },
          daily: { time: ['2026-11-13', '2026-11-14'], temperature_2m_max: [9, 3], temperature_2m_min: [-1, -6],
            precipitation_probability_max: [50, 80], weather_code: [61, 73] },
        };
        const f = fakeFetch(cold);
        // −4 °C feels like 25 °F: the heaviest coat. Up 8 °C later: layers.
        assert.equal((await q.answerQuestion('What should I wear?', { fetchImpl: f.impl }))?.response,
          'It feels like −4°C now, with a high of 9°C today. Wear a heavy winter coat, a hat, gloves and a scarf. '
          + "It warms up to 9°C later, so dress in layers. Take an umbrella: there's a 50% chance of rain.");
        // Snow tomorrow: boots, not an umbrella.
        assert.equal((await q.answerQuestion('What should I wear tomorrow?', { fetchImpl: f.impl }))?.response,
          'Tomorrow: a low of −6°C and a high of 3°C. Wear a warm coat, a hat and gloves. '
          + 'It warms up to 3°C in the afternoon, so dress in layers. Wear boots: snow is expected.');
      } finally { home.saveHomeSettings({ temperatureUnit: 'auto' }); }
    });

    it('says when it is raining now', async () => {
      const f = fakeFetch({ ...FORECAST, current: { temperature_2m: 84, apparent_temperature: 88, weather_code: 63 } });
      assert.equal((await q.answerQuestion('Do I need a jacket?', { fetchImpl: f.impl }))?.response,
        "It feels like 88°F now, with a high of 68°F today. Wear light, loose clothes and drink plenty of water. Take an umbrella: it's raining now.");
    });
  });

  it('answers the weather in °F in the United States, from a rounded location', async () => {
    const f = fakeFetch();
    const a = await q.answerQuestion("What's the weather?", { fetchImpl: f.impl });
    assert.equal(a?.response, "Right now it's 62°F and partly cloudy. Today's high is 68°F and the low is 51°F.");
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
      "Tomorrow: rain, with a high of 59°F and a low of 48°F. There's a 70% chance of rain.");
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

  describe('the unit', () => {
    it('follows the time zone until one is chosen, then .env, then Settings', async () => {
      assert.deepEqual([home.getHomeSettings().temperatureUnit, home.getHomeSettings().source.temperatureUnit], ['F', 'default']);
      process.env.TEMPERATURE_UNIT = 'c';
      try {
        assert.deepEqual([home.getHomeSettings().temperatureUnit, home.getHomeSettings().source.temperatureUnit], ['C', 'env']);
        home.saveHomeSettings({ temperatureUnit: 'F' });
        assert.deepEqual([home.getHomeSettings().temperatureUnit, home.getHomeSettings().source.temperatureUnit], ['F', 'settings']);
        home.saveHomeSettings({ temperatureUnit: 'auto' });
        assert.equal(home.getHomeSettings().source.temperatureUnit, 'env');
      } finally { delete process.env.TEMPERATURE_UNIT; }
      assert.throws(() => home.saveHomeSettings({ temperatureUnit: 'K' }), /C or F/);
    });

    it('asks Open-Meteo in the chosen unit, and writes it', async () => {
      home.saveHomeSettings({ temperatureUnit: 'C' });
      const f = fakeFetch({ ...FORECAST, current: { temperature_2m: -2.4, apparent_temperature: -8, weather_code: 71 } });
      const a = await q.answerQuestion("what's the temperature", { fetchImpl: f.impl });
      assert.equal(new URL(f.urls[0]).searchParams.get('temperature_unit'), 'celsius');
      assert.equal(a?.response, "Right now it's −2°C, feeling like −8°C, and light snow. Today's high is 68°C and the low is 51°C.");
    });

    it('is said as degrees by a speaker', () => {
      assert.equal(q.spokenDegrees("Right now it's −2°C, feeling like 28°F. High 57°F."), "Right now it's minus 2 degrees, feeling like 28 degrees. High 57 degrees.");
    });
  });

  describe('typed in Cantonese, Mandarin or Vietnamese', () => {
    it('reads which question, and in which language', () => {
      const cases: Array<[string, string, string]> = [
        ['幾點', 'yue', 'time'], ['而家幾點呀？', 'yue', 'time'], ['现在几点', 'zh', 'time'], ['几点了', 'zh', 'time'],
        ['今日幾號', 'yue', 'date'], ['今天星期几', 'zh', 'date'], ['今日禮拜幾', 'yue', 'date'],
        ['今日天氣點', 'yue', 'today'], ['今日天氣點？', 'yue', 'today'], ['今天天气怎么样', 'zh', 'today'], ['外面幾度', 'yue', 'today'],
        ['熱唔熱', 'yue', 'today'], ['而家幾多度', 'yue', 'today'], ['聽日幾多度', 'yue', 'tomorrow'], ['现在多少度', 'zh', 'today'], ['聽日天氣點', 'yue', 'tomorrow'], ['明天天气', 'zh', 'tomorrow'],
        ['聽日會唔會落雨', 'yue', 'rain-tomorrow'], ['今日會唔會落雨', 'yue', 'rain-today'], ['明天会下雨吗', 'zh', 'rain-tomorrow'],
        ['Mấy giờ rồi?', 'vi', 'time'], ['may gio roi', 'vi', 'time'], ['Hôm nay thứ mấy?', 'vi', 'date'],
        ['Thời tiết hôm nay thế nào?', 'vi', 'today'], ['thoi tiet ngay mai', 'vi', 'tomorrow'], ['Ngày mai có mưa không?', 'vi', 'rain-tomorrow'],
        ['Hôm nay có mưa không', 'vi', 'rain-today'],
        ['今日著咩衫', 'yue', 'wear-today'], ['聽日要著咩衫', 'yue', 'wear-tomorrow'], ['使唔使著外套', 'yue', 'wear-today'],
        ['要唔要著褸', 'yue', 'wear-today'], ['着乜嘢衫好', 'yue', 'wear-today'], ['今天穿什么', 'zh', 'wear-today'],
        ['明天要不要穿外套', 'zh', 'wear-tomorrow'], ['Hôm nay mặc gì?', 'vi', 'wear-today'],
        ['Ngày mai có cần áo khoác không', 'vi', 'wear-tomorrow'], ['我應該着啲咩', 'yue', 'wear-today'],
        ['聽日應該著啲乜', 'yue', 'wear-tomorrow'], ['氣溫係幾多', 'yue', 'today'],
      ];
      for (const [text, lang, asked] of cases) assert.deepEqual(nq.nativeQuestion(text), { lang, asked }, text);
    });

    it('leaves commands, English and other things alone', () => {
      for (const text of ['開樓上燈', '開廳燈', '关厨房灯', 'bật đèn bếp', 'tắt đèn', 'mua sữa', 'what time is it', '你好', 'xin chào', '']) {
        assert.equal(nq.nativeQuestion(text), null, text);
      }
    });

    it('tells the time and the date in the language asked', async () => {
      const ask = async (text: string) => (await nq.answerNativeQuestion(text, { now: at }))?.response;
      assert.equal(await ask('幾點'), '而家係下晝3點45分。');
      assert.equal(await ask('现在几点'), '现在是下午3点45分。');
      assert.equal(await ask('Mấy giờ rồi?'), 'Bây giờ là 3 giờ 45 phút chiều.');
      assert.equal(await ask('今日幾號'), '今日係11月13號，星期五。');
      assert.equal(await ask('今天几号'), '今天是11月13号，星期五。');
      assert.equal(await ask('Hôm nay ngày mấy'), 'Hôm nay là thứ sáu, ngày 13 tháng 11.');
      const half = new Date('2026-11-13T17:30:00Z');   // 9:30 AM
      assert.equal((await nq.answerNativeQuestion('幾點', { now: half }))?.response, '而家係朝早9點半。');
      const a = await nq.answerNativeQuestion('幾點', { now: at });
      assert.equal(a?.actions[0].tool, 'get_time');
    });

    it('gives the real weather with its unit, never a made-up one', async () => {
      const f = fakeFetch();
      const ask = async (text: string) => (await nq.answerNativeQuestion(text, { fetchImpl: f.impl }))?.response;
      assert.equal(await ask('今日天氣點'), '而家62°F，間中有雲。今日最高68°F，最低51°F。');
      assert.equal(await ask('今天天气怎么样'), '现在62°F，局部多云。今天最高68°F，最低51°F。');
      assert.equal(await ask('Thời tiết hôm nay thế nào?'), 'Bây giờ trời 62°F, có mây rải rác. Hôm nay cao nhất 68°F, thấp nhất 51°F.');
      assert.equal(await ask('聽日天氣點'), '聽日有雨，最高59°F，最低48°F。落雨機會70%。');
      assert.equal(await ask('聽日會唔會落雨'), '會，聽日好大機會落雨，機會70%。');
      assert.equal(await ask('明天会下雨吗'), '会，明天很可能下雨，概率70%。');
      assert.equal(await ask('Hôm nay có mưa không'), 'Hôm nay ít khả năng mưa, 10%.');
      const a = await nq.answerNativeQuestion('今日天氣點', { fetchImpl: f.impl });
      assert.equal(a?.actions[0].tool, 'get_weather');
    });

    it('says what to wear in the language asked', async () => {
      const f = fakeFetch();
      const ask = async (text: string) => (await nq.answerNativeQuestion(text, { fetchImpl: f.impl }))?.response;
      assert.equal(await ask('今日著咩衫'), '而家體感60°F，今日最高68°F。著件冷衫或者薄外套就夠。');
      assert.equal(await ask('聽日著咩衫'), '聽日最低48°F，最高59°F。著件外套。記得帶遮，落雨機會70%。');
      assert.equal(await ask('明天穿什么'), '明天最低48°F，最高59°F。穿件外套。记得带伞，下雨概率70%。');
      assert.equal(await ask('Hôm nay mặc gì?'), 'Bây giờ cảm giác như 60°F, hôm nay cao nhất 68°F. Áo len hoặc áo khoác mỏng là đủ.');
      assert.equal(await ask('Ngày mai mặc gì'), 'Ngày mai thấp nhất 48°F, cao nhất 59°F. Mặc áo khoác. Nhớ mang ô, khả năng mưa 70%.');
    });

    it('says what is wrong in the language asked', async () => {
      setHome(null, null);
      assert.match((await nq.answerNativeQuestion('今日天氣點', { fetchImpl: fakeFetch().impl }))!.response, /未知你屋企喺邊/);
      setHome(47.6, -122.3);
      assert.equal((await nq.answerNativeQuestion('Thời tiết hôm nay', { fetchImpl: fakeFetch({}, 503).impl }))?.response,
        'Hiện không lấy được thông tin thời tiết.');
    });
  });
});
