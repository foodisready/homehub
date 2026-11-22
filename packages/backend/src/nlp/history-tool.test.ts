import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { byWords, fromLocal } from './history-tool';

describe('history tool', () => {
  it('reads a time on the home’s clock, across daylight saving', () => {
    assert.equal(new Date(fromLocal('2026-11-22 00:00', 'America/New_York')!).toISOString(), '2026-11-22T05:00:00.000Z');
    assert.equal(new Date(fromLocal('2026-07-04 21:30', 'America/New_York')!).toISOString(), '2026-07-05T01:30:00.000Z');
    assert.equal(new Date(fromLocal('2026-11-22T05:00', 'Asia/Hong_Kong')!).toISOString(), '2026-11-21T21:00:00.000Z');
    assert.equal(new Date(fromLocal('2026-03-08 03:30', 'America/New_York')!).toISOString(), '2026-03-08T07:30:00.000Z');
    assert.equal(fromLocal('yesterday', 'America/New_York'), null);
    assert.equal(fromLocal('2026-13-01 00:00', 'America/New_York'), null);
  });

  it('says what did it, and who', () => {
    assert.equal(byWords({ source: 'app', detail: null, via: null, userName: 'Anna' }), 'the app (Anna)');
    assert.equal(byWords({ source: 'motion', detail: 'Kitchen at night', via: null, userName: null }), 'a motion light (Kitchen at night)');
    assert.equal(byWords({ source: 'scene', detail: 'Goodnight', via: 'chat', userName: null }), 'a scene (Goodnight), from Chat');
    assert.match(byWords({ source: 'outside', detail: null, via: null, userName: null }), /wall switch/);
  });
});
