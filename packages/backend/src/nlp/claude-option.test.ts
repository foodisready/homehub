/**
 * Claude Haiku as an option: the household's own key, chosen in Settings, with this HomeHub's
 * model taking over when Claude can't answer. Against a temp DB, a fake Anthropic API and a fake
 * Ollama, so nothing leaves the machine.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-claude-option-test-'));
const KEY = 'sk-ant-api03-' + 'x'.repeat(40);

let db: Database.Database;
let choice: typeof import('./ai-choice');
let nlp: typeof import('./nlp.service');
let chat: typeof import('./claude-chat');
let fake: http.Server;
let appServer: http.Server;
let api = '';
let internal = '';
const INTERNAL = 'test-internal-key';
const switched: { ip: string; state: boolean }[] = [];

/** What the fake Anthropic API saw and will answer. */
const anthropic = {
  requests: [] as any[],
  questions: [] as any[],
  keys: [] as string[],
  status: 200,
  form: { action: 'on', target: 'Porch light', scene: null, minutes: null, lang: 'en' } as Record<string, unknown>,
  chat: [] as any[],   // answers to chat requests, in order
};
const ollama = { requests: [] as any[], form: { action: 'on', target: 'Porch light', scene: null, minutes: null, lang: 'en' } };

const message = (content: any[], stop = 'end_turn') =>
  ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason: stop, usage: { input_tokens: 2000, output_tokens: 100 } });

function startFake(): Promise<number> {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      if (req.url?.startsWith('/v1/messages')) {
        // The question reader (question-reader.ts) reads each miss too: nothing was asked, here.
        if (json.output_config?.format?.schema?.properties?.place_said) {
          anthropic.questions.push(json);
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify(message([{ type: 'text', text: JSON.stringify({ ask: 'none', day: 'today', place: null, place_said: null }) }])));
        }
        anthropic.requests.push(json);
        anthropic.keys.push(String(req.headers['x-api-key'] ?? req.headers.authorization ?? '').replace(/^Bearer /, ''));
        if (anthropic.status !== 200) {
          res.writeHead(anthropic.status, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        if (json.output_config?.format) return res.end(JSON.stringify(message([{ type: 'text', text: JSON.stringify(anthropic.form) }])));
        return res.end(JSON.stringify(anthropic.chat.shift() ?? message([{ type: 'text', text: 'Hello from Claude.' }])));
      }
      if (req.url === '/api/chat' || req.url === '/api/generate') {
        ollama.requests.push(json);
        res.writeHead(200, { 'content-type': 'application/json' });
        if (json.format) return res.end(JSON.stringify({ message: { content: JSON.stringify(ollama.form) }, done: true }) + '\n');
        return res.end(JSON.stringify({ message: { role: 'assistant', content: 'Hello from the Pi.' }, done: true }) + '\n');
      }
      res.writeHead(404); res.end();
    });
  });
  return new Promise((ok) => fake.listen(0, '127.0.0.1', () => ok((fake.address() as { port: number }).port)));
}

const usage = () => choice.aiUsage();

