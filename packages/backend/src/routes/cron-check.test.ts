import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cronProblem } from './cron-check';

describe('cronProblem', () => {
  it('accepts what the scheduler runs', () => {
    for (const expr of ['30 0 * * *', '0 0 * * *', '30 23,19 * * *', '0 8 * * 1-5', '*/15 * * * *', '0 9 * * mon', '0 30 0 * * *']) {
      assert.equal(cronProblem(expr), null, expr);
    }
  });

  it('catches the hour written first, and says how to fix it', () => {
    const problem = cronProblem('0 30 * * *');
    assert.match(problem!, /hour must be 0–23, not 30/);
    assert.match(problem!, /"30 0 \* \* \*"/);
  });

  it('rejects other nonsense', () => {
    assert.match(cronProblem('every night')!, /5 parts/);
    assert.match(cronProblem('61 1 * * *')!, /minute must be 0–59/);
    assert.match(cronProblem('0 5-2 * * *')!, /backwards/);
    assert.match(cronProblem('0 1 * 13 *')!, /month must be 1–12/);
    assert.match(cronProblem('*/0 * * * *')!, /step by 0/);
  });
});
