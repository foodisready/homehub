import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NO_SPEAKER, TalkError, checkOffer, hasSpeaker, talkVia } from './talk';

const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 0 8\r\na=recvonly\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 0 8\r\na=sendonly\r\n';
const ANSWER = 'v=0\r\nanswer';

// What go2rtc said for a Wyze Pan v3, and for a camera with no speaker.
const PAN = { producers: [{ medias: ['video, recvonly, H264', 'audio, recvonly, PCML/8000/1', 'audio, sendonly, PCML/8000/1, PCMA/8000, PCMU/8000'] }] };
const MUTE = { producers: [{ medias: ['video, recvonly, H264', 'audio, recvonly, PCMA/8000'] }] };

function go2rtc(opts: { status?: number; body?: string; info?: unknown; down?: boolean } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (opts.down) throw new TypeError('fetch failed');
    if (url.includes('/api/webrtc')) {
      return new Response(opts.body ?? JSON.stringify({ type: 'answer', sdp: ANSWER }), { status: opts.status ?? 200 });
    }
    return new Response(JSON.stringify(opts.info ?? PAN));
  }) as typeof fetch;
  return { f, calls };
}

describe('talking through a camera', () => {
  it('passes the offer to go2rtc for the camera and gives back its answer', async () => {
    const { f, calls } = go2rtc();
    assert.equal(await talkVia('http://127.0.0.1:1984', 'kitchen island', OFFER, { fetch: f }), ANSWER);
    assert.equal(calls[0].url, 'http://127.0.0.1:1984/api/webrtc?src=kitchen%20island');
    assert.equal(calls[0].init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { type: 'offer', sdp: OFFER });
    assert.equal(calls[1].url, 'http://127.0.0.1:1984/api/streams?src=kitchen%20island');
  });

  it('says so for a camera with no speaker', async () => {
    const { f } = go2rtc({ info: MUTE });
    await assert.rejects(talkVia('http://g', 'cam', OFFER, { fetch: f }), (e: TalkError) => e.status === 409 && e.message === NO_SPEAKER);
    // The stream's state, however it's read.
    await assert.rejects(talkVia('http://g', 'cam', OFFER, { fetch: go2rtc().f, streamInfo: async () => { throw new Error('busy'); } }), /no speaker/);
  });

  it('says when the camera or go2rtc can\'t be reached', async () => {
    await assert.rejects(talkVia('http://g', 'cam', OFFER, { fetch: go2rtc({ down: true }).f }), (e: TalkError) => e.status === 503);
    const unreachable = go2rtc({ status: 500, body: 'streams: wyze: connect failed: discovery timeout' });
    await assert.rejects(talkVia('http://g', 'cam', OFFER, { fetch: unreachable.f }), /couldn't reach the camera/);
    await assert.rejects(talkVia('http://g', 'cam', OFFER, { fetch: go2rtc({ body: '{}' }).f }), /didn't start talking/);
  });

  it('takes only a WebRTC offer with audio', () => {
    assert.equal(checkOffer(OFFER), OFFER);
    for (const bad of [undefined, 42, 'hello', 'v=0\r\nm=video 9 UDP 96\r\n', 'v=0\r\nm=audio ' + 'x'.repeat(20_000)]) {
      assert.throws(() => checkOffer(bad), (e: TalkError) => e.status === 400);
    }
  });

  it('reads a speaker from go2rtc\'s stream state', () => {
    assert.equal(hasSpeaker(PAN), true);
    assert.equal(hasSpeaker(MUTE), false);
    assert.equal(hasSpeaker({ producers: [] }), false);
    assert.equal(hasSpeaker(null), false);
  });
});
