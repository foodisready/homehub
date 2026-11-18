/** A Tuya plug found busy for a moment gets a second try. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withTuyaRetry, TUYA_TRIES, TUYA_RETRY_WAIT_MS } from './TuyaDriver';

describe('Tuya retry', () => {
  it('tries again after a short wait when the plug is busy', async () => {
    const tries: number[] = [];
    const waits: number[] = [];
    const result = await withTuyaRetry(async (connectS) => {
      tries.push(connectS);
      if (tries.length === 1) throw new Error('connection timed out');
      return 'switched';
    }, async (ms) => { waits.push(ms); });
    assert.equal(result, 'switched');
    assert.deepEqual(tries, [2, 3]);
    assert.deepEqual(waits, [TUYA_RETRY_WAIT_MS]);
  });

  it('does it once: a plug that answers needs no second try', async () => {
    let n = 0;
    await withTuyaRetry(async () => { n++; }, async () => undefined);
    assert.equal(n, 1);
  });

  it('gives the last reason when both tries fail, in about the time one failure took before', async () => {
    let n = 0;
    await assert.rejects(withTuyaRetry(async () => { n++; throw new Error(`busy ${n}`); }, async () => undefined), /busy 2/);
    assert.equal(n, TUYA_TRIES.length);
    const worst = TUYA_TRIES.reduce((s, t) => s + t.connectS * 1000, 0) + TUYA_RETRY_WAIT_MS;
    assert.ok(worst <= 6000, `worst case ${worst} ms`);
  });
});
