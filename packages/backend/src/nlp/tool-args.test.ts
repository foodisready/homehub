import { describe, it, before, after } from 'node:test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { looksLikeToolCall, toolArguments, toolCallInText } from './tool-args';

/** For the honest-reply tests, which load the chat service, and with it a database. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-tool-args-test-'));

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

describe('honest replies', () => {
  let nlp: typeof import('./nlp.service');
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    nlp = await import('./nlp.service');
  });
  after(() => fs.rmSync(TMP, { recursive: true, force: true }));

  const ok  = { tool: 'set_power_state', args: {}, result: { success: true, alias: 'Lamp', state: 'on' } };
  const bad = (error: string) => ({ tool: 'set_power_state', args: {}, result: { error } });
  const listed = { tool: 'list_devices', args: {}, result: { on: ['Lamp'], off: [], offline: [] } };

  it('passes on a claim a switch backs up, and anything that claims nothing', () => {
    assert.equal(nlp.honestReply('Lamp is now on.', [ok]), 'Lamp is now on.');
    assert.equal(nlp.honestReply('Sunset is at 4:52 PM.', []), 'Sunset is at 4:52 PM.');
    assert.equal(nlp.honestReply('Which lamp did you mean?', [bad('x')]), 'Which lamp did you mean?');
  });

  it("leaves a report of what's on alone", () => {
    assert.equal(nlp.honestReply('Lamp is on.', [listed]), 'Lamp is on.');
  });

  it('replaces a claim nothing backs up, saying why for a person', () => {
    for (const claim of ["Brenden's room lights are now on.", 'I turned off the fan.', 'The lamp has been switched on.']) {
      assert.match(nlp.honestReply(claim, []), /^I didn't switch anything, as I couldn't work out which device/, claim);
    }
    assert.equal(nlp.honestReply('Done, it is on now.', [bad('"lamp" could mean "A", "B". Ask the user which one they mean.')]),
      `I didn't switch anything. "lamp" could mean "A", "B".`);
  });
});
