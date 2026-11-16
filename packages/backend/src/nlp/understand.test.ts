/**
 * The form, read as it streams: whole when something may be switched, stopped early when not.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { understandWithOllama, type HomeNames } from './understand';

const home: HomeNames = {
  devices: [{ alias: 'My office lamp', nicknames: [], room: 'Office', light: true }],
  scenes: [],
};

/** Ollama's NDJSON stream, split at awkward places, with the request's signal kept. */
function streaming(pieces: string[], opts: { endless?: boolean } = {}) {
  const seen: { signal?: AbortSignal; body?: any; sent: number } = { sent: 0 };
  const lines = pieces.map((content) => JSON.stringify({ message: { role: 'assistant', content }, done: false }) + '\n')
    .concat(opts.endless ? [] : [JSON.stringify({ done: true }) + '\n']);
  const bytes = new TextEncoder().encode(lines.join(''));
  const impl = (async (_url: string, init: RequestInit) => {
    seen.signal = init.signal ?? undefined;
    seen.body = JSON.parse(String(init.body));
    let at = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (seen.signal?.aborted) { ctrl.error(new Error('aborted')); return; }
        if (at >= bytes.length) {
          if (opts.endless) { await new Promise((r) => setTimeout(r, 5)); ctrl.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: ' ' } }) + '\n')); seen.sent++; return; }
          ctrl.close(); return;
        }
        ctrl.enqueue(bytes.slice(at, at + 7));   // 7 bytes at a time: lines and JSON split mid-way
        at += 7;
        seen.sent++;
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe('the form from Ollama', () => {
  it('reads a whole form when something is to be switched', async () => {
    const o = streaming(['{"action":"of', 'f","target":"My office lamp"', ',"scene":null,"minutes":null,"lang":"en"}']);
    const r = await understandWithOllama('turn of uffice', home, { url: 'http://o', model: 'm', fetchImpl: o.impl });
    assert.equal(o.seen.body.stream, true);
    assert.ok(o.seen.body.format, 'with the form as its required answer');
    assert.deepEqual(r.understanding, { action: 'off', devices: ['My office lamp'], scene: null, minutes: null, lang: 'en' });
    assert.equal(o.seen.signal?.aborted, false);
  });

  it('stops the model as soon as the form says it is a question', async () => {
    // The model would go on writing; HomeHub hangs up once the action is known.
    const o = streaming(['{"action": "quest', 'ion", "target":'], { endless: true });
    const r = await understandWithOllama('幾點', home, { url: 'http://o', model: 'm', fetchImpl: o.impl });
    assert.equal(r.understanding?.action, 'question');
    assert.deepEqual(r.understanding?.devices, []);
    assert.equal(o.seen.signal?.aborted, true);
  });

  it('stops early for unclear and scene too', async () => {
    for (const action of ['unclear', 'scene']) {
      const o = streaming([`{"action":"${action}"`], { endless: true });
      const r = await understandWithOllama('hm', home, { url: 'http://o', model: 'm', fetchImpl: o.impl });
      assert.equal(r.understanding?.action, action);
      assert.equal(o.seen.signal?.aborted, true);
    }
  });

  it('gives no reading for a broken form or an error from Ollama', async () => {
    const broken = await understandWithOllama('x', home, { url: 'http://o', model: 'm', fetchImpl: streaming(['{"action":"on","tar']).impl });
    assert.equal(broken.understanding, null);
    const failing = (async () => new Response(JSON.stringify({ error: 'model not found' }) + '\n', { status: 200 })) as unknown as typeof fetch;
    const r = await understandWithOllama('x', home, { url: 'http://o', model: 'm', fetchImpl: failing });
    assert.equal(r.understanding, null);
    assert.match(r.error ?? '', /model not found/);
  });
});
