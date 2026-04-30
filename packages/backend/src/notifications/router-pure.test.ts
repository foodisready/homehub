/**
 * Pure tests for the routing matrix — no DB, no providers, no env.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { channelsForLevel } from './router';

describe('channelsForLevel', () => {
  it('L0 → no channels', () => {
    assert.deepEqual(channelsForLevel(0), []);
  });
  it('L1 → push only', () => {
    assert.deepEqual(channelsForLevel(1), ['push']);
  });
  it('L2 → push + email', () => {
    assert.deepEqual(channelsForLevel(2), ['push', 'email']);
  });
  it('L3 → push + email + sms', () => {
    assert.deepEqual(channelsForLevel(3), ['push', 'email', 'sms']);
  });
});