describe('Claude Haiku option', () => {
  before(async () => {
    const port = await startFake();
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.OLLAMA_URL = `http://127.0.0.1:${port}`;
    process.env.OLLAMA_MODEL = 'qwen2.5:1.5b';
    process.env.SCHEDULER_URL = 'http://127.0.0.1:1';
    delete process.env.ANTHROPIC_API_KEY;
    process.env.INTERNAL_API_KEY = INTERNAL;
    db = (await import('../db')).getDb();
    choice = await import('./ai-choice');
    nlp = await import('./nlp.service');
    chat = await import('./claude-chat');
    const { getDriver } = await import('../drivers/registry');
    getDriver('kasa').setPower = async (ip: string, state: boolean) => { switched.push({ ip, state }); };
    db.prepare("INSERT INTO devices (alias, ip, room, driver_type) VALUES ('Porch light', '192.0.2.10', 'Front', 'kasa')").run();
    db.prepare("INSERT INTO devices (alias, ip, room, driver_type) VALUES ('Desk lamp', '192.0.2.11', 'Office', 'kasa')").run();

    const { aiRouter, setKeyVerifier } = await import('../routes/ai');
    setKeyVerifier(async (k) => (k.endsWith('bad'.repeat(10)) ? 'Anthropic rejected the key. It may have been deleted; enter a new one.' : null));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { userId: 1, username: 't', role: req.headers['x-role'] ?? 'admin' } as never; next(); });
    app.use('/api/ai', aiRouter);
    app.use('/internal', (await import('../routes/internal')).internalRouter);
    await new Promise<void>((ok) => { appServer = app.listen(0, '127.0.0.1', () => ok()); });
    api = `http://127.0.0.1:${(appServer.address() as { port: number }).port}/api/ai`;
    internal = api.replace('/api/ai', '/internal/voice');
  });

  after(async () => {
    await new Promise<void>((ok) => appServer.close(() => ok()));
    await new Promise<void>((ok) => fake.close(() => ok()));
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    anthropic.requests = []; anthropic.questions = []; anthropic.keys = []; anthropic.status = 200; anthropic.chat = [];
    anthropic.form = { action: 'on', target: 'Porch light', scene: null, minutes: null, lang: 'en' };
    ollama.requests = [];
    switched.length = 0;
    db.prepare("DELETE FROM settings WHERE key IN ('ai_choice', 'anthropic_api_key', 'ai_usage')").run();
  });

  const send = async (method: string, url: string, body?: unknown, role = 'admin') => {
    const r = await fetch(api + url, { method, headers: { 'content-type': 'application/json', 'x-role': role }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };

  // ── Settings ──────────────────────────────────────────────────

  it('starts on this HomeHub, and never sends the key back', async () => {
    let r = await send('GET', '');
    assert.equal(r.body.mode, 'local');
    assert.equal(r.body.keyHint, null);
    r = await send('PUT', '', { apiKey: KEY, mode: 'claude' });
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'claude');
    assert.equal(r.body.keyHint, '…xxxx');
    assert.ok(!JSON.stringify(r.body).includes(KEY));
    assert.ok(!JSON.stringify((await send('GET', '')).body).includes(KEY));
  });

  it('won’t choose Claude without a key, and checks a key before saving it', async () => {
    assert.equal((await send('PUT', '', { mode: 'claude' })).body.code, 'NO_KEY');
    assert.equal((await send('PUT', '', { apiKey: 'hello' })).status, 400);
    const bad = await send('PUT', '', { apiKey: 'sk-ant-api03-' + 'bad'.repeat(10) });
    assert.equal(bad.body.code, 'KEY_REJECTED');
    assert.match(bad.body.error, /rejected the key/);
    assert.equal(choice.claudeKey(), null);
    assert.equal(choice.aiMode(), 'local');
  });

  it('forgetting the key goes back to this HomeHub', async () => {
    await send('PUT', '', { apiKey: KEY, mode: 'claude' });
    const r = await send('DELETE', '/key');
    assert.equal(r.body.mode, 'local');
    assert.equal(r.body.keyHint, null);
    assert.equal(choice.claudeInUse(), null);
  });

  it('is for admins only', async () => {
    assert.equal((await send('GET', '', undefined, 'member')).status, 403);
    assert.equal((await send('PUT', '', { mode: 'local' }, 'member')).status, 403);
  });

  // ── Chat ──────────────────────────────────────────────────────

  it('on this HomeHub, a saved key isn’t used', async () => {
    choice.setClaudeKey(KEY);
    const r = await nlp.processMessage('make the front brighter', [], 't1');
    assert.equal(anthropic.requests.length, 0);
    assert.ok(ollama.requests.length > 0);
    assert.match(r.response, /Porch light/);
  });

  it('with Claude: the rules still answer first, without asking Claude', async () => {
    choice.setClaudeKey(KEY); choice.setAiMode('claude');
    await nlp.processMessage('turn on porch light', [], 't2');
    assert.equal(anthropic.requests.length, 0);
    assert.deepEqual(switched, [{ ip: '192.0.2.10', state: true }]);
  });

  it('with Claude: it reads the command, HomeHub asks first, and the use is counted', async () => {
    choice.setClaudeKey(KEY); choice.setAiMode('claude');
    const r = await nlp.processMessage('make the front brighter', [], 't3');
    assert.equal(anthropic.requests.length, 1);
    assert.equal(anthropic.keys[0], KEY);
    assert.equal(ollama.requests.length, 0, 'the Pi’s model isn’t asked');
    assert.match(r.response, /Porch light/);
    assert.equal(switched.length, 0, 'nothing switched before a yes');
    await nlp.processMessage('yes', [], 't3');
    assert.deepEqual(switched, [{ ip: '192.0.2.10', state: true }]);
    const u = usage();
    // The form, and the question reader's look at the same words: both cost.
    assert.equal(anthropic.questions.length, 1);
    assert.equal(u.requests, 2);
    assert.equal(u.inputTokens, 4000);
    assert.equal(u.outputTokens, 200);
    assert.ok(Math.abs(choice.costUsd(u) - 0.0005) < 1e-9);
  });

  it('with Claude: a question is answered by Claude with HomeHub’s tools, not the Pi', async () => {
    choice.setClaudeKey(KEY); choice.setAiMode('claude');
    anthropic.form = { action: 'question', target: null, scene: null, minutes: null, lang: 'en' };
    anthropic.chat = [
      message([{ type: 'tool_use', id: 'tu_1', name: 'list_devices', input: {} }], 'tool_use'),
      message([{ type: 'text', text: 'Nothing is on.' }]),
    ];
    const r = await nlp.processMessage('is anything left running?', [{ role: 'assistant', content: 'Hi' }, { role: 'user', content: 'hello' }], 't4');
    assert.equal(r.response, 'Nothing is on.');
    assert.equal(r.actions[0].tool, 'list_devices');
    assert.equal(ollama.requests.length, 0);
    const second = anthropic.requests[2];
    assert.equal(second.messages[0].role, 'user', 'history starts with a person');
    const results = second.messages.at(-1).content;
    assert.equal(results[0].type, 'tool_result');
    assert.equal(results[0].tool_use_id, 'tu_1');
    assert.ok(Array.isArray(JSON.parse(results[0].content).offline), 'HomeHub’s own device list went back');
    assert.equal(usage().requests, 3, 'the form, the question reader and the chat');
  });

  it('with Claude: a switch Claude picks in chat is asked about first, never done', async () => {
    choice.setClaudeKey(KEY); choice.setAiMode('claude');
    anthropic.form = { action: 'unclear', target: null, scene: null, minutes: null, lang: 'en' };
    anthropic.chat = [
      message([{ type: 'tool_use', id: 'tu_2', name: 'set_power_state', input: { alias: 'Office', state: 'on' } }], 'tool_use'),
      message([{ type: 'text', text: 'Done, the office is on!' }]),
    ];
    const r = await nlp.processMessage('the office is too dark', [], 't7');
    assert.equal(switched.length, 0);
    assert.match(r.response, /Desk lamp\?/, 'HomeHub asks, in its own words');
    assert.equal(anthropic.requests.length, 2, 'the chat stops once HomeHub asks');
    await nlp.processMessage('yes', [], 't7');
    assert.deepEqual(switched, [{ ip: '192.0.2.11', state: true }]);
  });

  it('with Claude: a schedule isn’t mistaken for a switch now', async () => {
    choice.setClaudeKey(KEY); choice.setAiMode('claude');
    anthropic.chat = [message([{ type: 'text', text: 'Which days?' }])];
    const r = await nlp.processMessage('turn the porch thing off every day at 11pm', [], 't8');
    assert.equal(r.response, 'Which days?');
    assert.ok(!anthropic.requests.some((b) => b.output_config?.format), 'the form isn’t asked');
    assert.equal(switched.length, 0);
  });

  it('with Claude: replies are told to be short and in the home’s time zone', async () => {
    choice.setClaudeKey(KEY); choice.setAiMode('claude');
    anthropic.form = { action: 'question', target: null, scene: null, minutes: null, lang: 'en' };
    await nlp.processMessage('should we water the garden tonight', [], 't9');
    const system = anthropic.requests.find((b) => b.tools)!.system as string;
    assert.match(system, /no markdown/);
    assert.match(system, /time zone is /);
  });

  it('when Claude rejects the key, the Pi answers and Settings says why', async () => {
    choice.setClaudeKey(KEY); choice.setAiMode('claude');
    anthropic.status = 401;
    const r = await nlp.processMessage('make the front brighter', [], 't5');
    assert.ok(ollama.requests.length > 0, 'the Pi’s model took over');
    assert.match(r.response, /Porch light/);
    const u = usage();
    assert.equal(u.fallbacks, 1);
    assert.match(u.lastError ?? '', /rejected the key/);
    assert.ok(!(u.lastError ?? '').includes(KEY));
    const view = await send('GET', '');
    assert.match(view.body.usage.lastError, /rejected the key/);
  });

  it('streaming names Claude as the one answering', async () => {
    choice.setClaudeKey(KEY); choice.setAiMode('claude');
    const events = [];
    for await (const e of nlp.processMessageStream('make the front brighter', [], 't6')) events.push(e);
    assert.deepEqual(events[0], { type: 'meta', by: 'model', model: 'Claude Haiku' });
  });

  it('a monthly limit hands chat back to this HomeHub once reached, until next month', async () => {
    choice.setClaudeKey(KEY); choice.setAiMode('claude');
    assert.equal((await send('PUT', '', { monthlyLimitUsd: 500 })).status, 400);
    assert.equal((await send('PUT', '', { monthlyLimitUsd: 0.01 })).status, 400);
    assert.equal((await send('PUT', '', { monthlyLimitUsd: '5' })).status, 400);
    let r = await send('PUT', '', { monthlyLimitUsd: 0.1 });
    assert.equal(r.body.monthlyLimitUsd, 0.1);
    assert.equal(r.body.overLimit, false);
    assert.equal(r.body.mode, 'claude', 'the limit keeps the choice');

    choice.recordClaudeUse(1_000_000, 0);   // $0.10: the limit
    r = await send('GET', '');
    assert.equal(r.body.overLimit, true);
    const answer = await nlp.processMessage('make the front brighter', [], 't10');
    assert.equal(anthropic.requests.length, 0, 'Claude isn’t asked past the limit');
    assert.ok(ollama.requests.length > 0, 'this HomeHub answers');
    assert.match(answer.response, /Porch light/);

    const nextMonth = new Date(Date.now() + 32 * 86_400_000);
    assert.equal(choice.claudeInUse(nextMonth), KEY, 'a new month starts again');

    r = await send('PUT', '', { monthlyLimitUsd: null });
    assert.equal(r.body.monthlyLimitUsd, null);
    assert.equal(r.body.overLimit, false);
    assert.equal(choice.aiMode(), 'claude');
  });

  // ── Pieces ────────────────────────────────────────────────────

  it('a new month starts the count again, keeping the last problem', () => {
    choice.recordClaudeUse(1000, 50, new Date('2026-10-31T12:00:00Z'));
    choice.recordClaudeFailure('Couldn’t reach Anthropic.', new Date('2026-10-31T12:00:00Z'));
    const u = choice.aiUsage(new Date('2026-11-20T12:00:00Z'));
    assert.equal(u.month, '2026-11');
    assert.equal(u.requests, 0);
    assert.equal(u.fallbacks, 0);
    assert.equal(u.lastError, 'Couldn’t reach Anthropic.');
  });

  it('chat with Claude merges repeated turns and reports API errors with their status', async () => {
    const seen: any[] = [];
    const client = { messages: { create: async (b: any) => { seen.push(structuredClone(b)); return message([{ type: 'text', text: 'ok' }]); } } };
    await chat.chatWithClaude('third', [{ role: 'user', content: 'one' }, { role: 'user', content: 'two' }], { apiKey: KEY, system: 's', tools: [], execute: async () => null, client });
    assert.deepEqual(seen[0].messages.map((m: any) => m.role), ['user', 'assistant', 'user']);
    assert.equal(seen[0].messages[0].content, 'one\ntwo');

    const refusing = { messages: { create: async () => message([], 'refusal') } };
    await assert.rejects(chat.chatWithClaude('x', [], { apiKey: KEY, system: 's', tools: [], execute: async () => null, client: refusing }), /refused/);
  });

  it('error texts say what to do and never carry the key', () => {
    assert.match(choice.claudeErrorText(401, `bad key ${KEY}`), /rejected the key/);
    assert.match(choice.claudeErrorText(400, 'Your credit balance is too low'), /out of credit/);
    assert.match(choice.claudeErrorText(undefined, 'ECONNREFUSED'), /internet/);
    assert.ok(!choice.claudeErrorText(500, KEY).includes(KEY));
  });
  // ── Voice ─────────────────────────────────────────────────────

  const voice = async (url: string, body: unknown) => {
    const r = await fetch(internal + url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };

  it('voice: with Claude, a missed command is asked about out loud, and a yes switches it', async () => {
    choice.setClaudeKey(KEY); choice.setAiMode('claude');
    const r = await voice('/command', { text: 'make the front brighter', ask: true, lang: 'en' });
    assert.equal(r.body.handled, false);
    assert.equal(r.body.say, 'Should I turn on Porch light?');
    assert.equal(r.body.lang, 'en');
    assert.ok(r.body.confirmId);
    assert.equal(switched.length, 0, 'nothing switched before a yes');
    assert.equal(usage().requests, 2, 'the form and the question reader, counted with Chat’s use');
    const yes = await voice(`/confirm/${r.body.confirmId}`, { answer: 'yes' });
    assert.equal(yes.status, 200);
    assert.equal(yes.body.handled, true);
    assert.deepEqual(switched, [{ ip: '192.0.2.10', state: true }]);
    // Answered: a second yes finds nothing to answer.
    assert.equal((await voice(`/confirm/${r.body.confirmId}`, { answer: 'yes' })).status, 404);
  });

  it('voice: Claude is told the wake word, and whether each device is on now', async () => {
    // From the Pi, 2026-11-21: "冇有熄啊亮灯" after 老友, its end heard as 冇有; and "欧亮灯", its 熄 lost,
    // of a lamp that was on.
    choice.setClaudeKey(KEY); choice.setAiMode('claude');
    const { getAllCachedStates } = await import('../kasa/device.cache');
    const porch = (db.prepare("SELECT id FROM devices WHERE alias = 'Porch light'").get() as { id: number }).id;
    getAllCachedStates().set(porch, { state: true, wattage: null, online: true, lastPolled: new Date() });
    try {
      await voice('/command', { text: '冇有熄啊亮灯', ask: true, lang: 'yue', wake: '老友' });
      const system = anthropic.requests.at(-1).system as string;
      assert.match(system, /straight after its wake word, "老友"/);
      assert.match(system, /- Porch light \(room: Front; now on\)/);
      // No wake word (listening again), none said; offline, no state.
      getAllCachedStates().set(porch, { state: true, wattage: null, online: false, lastPolled: new Date() });
      await voice('/command', { text: '欧亮灯', ask: true, lang: 'yue' });
      const again = anthropic.requests.at(-1).system as string;
      assert.doesNotMatch(again, /wake word/);
      assert.match(again, /- Porch light \(room: Front\)/);
    } finally {
      getAllCachedStates().delete(porch);
    }
  });

  it('voice: a no leaves everything, said in the language heard', async () => {
    choice.setClaudeKey(KEY); choice.setAiMode('claude');
    anthropic.form = { action: 'off', target: 'Desk lamp', scene: null, minutes: null, lang: 'en' };
    const r = await voice('/command', { text: 'ván đèn bàn đi', ask: true, lang: 'vi' });
    assert.equal(r.body.say, 'Có phải bạn muốn tắt Desk lamp không?');
    assert.equal(r.body.lang, 'vi');
    const no = await voice(`/confirm/${r.body.confirmId}`, { answer: 'no' });
    assert.equal(no.body.response, 'Được, tôi không thay đổi gì.');
    assert.equal(switched.length, 0);
  });

  it('voice: no question without Claude, from an older bridge, or on a first try heard again', async () => {
    choice.setClaudeKey(KEY);
    let r = await voice('/command', { text: 'make the front brighter', ask: true });
    assert.equal(r.body.confirmId, undefined, 'this HomeHub’s model never asks out loud');
    choice.setAiMode('claude');
    r = await voice('/command', { text: 'make the front brighter' });
    assert.equal(r.body.confirmId, undefined, 'a bridge that doesn’t say it can listen for the answer');
    r = await voice('/command', { text: 'make the front brighter', ask: true, retry: true });
    assert.equal(r.body.confirmId, undefined);
    assert.equal(anthropic.requests.length, 0);
    assert.equal(ollama.requests.length, 0);
    assert.match(r.body.response, /understand/i);
  });

  it('voice: the rules still act at once, and Claude failing just means not understood', async () => {
    choice.setClaudeKey(KEY); choice.setAiMode('claude');
    let r = await voice('/command', { text: 'turn on porch light', ask: true });
    assert.equal(r.body.handled, true);
    assert.equal(anthropic.requests.length, 0);
    anthropic.status = 401;
    r = await voice('/command', { text: 'make the front brighter', ask: true });
    assert.equal(r.body.confirmId, undefined);
    assert.match(usage().lastError ?? '', /rejected the key/);
  });

  it('voice: opening a garage door is refused, never asked', async () => {
    choice.setClaudeKey(KEY); choice.setAiMode('claude');
    db.prepare("INSERT INTO devices (alias, ip, room, driver_type) VALUES ('Garage', '192.0.2.12', 'Garage', 'meross')").run();
    try {
      anthropic.form = { action: 'open', target: 'Garage', scene: null, minutes: null, lang: 'en' };
      const r = await voice('/command', { text: 'let the car out', ask: true, lang: 'yue' });
      assert.equal(r.body.confirmId, undefined);
      assert.match(r.body.say, /車房門/);
    } finally {
      db.prepare("DELETE FROM devices WHERE alias = 'Garage'").run();
    }
  });

  it('voice: past the monthly limit, no question', async () => {
    choice.setClaudeKey(KEY); choice.setAiMode('claude'); choice.setMonthlyLimit(0.1);
    choice.recordClaudeUse(1_000_000, 0);
    const r = await voice('/command', { text: 'make the front brighter', ask: true });
    assert.equal(r.body.confirmId, undefined);
    assert.equal(anthropic.requests.length, 0);
  });
});
