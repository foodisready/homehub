/**
 * The layer over ring-client-api, with stand-ins for the library's objects
 * shaped like the ones in ring-client-api 14.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RingAuthError, libraryPartsForTests as lib, type RingEvent } from './ring-client';

/** Like RingRestClient: getAuth throws and notes using2fa and promptFor2fa when Ring wants a code. */
function restClient(behaviour: (code?: string) => { token?: string; status?: number; error?: string; prompt?: string }) {
  const client = {
    using2fa: false,
    promptFor2fa: undefined as string | undefined,
    async getAuth(code?: string) {
      const r = behaviour(code);
      if (r.token) return { refresh_token: r.token };
      if (r.prompt !== undefined) { client.using2fa = true; client.promptFor2fa = r.prompt; }
      throw new Error(r.error ?? 'failed');
    },
  };
  return client;
}

describe('Ring library layer', () => {
  it('turns Ring\'s request for a code into a question, and the code into a token', async () => {
    const client = restClient((code) => (code === '123456' ? { token: 'wrapped' } : code
      ? { prompt: 'Invalid 2fa code entered.  Please try again.', error: 'Verification Code is invalid or expired' }
      : { prompt: 'Please enter the code sent to ***-***-1234 via sms', error: 'Your Ring account is configured to use 2-factor authentication (2fa).' }));
    assert.deepEqual(await lib.attempt(client), { done: false, prompt: 'sent to ***-***-1234 by text message' });
    await assert.rejects(lib.attempt(client, '000000'), (err: Error) => err instanceof RingAuthError && /code didn't work/.test(err.message));
    assert.deepEqual(await lib.attempt(client, '123456'), { done: true, token: 'wrapped' });
  });

  it('words the other prompts and failures for people', async () => {
    const app = restClient(() => ({ prompt: 'Please enter the code from your authenticator app', error: '2fa' }));
    assert.deepEqual(await lib.attempt(app), { done: false, prompt: 'from your authenticator app' });
    const generic = restClient(() => ({ prompt: 'Please enter the code sent to your text/email', error: '2fa' }));
    assert.deepEqual(await lib.attempt(generic), { done: false, prompt: 'sent to your phone or email' });

    const wrong = restClient(() => ({ error: 'Failed to fetch oauth token from Ring. Verify that your email and password are correct. (error: invalid_grant)' }));
    await assert.rejects(lib.attempt(wrong), (err: Error) => err instanceof RingAuthError && /didn't accept that email and password/.test(err.message));
    const many = restClient(() => ({ error: 'Failed to fetch oauth token from Ring. You have requested too many 2fa codes.' }));
    await assert.rejects(lib.attempt(many), /too many codes/);
    const offline = restClient(() => ({ error: 'fetch failed' }));
    await assert.rejects(lib.attempt(offline), (err: Error) => !(err instanceof RingAuthError) && /Couldn't reach Ring: fetch failed/.test(err.message));
  });

  it('reads a camera and its doorbell and motion notifications', async () => {
    const subscribers: ((n: unknown) => void)[] = [];
    const camera = {
      id: 42, name: 'Front Door', model: 'Wired Doorbell Plus', isDoorbot: true, hasBattery: false, isOffline: false,
      onNewNotification: {
        subscribe(fn: (n: unknown) => void) { subscribers.push(fn); return { unsubscribe: () => subscribers.splice(subscribers.indexOf(fn), 1) }; },
      },
      async getSnapshot(opts?: { uuid: string }) { return new Uint8Array([0xff, 0xd8, opts ? 1 : 0]); },
    };
    const cam = lib.toCam(camera, 'Lake house');
    assert.deepEqual([cam.id, cam.name, cam.home, cam.model, cam.isDoorbell, cam.hasBattery, cam.offline], [42, 'Front Door', 'Lake house', 'Wired Doorbell Plus', true, false, false]);
    assert.equal(lib.toCam(camera).home, null);
    assert.deepEqual([...await cam.snapshot('u1')], [0xff, 0xd8, 1]);
    assert.deepEqual([...await cam.snapshot()], [0xff, 0xd8, 0]);

    const events: RingEvent[] = [];
    const stop = cam.onEvent((e) => events.push(e));
    const note = (category: string, extra: Record<string, unknown> = {}) => ({
      android_config: { category, body: '' },
      data: { device: { id: 42, e2ee_enabled: false }, event: { ding: { id: '7319', created_at: '2026-11-07T19:00:00Z', subtype: 'ding' } } },
      img: { snapshot_uuid: 'snap-1' },
      ...extra,
    });
    subscribers.forEach((s) => s(note('com.ring.pn.live-event.ding')));
    subscribers.forEach((s) => s({ ...note('com.ring.pn.live-event.motion'), data: { device: { id: 42, e2ee_enabled: true }, event: { ding: { id: '7320', created_at: 'bad', subtype: 'human', detection_type: 'human' } } } }));
    subscribers.forEach((s) => s(note('com.ring.push.HANDLE_NEW_USER_SOUND_SIREN')));   // not ours
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], { kind: 'ding', id: '7319', at: Date.parse('2026-11-07T19:00:00Z'), snapshotUuid: 'snap-1', detection: undefined, encrypted: false });
    assert.equal(events[1].kind, 'motion');
    assert.equal(events[1].detection, 'human');
    assert.equal(events[1].encrypted, true);
    assert.ok(Math.abs(events[1].at - Date.now()) < 5000);   // a bad time becomes now
    stop();
    assert.equal(subscribers.length, 0);
  });
});
