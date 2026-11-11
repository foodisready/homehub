import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeToolCall, toolArguments, toolCallInText } from './tool-args';

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

  const TOOLS = ['set_power_state', 'list_devices'];

  it('finds a whole tool call written as text, in the shapes small models use', () => {
    assert.deepEqual(toolCallInText('{"name": "set_power_state", "parameters": {"alias": "office lights", "state": "on"}}', TOOLS),
      { name: 'set_power_state', arguments: { alias: 'office lights', state: 'on' } });
    assert.deepEqual(toolCallInText('{"type":"function","function":"set_power_state","parameters":{"alias":"lamp","state":"off"}}', TOOLS),
      { name: 'set_power_state', arguments: { alias: 'lamp', state: 'off' } });
    assert.deepEqual(toolCallInText('```json\n{"type":"function","function":{"name":"list_devices","arguments":{}}}\n```', TOOLS),
      { name: 'list_devices', arguments: {} });
  });

  it('makes no call from broken text, an unknown tool, or ordinary words', () => {
    // As seen from llama3.2:1b on the Pi: quotes missing, a key twice.
    const broken = '{"type":"function","function":"set_power_state","parameters":{"alias":"Brendens room",state":"on",minutes":"","minutes":"0"}}';
    assert.equal(toolCallInText(broken, TOOLS), null);
    assert.equal(looksLikeToolCall(broken, TOOLS), true, 'but it is never shown');
    assert.equal(toolCallInText('{"name": "delete_everything", "parameters": {}}', TOOLS), null);
    assert.equal(toolCallInText('The office lights are on.', TOOLS), null);
    assert.equal(looksLikeToolCall('The office lights are on.', TOOLS), false);
    assert.equal(looksLikeToolCall('{ not a call }', TOOLS), false);
  });

  it('gives nothing for nonsense', () => {
    assert.deepEqual(toolArguments(undefined), {});
    assert.deepEqual(toolArguments('not json'), {});
    assert.deepEqual(toolArguments([1, 2]), {});
  });
});
