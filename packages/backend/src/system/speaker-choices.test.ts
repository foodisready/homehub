/**
 * A speaker's wake words and sensitivity, chosen in Settings → Voice control and set on the speaker by
 * the voice bridge. Against a temp SQLite DB. Modules load in before(), after DB_PATH is set.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-speaker-choices-test-'));

let db: Database.Database;
let bridge: typeof import('./voice-bridge');

const LEVELS = ['Slightly sensitive', 'Moderately sensitive', 'Very sensitive'];
const VOICE_PE = {
  name: 'HomeHub Voice 0adaaf', address: '192.168.86.64', connected: true, announce: true,
  wakeWords: [{ id: 'lao_you', name: '老友', on: true }, { id: 'xin_chao', name: 'Xin Chào', on: false }, { id: 'okay_nabu', name: 'Okay Nabu', on: true }],
  sensitivity: 'Slightly sensitive', sensitivities: LEVELS,
};
const AVA = { name: 'Android Voice Assistant', address: '192.168.86.20', connected: true, announce: true };
const report = (voicePe: object = VOICE_PE) =>
  bridge.recordBridgeReport({ state: 'running', id: 'b1', kind: 'docker', version: '0.1.0', speakers: [voicePe, AVA] });
const settingsSpeakers = () => bridge.bridgeForSettings(Date.now(), 60_000)!.speakers;

describe('a speaker\'s wake words and sensitivity', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    bridge = await import('./voice-bridge');
  });

  after(() => {
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('shows in Settings what the speaker says it has; Ava says nothing', () => {
    report();
    const [pe, ava] = settingsSpeakers();
    assert.deepEqual(pe.wakeWords, VOICE_PE.wakeWords);
    assert.equal(pe.sensitivity, 'Slightly sensitive');
    assert.deepEqual(pe.sensitivities, LEVELS);
    assert.equal(pe.applying, false);
    assert.deepEqual(ava, { name: 'Android Voice Assistant', connected: true });
  });

  it('saves a choice, gives it to the bridge, and says it\'s applying until the speaker has it', () => {
    report();
    bridge.chooseForSpeaker(VOICE_PE.name, { wakeWords: ['lao_you', 'not_a_word'] });
    bridge.chooseForSpeaker(VOICE_PE.name, { sensitivity: 'Moderately sensitive' });
    assert.deepEqual(bridge.speakerChoices(), { [VOICE_PE.name]: { wakeWords: ['lao_you'], sensitivity: 'Moderately sensitive' } });
    assert.equal(settingsSpeakers()[0].applying, true);
    // The bridge has set it: the speaker now says so.
    report({ ...VOICE_PE, sensitivity: 'Moderately sensitive', wakeWords: VOICE_PE.wakeWords.map((w) => ({ ...w, on: w.id === 'lao_you' })) });
    assert.equal(settingsSpeakers()[0].applying, false);
  });

  it('refuses what the speaker can\'t do', () => {
    report();
    const status = (fn: () => unknown) => { try { fn(); return 0; } catch (e) { return (e as InstanceType<typeof bridge.SpeakerChoiceError>).status; } };
    assert.equal(status(() => bridge.chooseForSpeaker(VOICE_PE.name, { wakeWords: [] })), 400, 'none on: it could never be woken');
    assert.equal(status(() => bridge.chooseForSpeaker(VOICE_PE.name, { sensitivity: 'Loud' })), 400);
    assert.equal(status(() => bridge.chooseForSpeaker(AVA.name, { wakeWords: ['okay_nabu'] })), 400, 'Ava doesn\'t say its wake words');
    assert.equal(status(() => bridge.chooseForSpeaker('Nobody', { wakeWords: ['lao_you'] })), 404);
  });
});
