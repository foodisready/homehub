/**
 * Questions Claude reads (question-reader.ts): a city, a follow-up, a question the rules missed, in Chat
 * and by voice. Against a temp DB, a fake Anthropic API and a fake Open-Meteo, so nothing leaves the machine.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-question-reader-test-'));
const KEY = 'sk-ant-api03-' + 'q'.repeat(40);
const INTERNAL = 'test-internal-key';

let db: Database.Database;
let qr: typeof import('./question-reader');
let nlp: typeof import('./nlp.service');
let choice: typeof import('./ai-choice');
let weather: typeof import('../home/weather');
let fake: http.Server;
let appServer: http.Server;
let voice = '';

/** The fake Anthropic API: question forms are answered from `readings` by the words said, last line first. */
const anthropic = { questions: [] as string[], forms: 0, chats: 0, readings: {} as Record<string, unknown>, status: 200 };
const NONE = { ask: 'none', day: 'today', place: null, place_said: null };
const message = (text: string) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
  content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 25 } });

function startFake(): Promise<number> {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      res.setHeader('content-type', 'application/json');
      if (anthropic.status !== 200) {
        res.statusCode = anthropic.status;
        return res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }));
      }
      const schema = json.output_config?.format?.schema;
      if (schema?.properties?.place_said) {
        const said = String(json.messages[0].content);
        anthropic.questions.push(said);
        const words = said.split('Now they say: ').pop()!.trim();
        return res.end(JSON.stringify(message(JSON.stringify(anthropic.readings[words] ?? NONE))));
      }
      if (schema) {
        anthropic.forms++;
        return res.end(JSON.stringify(message(JSON.stringify({ action: 'question', target: null, scene: null, minutes: null, lang: 'en' }))));
      }
      anthropic.chats++;
      return res.end(JSON.stringify(message('Hello from Claude.')));
    });
  });
  return new Promise((ok) => fake.listen(0, '127.0.0.1', () => ok((fake.address() as { port: number }).port)));
}

/** Fake Open-Meteo: New York is cold, home (Seattle) is mild, Hong Kong is warm. */
const meteo = { forecasts: [] as string[], lookups: [] as string[], down: false };
const CITIES: Record<string, unknown> = {
  'new york': { name: 'New York', latitude: 40.71427, longitude: -74.00597, timezone: 'America/New_York' },
  'hong kong': { name: 'Hong Kong', latitude: 22.27832, longitude: 114.17469, timezone: 'Asia/Hong_Kong' },
  'hanoi': { name: 'Hanoi', latitude: 21.0245, longitude: 105.84117, timezone: 'Asia/Bangkok' },
};
const realFetch = globalThis.fetch;
function fakeFetch(input: unknown, init?: unknown): Promise<Response> {
  const url = new URL(String(input));
  const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } }));
  if (url.hostname === 'geocoding-api.open-meteo.com') {
    if (meteo.down) return Promise.reject(new Error('offline'));
    const name = url.searchParams.get('name')!.toLowerCase();
    meteo.lookups.push(name);
    return json(CITIES[name] ? { results: [CITIES[name]] } : {});
  }
  if (url.hostname === 'api.open-meteo.com') {
    if (meteo.down) return Promise.reject(new Error('offline'));
    meteo.forecasts.push(`${url.searchParams.get('latitude')},${url.searchParams.get('longitude')} ${url.searchParams.get('timezone')}`);
    const lat = Number(url.searchParams.get('latitude'));
    const t = lat > 40 && lat < 41 ? 30 : lat < 30 ? 75 : 52;
    return json({
      current: { temperature_2m: t, apparent_temperature: t - 4, weather_code: 3 },
      daily: { time: ['2026-11-20', '2026-11-21'], temperature_2m_max: [t + 6, t + 3], temperature_2m_min: [t - 6, t - 8],
        precipitation_probability_max: [10, 70], weather_code: [3, 61] },
    });
  }
  return realFetch(input as Parameters<typeof fetch>[0], init as RequestInit);
}

