/**
 * The plain rewrite of a message the rules didn't understand.
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this file
 * stays on its temp DB even under a runner that hoists static imports.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-rewrite-test-'));

let rw: typeof import('./rewrite');
let nlp: typeof import('./nlp.service');
let db: Database.Database;
const switched: { ip: string; state: boolean }[] = [];

/** A stand-in Ollama: answers each call in turn, and records what it was asked. */
function fakeOllama(...replies: Array<string | Error>) {
  const asked: any[] = [];
  const impl = (async (_url: string, init: any) => {
    asked.push(JSON.parse(init.body));
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify({ message: { role: 'assistant', content: next ?? '' } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, asked };
}

describe('plain rewrites', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    const { getDb } = await import('../db');
    const { getDriver } = await import('../drivers/registry');
    rw = await import('./rewrite');
    nlp = await import('./nlp.service');
    db = getDb();
    getDriver('kasa').setPower = async (ip: string, state: boolean) => { switched.push({ ip, state }); };
    const add = db.prepare('INSERT INTO devices (alias, ip) VALUES (?, ?)');
    ['Office lights', 'Kitchen lights', 'Main Valve'].forEach((alias, i) => add.run(alias, `10.0.0.${i + 1}`));
  });

  after(() => {
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    switched.length = 0;
    db.prepare('UPDATE devices SET override_state = NULL, override_until = NULL, timer_off_at = NULL').run();
  });

  describe('reading the model', () => {
    it('takes its first line, without quotes or a full stop', () => {
      assert.equal(rw.readRewrite('"turn on office lights."\nanything else'), 'turn on office lights');
      assert.equal(rw.readRewrite('\n  turn off kitchen lights  '), 'turn off kitchen lights');
      assert.equal(rw.readRewrite("Turned on Brenden's room lights"), "turn on Brenden's room lights");
    });

    it('treats NONE and nothing as no rewrite', () => {
      assert.equal(rw.readRewrite('NONE'), null);
      assert.equal(rw.readRewrite('None.'), null);
      assert.equal(rw.readRewrite(''), null);
      assert.equal(rw.readRewrite('x'.repeat(200)), null);
    });
  });

  describe('keeping to what was written', () => {
    const faithful: Array<[string, string]> = [
      ['turn on ffice liights for 6 min',   'turn on office lights for 6 minutes'],
      ['turn on ffice liights for six min', 'turn on office lights for 6 minutes'],
      ['ofice lihgts on',                   'turn on office lights'],
      ['tunr of the kitchn lights',         'turn off kitchen lights'],
      ['kitchen lights on for 2 hrs',       'turn on kitchen lights for 120 minutes'],
      ['kitchen on for an hour',            'turn on kitchen lights for 60 minutes'],
      ['kitchen lights on for half an hour', 'turn on kitchen lights for 30 minutes'],
      ['can you turn on the ofice lights',  'turn on office lights'],
      ['wats on rite now',                  "what's on"],
      ['is the ofice light on?',            'is office lights on'],
      ['pause the frnt door cam',           'pause front door camera'],
    ];
    for (const [typed, plain] of faithful) {
      it(`accepts "${typed}" → "${plain}"`, () => assert.equal(rw.isFaithful(typed, plain), true));
    }

    const home = ['Front Porch', 'Kitchen lights', 'Kitchen Island', 'Kitchen counter lights', 'Kitchen', 'My office lamp'];
    it('lets the model finish a name only the typed words fit', () => {
      assert.equal(rw.isFaithful('turn on the porch light', 'turn on front porch', home), true);
      assert.equal(rw.isFaithful('turn on the prch light', 'turn on front porch', home), true);
      assert.equal(rw.isFaithful('turn on kitchn', 'turn on kitchen island', home), false, 'several kitchen names fit');
      assert.equal(rw.isFaithful('turn on the porch light', 'turn on front porch', []), false, 'unknown names are never finished');
      assert.equal(rw.isFaithful('turn on the lamp', 'turn on my office lamp', home), false, 'only filler was typed');
      assert.equal(rw.isFaithful('turn on porch', 'turn on front porch kitchen', home), false, 'words from another name');
    });

    const strays: Array<[string, string, string]> = [
      ['turn on ffice lights',            'turn off office lights',               'on became off'],
      ['is the office light on?',         'turn on office lights',                'a question became a command'],
      ['what about the office lights',    'turn on office lights',                'a question became a command'],
      ['turn on the lamp',                'turn on my office lamp',               'a name was added to'],
      ['turn off lights',                 'turn off all lights',                  '"all" was added'],
      ['turn on the fan',                 'turn on main valve',                   'another device'],
      ['turn on office lights',           'turn on office lights for 60 minutes', 'a timer was added'],
      ['turn on ofice lights for 6 min',  'turn on office lights for 60 minutes', 'the time changed'],
      ['turn on ofice lights for 6 min',  'turn on office lights',                'the timer was dropped'],
      ['turn on kitchen and off office',  'turn on kitchen lights',               'two commands became one'],
      ['open the valve',                  'turn on main valve',                   '"open" is not "on"'],
      ['turn on the office lights in an hour', 'turn on office lights',           'later is a schedule'],
      ['turn off kitchen lights at 10pm', 'turn off kitchen lights',              'a time is a schedule'],
      ['turn on porch light every sunset','turn on porch light',                  'every day is a schedule'],
      ['dim the kitchen lights to 50%',   'turn on kitchen lights',               'dimming is not on'],
      ['goodnight',                       'run movie time',                       'another scene'],
      ['turn on ofice lights',            'delete all schedules',                 'not a command the rules run'],
    ];
    for (const [typed, plain, why] of strays) {
      it(`refuses "${typed}" → "${plain}": ${why}`, () => assert.equal(rw.isFaithful(typed, plain), false));
    }
  });

  describe('asking the model', () => {
    const names = { devices: ['Office lights', 'Kitchen lights'], scenes: ['Goodnight'] };

    it('gives the plain command, and sends the home\'s names', async () => {
      const ollama = fakeOllama('turn on office lights for 6 minutes');
      assert.equal(await rw.rewriteMessage('turn on ffice liights for 6 min', { fetchImpl: ollama.impl, names }), 'turn on office lights for 6 minutes');
      const system = ollama.asked[0].messages[0].content as string;
      assert.match(system, /- Office lights/);
      assert.match(system, /- Goodnight/);
      assert.equal(ollama.asked[0].options.temperature, 0);
      assert.equal(ollama.asked[0].tools, undefined, 'no tools: the model only rewrites');
    });

    it('gives nothing when the model is unsure, strays, fails or is too slow', async () => {
      assert.equal(await rw.rewriteMessage('when is sunset', { fetchImpl: fakeOllama('NONE').impl, names }), null);
      assert.equal(await rw.rewriteMessage('turn on ffice lights', { fetchImpl: fakeOllama('turn off office lights').impl, names }), null);
      assert.equal(await rw.rewriteMessage('turn on ffice lights', { fetchImpl: fakeOllama(new Error('connect ECONNREFUSED')).impl, names }), null);
      const slow = (async (_u: string, init: any) => new Promise((_r, reject) =>
        init.signal.addEventListener('abort', () => reject(init.signal.reason)))) as unknown as typeof fetch;
      assert.equal(await rw.rewriteMessage('turn on ffice lights', { fetchImpl: slow, names, timeoutMs: 50 }), null);
    });
  });

  describe('in Chat', () => {
    const realFetch = globalThis.fetch;
    after(() => { globalThis.fetch = realFetch; });

    const run = async (text: string) => {
      const events: any[] = [];
      for await (const e of nlp.processMessageStream(text, [])) events.push(e);
      return events;
    };

    it('switches the light the rules find in the model\'s plain version, without the full model', async () => {
      const ollama = fakeOllama('turn on office lights for 6 minutes');
      globalThis.fetch = ollama.impl;

      const events = await run('turn on ffice liights for 6 min');

      assert.equal(ollama.asked.length, 1, 'only the short rewrite was asked');
      assert.deepEqual(switched, [{ ip: '10.0.0.1', state: true }]);
      const row = db.prepare("SELECT timer_off_at FROM devices WHERE alias = 'Office lights'").get() as any;
      assert.ok(row.timer_off_at, 'with its 6-minute timer');
      assert.match(events.find((e) => e.type === 'token').content, /Office lights.*6 minutes/);
      assert.equal(events.at(-1).type, 'done');
    });

    it('leaves a stray rewrite to the full model, and switches nothing itself', async () => {
      const ollama = fakeOllama('turn off office lights', 'Sorry, which light?');
      globalThis.fetch = ollama.impl;

      const events = await run('turn on ffice liights');

      assert.deepEqual(switched, []);
      assert.equal(ollama.asked.length, 2);
      assert.ok(ollama.asked[1].tools, 'the second call is the full model with its tools');
      assert.equal(events.find((e) => e.type === 'token').content, 'Sorry, which light?');
    });

    it('still refuses a protected device the model names', async () => {
      globalThis.fetch = fakeOllama('turn on main valve').impl;
      const events = await run('turn on mian valve');
      assert.deepEqual(switched, []);
      assert.match(events.find((e) => e.type === 'token').content, /protected/);
    });

    it('switches when the full model fills in an empty timer, as small models do', async () => {
      // The rewrite says NONE, so the full model answers with a tool call.
      const replies: any[] = [
        { role: 'assistant', content: 'NONE' },
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'set_power_state', arguments: { alias: 'office lights', minutes: '0', state: 'on' } } }] },
        { role: 'assistant', content: 'Turned on the office lights.' },
      ];
      globalThis.fetch = (async () => new Response(JSON.stringify({ message: replies.shift() }), { status: 200 })) as unknown as typeof fetch;

      const events = await run('office please, lights, on');

      assert.deepEqual(switched, [{ ip: '10.0.0.1', state: true }]);
      const action = events.find((e) => e.type === 'action').action;
      assert.equal(action.result.success, true);
      assert.equal(action.result.minutes, undefined, 'no timer');
    });

    it('reads a timer as the model wrote it', () => {
      for (const none of [undefined, null, '', ' ', '0', 0, false]) assert.equal(nlp.timerMinutes(none), undefined, String(none));
      assert.equal(nlp.timerMinutes('6'), 6);
      assert.equal(nlp.timerMinutes(90), 90);
      assert.ok(Number.isNaN(nlp.timerMinutes('soon')), 'refused by the tool, not read as no timer');
      assert.equal(nlp.timerMinutes(-5), -5, 'refused by the tool');
    });

    it('makes a call the full model wrote out as text', async () => {
      const replies: any[] = [
        { role: 'assistant', content: 'NONE' },
        { role: 'assistant', content: '{"type":"function","function":"set_power_state","parameters":{"alias":"office lights","state":"on","minutes":"0"}}' },
        { role: 'assistant', content: 'The office lights are on.' },
      ];
      globalThis.fetch = (async () => new Response(JSON.stringify({ message: replies.shift() }), { status: 200 })) as unknown as typeof fetch;

      const events = await run('office please, lights, on');

      assert.deepEqual(switched, [{ ip: '10.0.0.1', state: true }]);
      assert.equal(events.find((e) => e.type === 'token').content, 'The office lights are on.');
    });

    it('never shows a call too garbled to make', async () => {
      const replies: any[] = [
        { role: 'assistant', content: 'NONE' },
        { role: 'assistant', content: '{"type":"function","function":"set_power_state","parameters":{"alias":"Brendens room",state":"on"}}' },
      ];
      globalThis.fetch = (async () => new Response(JSON.stringify({ message: replies.shift() }), { status: 200 })) as unknown as typeof fetch;

      const events = await run('office please, lights, on');

      assert.deepEqual(switched, []);
      const said = events.find((e) => e.type === 'token').content as string;
      assert.equal(said, nlp.NOT_UNDERSTOOD);
      assert.doesNotMatch(said, /set_power_state|\{/);
    });

    it("gives the chat model the home's names, and caps its replies", async () => {
      const prompt = nlp.buildSystemPrompt();
      assert.match(prompt, /- Office lights\n- Kitchen lights\n- Main Valve/);
      assert.ok(prompt.indexOf('- Office lights') < prompt.indexOf("Today's date"), 'the date, which changes daily, comes last');
      assert.match(nlp.buildSystemPrompt([]), /\(none yet\)/);

      const ollama = fakeOllama('NONE', 'Hello!');
      globalThis.fetch = ollama.impl;
      await run('hi there');
      assert.equal(ollama.asked[1].options.num_predict, nlp.MAX_REPLY_TOKENS);
      assert.match(ollama.asked[1].messages[0].content, /- Office lights/);
    });

    /** NONE from the rewrite, then the full model's tool call, then its answer. */
    const fullModel = (call: Record<string, unknown>, answer = 'Done.') => {
      const replies: any[] = [
        { role: 'assistant', content: 'NONE' },
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'set_power_state', arguments: call } }] },
        { role: 'assistant', content: answer },
      ];
      const asked: any[] = [];
      globalThis.fetch = (async (_u: string, init: any) => {
        asked.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ message: replies.shift() }), { status: 200 });
      }) as unknown as typeof fetch;
      return asked;
    };

    it("switches a whole room the model names, except what's protected", async () => {
      db.prepare("UPDATE devices SET room = 'Downstairs'").run();
      try {
        fullModel({ alias: 'Downstairs', state: 'off' });
        const events = await run('everything downstairs of please');
        assert.deepEqual(switched.map((s) => s.ip).sort(), ['10.0.0.1', '10.0.0.2'], 'both lights, not the valve');
        const action = events.find((e) => e.type === 'action').action;
        assert.equal(action.result.success, true);
        assert.match(action.result.alias, /Office lights/);
        assert.match(action.result.alias, /Kitchen lights/);
      } finally {
        db.prepare('UPDATE devices SET room = NULL').run();
      }
    });

    it('switches nothing now for something asked for later, and tells the model why', async () => {
      const asked = fullModel({ alias: 'Office lights', state: 'on' }, 'I can set that up as a schedule.');
      const events = await run('turn on office lights every day at sunset');
      assert.deepEqual(switched, []);
      assert.match(events.find((e) => e.type === 'action').action.result.error, /create_schedule/);
      assert.match(asked.at(-1).messages.at(-1).content, /Nothing was switched/, 'the model hears it');
    });

    it('never says something was switched when nothing was', async () => {
      // Seen on the Pi: no tool call, only the claim.
      const ollama = fakeOllama('NONE', "Brenden's room lights are now on.");
      globalThis.fetch = ollama.impl;
      const events = await run('turn on brendan freaking lights');
      assert.deepEqual(switched, []);
      const said = events.find((e) => e.type === 'token').content as string;
      assert.match(said, /^I didn't switch anything/);
      assert.equal(ollama.asked[1].options.temperature, 0, 'tool decisions at temperature 0');
    });

    it("says why when a switch failed, whatever the model's answer claims", async () => {
      const replies: any[] = [
        { role: 'assistant', content: 'NONE' },
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'set_power_state', arguments: { alias: 'Garden fountain', state: 'on' } } }] },
        { role: 'assistant', content: 'Done! The garden fountain has been turned on.' },
      ];
      globalThis.fetch = (async () => new Response(JSON.stringify({ message: replies.shift() }), { status: 200 })) as unknown as typeof fetch;
      const events = await run('fountain on pls');
      assert.deepEqual(switched, []);
      const said = events.filter((e) => e.type === 'token').map((e) => e.content).join('');
      assert.equal(said, `I didn't switch anything. Device "Garden fountain" not found.`);
    });

    it('never asks the model when the rules understand', async () => {
      const ollama = fakeOllama();
      globalThis.fetch = ollama.impl;
      await run('turn on office lights');
      assert.equal(ollama.asked.length, 0);
      assert.deepEqual(switched, [{ ip: '10.0.0.1', state: true }]);
    });
  });
});
