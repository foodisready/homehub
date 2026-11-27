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

  it('takes only an offer that sends and receives sound', () => {
    assert.equal(checkOffer(OFFER), OFFER);
    const v = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';
    const audio = (dir: string) => `m=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=${dir}\r\n`;
    for (const bad of [
      undefined, 42, 'hello', v,
      v + 'm=video 9 UDP 96\r\na=recvonly\r\n',
      // Sending video, or only sending, would make it a source for the camera's stream.
      v + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\n' + audio('recvonly'),
      v + audio('sendonly'),
      v + audio('sendrecv') + audio('recvonly'),
      v + 'm=audio 9 UDP/TLS/RTP/SAVPF 0\r\n',                                 // no direction: both ways
      v + 'm=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=recvonly\r\na=sendonly\r\n',      // two
      v + audio('recvonly').repeat(5),
      // A section hidden behind a lone CR, which another parser may take as a line break.
      v + audio('recvonly').replace(/\r\n$/, '\rm=video 9 UDP/TLS/RTP/SAVPF 96\ra=sendonly\r\n'),
      v + audio('recvonly') + 'a=tool:x\x00\r\n',
      v + 'a=sendonly\r\n' + audio('recvonly'),                                 // for the whole session
      v + audio('recvonly').replace('a=recvonly', 'a=recvonly:1'),
      v + audio('recvonly') + 'm=video 0 UDP/TLS/RTP/SAVPF 96\r\na=inactive\r\n',
      v + audio('recvonly') + 'x'.repeat(20_000),
    ]) {
      assert.throws(() => checkOffer(bad), (e: TalkError) => e.status === 400, String(bad).slice(0, 80));
    }
  });

  it('reads a speaker from go2rtc\'s stream state', () => {
    assert.equal(hasSpeaker(PAN), true);
    assert.equal(hasSpeaker(MUTE), false);
    assert.equal(hasSpeaker({ producers: [] }), false);
    assert.equal(hasSpeaker(null), false);
  });
});
