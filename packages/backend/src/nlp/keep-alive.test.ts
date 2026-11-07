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
    fs.rmSync(TMP, { recursive: true, force: true });
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