const YUE_NY = { ask: 'weather', day: 'today', place: 'New York', place_said: '紐約' };

describe('Questions Claude reads', () => {
  before(async () => {
    const port = await startFake();
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.OLLAMA_URL = 'http://127.0.0.1:1';
    process.env.SCHEDULER_URL = 'http://127.0.0.1:1';
    process.env.INTERNAL_API_KEY = INTERNAL;
    process.env.CHAT_ASK = 'on';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.LATITUDE; delete process.env.LONGITUDE; delete process.env.TEMPERATURE_UNIT;
    globalThis.fetch = fakeFetch as typeof fetch;
    db = (await import('../db')).getDb();
    qr = await import('./question-reader');
    nlp = await import('./nlp.service');
    choice = await import('./ai-choice');
    weather = await import('../home/weather');
    const home = await import('../home/home-settings');
    home.saveHomeSettings({ latitude: 47.60621, longitude: -122.33207, timezone: 'America/Los_Angeles', temperatureUnit: 'F' });
    db.prepare("INSERT INTO devices (alias, ip, room, driver_type) VALUES ('Porch light', '192.0.2.10', 'Front', 'kasa')").run();
    const app = express();
    app.use(express.json());
    app.use('/internal', (await import('../routes/internal')).internalRouter);
    await new Promise<void>((ok) => { appServer = app.listen(0, '127.0.0.1', () => ok()); });
    voice = `http://127.0.0.1:${(appServer.address() as { port: number }).port}/internal/voice`;
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>((ok) => appServer.close(() => ok()));
    await new Promise<void>((ok) => fake.close(() => ok()));
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    anthropic.questions = []; anthropic.forms = 0; anthropic.chats = 0; anthropic.readings = {}; anthropic.status = 200;
    meteo.forecasts = []; meteo.lookups = []; meteo.down = false;
    weather.clearWeatherCache();
    qr.forgetQuestions();
    db.prepare("DELETE FROM settings WHERE key IN ('ai_choice', 'anthropic_api_key', 'ai_usage')").run();
    db.prepare('DELETE FROM chat_commands').run();
    db.prepare('DELETE FROM voice_commands').run();
  });

  const useClaude = () => { choice.setClaudeKey(KEY); choice.setAiMode('claude'); };
  const ask = (text: string, who = 'user:1') => nlp.processMessage(text, [], who);
  const say = async (body: Record<string, unknown>) => {
    const r = await realFetch(`${voice}/command`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL }, body: JSON.stringify(body) });
    return await r.json() as any;
  };

  // ── Reading ───────────────────────────────────────────────────

  it('checks the form again, and gives the questions before a follow-up', () => {
    assert.deepEqual(qr.parseReading(JSON.stringify(YUE_NY)), { ask: 'weather', day: 'today', place: 'New York', placeSaid: '紐約' });
    assert.deepEqual(qr.parseReading('{"ask":"wear","day":"someday","place":"null","place_said":""}'), { ask: 'wear', day: 'today', place: null, placeSaid: null });
    assert.equal(qr.parseReading('{"ask":"turn on"}'), null);
    assert.equal(qr.parseReading('not json'), null);
    assert.equal(qr.questionInput('聽日呢'), '聽日呢');
    assert.equal(qr.questionInput('聽日呢', ['今日天氣點']), 'Earlier in this conversation they asked:\n- 今日天氣點\n\nNow they say: 聽日呢');
  });

  // ── Answering ─────────────────────────────────────────────────

  it("answers for a city, in its own day and the home's unit, naming it as it was said", async () => {
    const r = await qr.answerReading({ ask: 'weather', day: 'today', place: 'New York', placeSaid: '紐約' }, 'yue');
    assert.equal(r.response, '紐約：而家華氏30度，多雲。今日最高華氏36度，最低華氏24度。'.replace(/華氏(\d+)度/g, '$1°F'));
    assert.deepEqual(meteo.forecasts, ['40.71,-74.01 America/New_York']);
    assert.deepEqual((r.actions[0].result as any).place, { name: 'New York', said: '紐約' });
    const en = await qr.answerReading({ ask: 'rain', day: 'tomorrow', place: 'new york', placeSaid: 'new york' }, 'en');
    assert.equal(en.response, "New York: Yes, rain is likely tomorrow: a 70% chance.");
    assert.deepEqual(meteo.lookups, ['new york'], 'a city is looked up once');
    const vi = await qr.answerReading({ ask: 'wear', day: 'today', place: 'Hanoi', placeSaid: 'Hà Nội' }, 'vi');
    assert.match(vi.response, /^Hà Nội: Bây giờ cảm giác như 71°F, hôm nay cao nhất 81°F\. Mặc áo thun là được\.$/);
  });

  it("tells the time in a city, and says what it can't answer", async () => {
    const now = new Date('2026-11-20T13:05:00Z');
    assert.equal((await qr.answerReading({ ask: 'time', day: 'today', place: 'Hong Kong', placeSaid: null }, 'en', { now })).response, 'In Hong Kong, it\'s 9:05 PM.');
    assert.equal((await qr.answerReading({ ask: 'time', day: 'today', place: 'Hong Kong', placeSaid: '香港' }, 'yue', { now })).response, '香港：而家係夜晚9點05分。');
    assert.equal((await qr.answerReading({ ask: 'time', day: 'today', place: null, placeSaid: null }, 'en', { now })).response, "It's 5:05 AM.");
    assert.equal((await qr.answerReading({ ask: 'weather', day: 'other', place: null, placeSaid: null }, 'zh')).response, '我只有今天和明天的天气预报。');
    assert.equal((await qr.answerReading({ ask: 'weather', day: 'today', place: 'Atlantis', placeSaid: '亞特蘭提斯' }, 'yue')).response, '搵唔到「亞特蘭提斯」呢個地方。');
    meteo.down = true;
    assert.equal((await qr.answerReading({ ask: 'weather', day: 'today', place: 'Hong Kong', placeSaid: null }, 'vi')).response, 'Hiện không lấy được thông tin thời tiết.');
  });

  // ── Chat ──────────────────────────────────────────────────────

  it('without a key, the rules answer as before and nothing is sent to Anthropic', async () => {
    const r = await ask('紐約嘅氣溫係幾多');
    assert.match(r.response, /^而家52°F/);
    assert.equal(anthropic.questions.length, 0);
  });

  it('finds the city in a weather question the rules caught, and carries it to a follow-up', async () => {
    useClaude();
    anthropic.readings['紐約嘅氣溫係幾多'] = YUE_NY;
    let r = await ask('紐約嘅氣溫係幾多');
    assert.match(r.response, /^紐約：而家30°F，多雲。/);
    anthropic.readings['我應該着啲咩'] = { ask: 'wear', day: 'today', place: 'New York', place_said: '紐約' };
    r = await ask('我應該着啲咩');
    assert.match(r.response, /^紐約：而家體感26°F/);
    assert.equal(anthropic.questions[1], 'Earlier in this conversation they asked:\n- 紐約嘅氣溫係幾多\n\nNow they say: 我應該着啲咩');
    // Someone else's chat isn't a follow-up of this one, nor a question in another language.
    await ask('我應該着啲咩', 'user:2');
    assert.equal(anthropic.questions[2], '我應該着啲咩');
    await ask('what should I wear');
    assert.equal(anthropic.questions[3], 'what should I wear');
    // Mandarin carries on from Cantonese: speech recognition often takes one for the other.
    await ask('我应该穿什么');
    assert.match(anthropic.questions[4], /^Earlier in this conversation they asked:\n- 紐約嘅氣溫係幾多\n- 我應該着啲咩\n/);
    assert.ok(choice.aiUsage().requests >= 5);
  });

  it("keeps the rules' answer when Claude finds nothing more, or can't answer", async () => {
    useClaude();
    anthropic.readings['今日天氣點'] = { ask: 'weather', day: 'today', place: null, place_said: null };
    assert.match((await ask('今日天氣點')).response, /^而家52°F/);
    anthropic.status = 529;
    assert.match((await ask("what's the weather tomorrow")).response, /^Tomorrow: light rain/);
    assert.match(choice.aiUsage().lastError ?? '', /Anthropic had a problem/);
  });

  it("doesn't ask Claude about the time: the rules answer it at once", async () => {
    useClaude();
    assert.match((await ask('幾點')).response, /^而家係/);
    assert.match((await ask('What time is it?')).response, /^It's /);
    assert.equal(anthropic.questions.length, 0);
  });

  it("answers a question the rules missed, and doesn't list it in Teach HomeHub", async () => {
    useClaude();
    anthropic.readings['ngày mai mình nên mang áo gì'] = { ask: 'wear', day: 'tomorrow', place: null, place_said: null };
    const r = await ask('ngày mai mình nên mang áo gì');
    assert.match(r.response, /^Ngày mai thấp nhất 44°F, cao nhất 55°F\. Mặc áo khoác\./);
    assert.ok(r.response.includes('Nhớ mang ô, khả năng mưa 70%.'));
    const row = db.prepare('SELECT handled_by, resolved FROM chat_commands').get() as any;
    assert.deepEqual({ ...row }, { handled_by: 'model', resolved: 1 });
  });

  it('leaves anything else to the chat model, listed as missed', async () => {
    useClaude();
    const r = await ask('Mai bận gì không?');
    assert.equal(r.response, 'Hello from Claude.');
    assert.equal(anthropic.questions.length, 1);
    assert.deepEqual({ ...db.prepare('SELECT resolved FROM chat_commands').get() as any }, { resolved: 0 });
  });

  // ── Voice ─────────────────────────────────────────────────────

  it('by voice, reads the words heard behind the bridge’s English and says the answer in that language', async () => {
    useClaude();
    anthropic.readings['紐約天氣點'] = YUE_NY;
    const r = await say({ text: "what's the weather today", heard: '紐約天氣點', lang: 'yue', questions: true });
    assert.equal(r.handled, true);
    assert.equal(r.lang, 'yue');
    assert.match(r.say, /^紐約：而家華氏三十度，/);
    assert.doesNotMatch(r.say, /[0-9°F%]/, 'a speaker reads numbers written out, not "30F"');
    assert.deepEqual({ ...db.prepare('SELECT text, understood FROM voice_commands').get() as any }, { text: '紐約天氣點', understood: 1 });
  });

  it('by voice, answers a missed English question on the first try, in spoken degrees', async () => {
    useClaude();
    anthropic.readings["what's the weather in New York"] = { ask: 'weather', day: 'today', place: 'New York', place_said: 'New York' };
    const r = await say({ text: "what's the weather in New York", retry: true, lang: 'en', questions: true });
    assert.equal(r.handled, true);
    assert.equal(r.say, "New York: Right now it's 30 degrees and cloudy. Today's high is 36 degrees and the low is 24 degrees.");
    assert.equal(anthropic.forms, 0, 'a first try is never asked about as a command');
  });

  it('by voice, stray talk stays not understood, and an older bridge gets no words it can’t say', async () => {
    useClaude();
    let r = await say({ text: 'Thank you for watching.', ask: true, lang: 'en', questions: true });
    assert.equal(r.handled, false);
    assert.equal(r.say, undefined);
    anthropic.questions = [];
    // An older bridge says the numbers itself, so it's answered for home, as before.
    r = await say({ text: "what's the weather in New York" });
    assert.equal(r.say, undefined);
    assert.match(r.response, /^Right now it's 52 degrees/);
    assert.equal(anthropic.questions.length, 0);
  });
});
