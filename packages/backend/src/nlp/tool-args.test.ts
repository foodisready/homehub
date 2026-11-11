import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toolArguments } from './tool-args';

describe('toolArguments', () => {
  it('takes plain arguments as they are', () => {
    assert.deepEqual(toolArguments({ alias: 'office lights', state: 'off' }), { alias: 'office lights', state: 'off' });
    assert.deepEqual(toolArguments('{"alias":"lamp","state":"on"}'), { alias: 'lamp', state: 'on' });
  });

  it('unwraps arguments a small model wrapped in the call itself', () => {
    const wrapped = { function: 'set_power_state', parameters: { alias: 'office lights', minutes: '', state: 'off' }, type: 'function' };
    assert.deepEqual(toolArguments(wrapped), { alias: 'office lights', minutes: '', state: 'off' });
    assert.deepEqual(toolArguments({ name: 'set_power_state', arguments: { alias: 'lamp', state: 'on' } }), { alias: 'lamp', state: 'on' });
  });

  it('gives nothing for nonsense', () => {
    assert.deepEqual(toolArguments(undefined), {});
    assert.deepEqual(toolArguments('not json'), {});
    assert.deepEqual(toolArguments([1, 2]), {});
  });
});
