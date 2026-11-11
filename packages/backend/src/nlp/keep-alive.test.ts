/** How long the AI model stays loaded. Loads modules in before(), after DB_PATH is set. */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-keepalive-test-'));
const GB = 1024 ** 3;

describe('keeping the AI model loaded', () => {
  let nlp: typeof import('./nlp.service');
  const saved = process.env.OLLAMA_KEEP_ALIVE;

  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    delete process.env.OLLAMA_KEEP_ALIVE;
    nlp = await import('./nlp.service');
  });

  after(() => {
    if (saved === undefined) delete process.env.OLLAMA_KEEP_ALIVE; else process.env.OLLAMA_KEEP_ALIVE = saved;
  });

  it('keeps it for a day with memory to spare, and 5 minutes on a small computer', () => {
    assert.equal(nlp.keepAlive(16 * GB), '24h');
    assert.equal(nlp.keepAlive(7.6 * GB), '24h', 'an 8 GB Raspberry Pi 4 reports 7.6');
    assert.equal(nlp.keepAlive(4 * GB), '5m');
    assert.equal(nlp.keepAlive(3.7 * GB), '5m', 'a 4 GB Pi reports about 3.7');
  });

  it('follows OLLAMA_KEEP_ALIVE when set', () => {
    process.env.OLLAMA_KEEP_ALIVE = '-1';
    assert.equal(nlp.keepAlive(4 * GB), '-1');
    process.env.OLLAMA_KEEP_ALIVE = ' ';
    assert.equal(nlp.keepAlive(16 * GB), '24h');
  });
});

describe('loading the AI model at startup', () => {
  let nlp: typeof import('./nlp.service');
  const saved = { model: process.env.OLLAMA_MODEL, rewrite: process.env.OLLAMA_REWRITE_MODEL, keep: process.env.OLLAMA_KEEP_ALIVE };

  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    delete process.env.OLLAMA_KEEP_ALIVE;
    nlp = await import('./nlp.service');
  });

  after(() => {
    // The database module keeps the path it first opened, so the folder is shared and removed last.
    fs.rmSync(TMP, { recursive: true, force: true });
    for (const [key, value] of [['OLLAMA_MODEL', saved.model], ['OLLAMA_REWRITE_MODEL', saved.rewrite], ['OLLAMA_KEEP_ALIVE', saved.keep]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const recorder = (failFirst = 0) => {
    const asked: any[] = [];
    const primed: any[] = [];
    let failures = failFirst;
    const impl = (async (url: string, init: any) => {
      if (failures-- > 0) throw new Error('ECONNREFUSED');
      (url.endsWith('/api/chat') ? primed : asked).push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    return { impl, asked, primed };
  };

  it('loads the chat model and the rewrite model once each, to stay for a day', async () => {
    process.env.OLLAMA_MODEL = 'llama3.2:1b';
    process.env.OLLAMA_REWRITE_MODEL = 'qwen2.5:1.5b';
    const o = recorder();
    assert.deepEqual(await nlp.warmModels({ fetchImpl: o.impl, totalBytes: 8 * GB, waitMs: 1 }), ['llama3.2:1b', 'qwen2.5:1.5b']);
    assert.deepEqual(o.asked, [{ model: 'llama3.2:1b', keep_alive: '24h' }, { model: 'qwen2.5:1.5b', keep_alive: '24h' }]);

    delete process.env.OLLAMA_REWRITE_MODEL;
    const same = recorder();
    await nlp.warmModels({ fetchImpl: same.impl, totalBytes: 8 * GB, waitMs: 1 });
    assert.equal(same.asked.length, 1, 'one model when the rewrite uses the chat model');
  });

  it("has the rewrite model read its instructions, so the first command is quick", async () => {
    process.env.OLLAMA_MODEL = 'llama3.2:1b';
    process.env.OLLAMA_REWRITE_MODEL = 'qwen2.5:1.5b';
    const o = recorder();
    await nlp.warmModels({ fetchImpl: o.impl, totalBytes: 8 * GB, waitMs: 1 });
    const rewrite = o.primed.filter((p) => /plain command/.test(p.messages[0].content));
    assert.equal(rewrite.length, 1);
    assert.equal(rewrite[0].model, 'qwen2.5:1.5b');
    assert.equal(rewrite[0].keep_alive, '24h');
    assert.equal(rewrite[0].options.num_predict, 1, 'reads the instructions, writes next to nothing');
  });

  it("has the chat model read its instructions, with and without its tools", async () => {
    process.env.OLLAMA_MODEL = 'qwen2.5:1.5b';
    delete process.env.OLLAMA_REWRITE_MODEL;
    const o = recorder();
    await nlp.warmModels({ fetchImpl: o.impl, totalBytes: 8 * GB, waitMs: 1 });
    const chat = o.primed.filter((p) => /You are HomeHub/.test(p.messages[0].content));
    assert.equal(chat.length, 2);
    assert.ok(chat[0].tools?.length, 'with tools, as the first call of a chat');
    assert.equal(chat[1].tools, undefined, 'without, as the final answer');
    assert.ok(chat.every((p) => p.model === 'qwen2.5:1.5b' && p.options.num_predict === 1));
    assert.match(o.primed[0].messages[0].content, /plain command/, "the rewrite's first: commands use it first");
    delete process.env.OLLAMA_REWRITE_MODEL;
  });

  it('waits for Ollama to start', async () => {
    process.env.OLLAMA_MODEL = 'llama3.2:1b';
    const o = recorder(2);
    assert.deepEqual(await nlp.warmModels({ fetchImpl: o.impl, totalBytes: 8 * GB, waitMs: 1 }), ['llama3.2:1b']);
  });

  it('gives up quietly when Ollama never answers', async () => {
    const o = recorder(99);
    assert.deepEqual(await nlp.warmModels({ fetchImpl: o.impl, totalBytes: 8 * GB, tries: 3, waitMs: 1 }), []);
    assert.equal(o.primed.length, 0, 'no instructions sent to a model that never loaded');
  });

  it('leaves a small computer alone, which would only unload it again', async () => {
    const o = recorder();
    assert.deepEqual(await nlp.warmModels({ fetchImpl: o.impl, totalBytes: 4 * GB, waitMs: 1 }), []);
    assert.equal(o.asked.length, 0);
  });
});
