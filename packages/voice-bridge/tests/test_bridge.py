"""Run from packages/voice-bridge: python -m unittest discover tests

No real speakers, HomeHub or speech models are used: HomeHub is a local stub
server, and the speaker is a fake ESPHome client."""
from __future__ import annotations

import asyncio
import http.server
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from homehub_voice import config as cfg
from homehub_voice.endpoint import BYTES_PER_SECOND, Endpointer
from homehub_voice.homehub import CommandResult, HomeHub, HomeHubError
from homehub_voice.pipeline import NO_HOMEHUB, NOT_CAUGHT, NOTHING_HEARD, answer


def tone(seconds: float, loud: bool) -> bytes:
    n = int(16000 * seconds)
    if not loud:
        return bytes(n * 2)
    return (np.sin(np.arange(n) * 0.2) * 8000).astype(np.int16).tobytes()


def chunks(audio: bytes, size: int = 1024):
    for i in range(0, len(audio), size):
        yield audio[i : i + size]


class ConfigTest(unittest.TestCase):
    def test_speakers(self):
        s = cfg.parse_speakers('10.0.0.5, kitchen.local:6054 10.0.0.9|abc=')
        self.assertEqual([(x.host, x.port, x.key) for x in s], [('10.0.0.5', 6053, None), ('kitchen.local', 6054, None), ('10.0.0.9', 6053, 'abc=')])
        with self.assertRaises(cfg.ConfigError):
            cfg.parse_speakers('host:notaport')

    def test_needs_url_and_key(self):
        with self.assertRaises(cfg.ConfigError):
            cfg.load({})
        with self.assertRaises(cfg.ConfigError):
            cfg.load({'HOMEHUB_URL': 'http://x:3000'})

    def test_key_from_file(self):
        with tempfile.NamedTemporaryFile('w', delete=False) as f:
            f.write('secret-value\n')
        c = cfg.load({'HOMEHUB_URL': 'http://x:3000/', 'HOMEHUB_INTERNAL_KEY_FILE': f.name, 'DISCOVER': 'off'})
        self.assertEqual(c.internal_key, 'secret-value')
        self.assertEqual(c.homehub_url, 'http://x:3000')
        self.assertFalse(c.discover)
        Path(f.name).unlink()


class EndpointTest(unittest.TestCase):
    def feed(self, audio: bytes) -> Endpointer:
        e = Endpointer()
        for c in chunks(audio):
            if e.add(c):
                break
        return e

    def test_speech_then_quiet(self):
        e = self.feed(tone(0.5, False) + tone(1.2, True) + tone(3, False))
        self.assertTrue(e.done and e.spoke)
        self.assertAlmostEqual(e.seconds, 0.5 + 1.2 + 0.8, delta=0.1)

    def test_a_pause_after_a_short_start_doesnt_end_it(self):
        # "Mở đèn" (0.7 s), a 1-second pause, then "nhà bếp": 0.8 s of quiet used to end it after "đèn".
        e = self.feed(tone(0.5, False) + tone(0.7, True) + tone(1.0, False) + tone(0.6, True) + tone(3, False))
        self.assertAlmostEqual(e.voiced, 1.3, delta=0.1)
        self.assertAlmostEqual(e.seconds, 0.5 + 0.7 + 1.0 + 0.6 + 0.8, delta=0.1)

    def test_a_short_command_waits_a_little_longer(self):
        e = self.feed(tone(0.5, False) + tone(0.7, True) + tone(3, False))
        self.assertAlmostEqual(e.seconds, 0.5 + 0.7 + 1.3, delta=0.1)

    def test_nobody_speaks(self):
        e = self.feed(tone(10, False))
        self.assertTrue(e.done)
        self.assertFalse(e.spoke)
        self.assertAlmostEqual(e.seconds, 4.0, delta=0.1)

    def test_longest_command(self):
        e = self.feed(tone(20, True))
        self.assertAlmostEqual(e.seconds, 8.0, delta=0.1)

    def test_wake_word_tail_ignored(self):
        # A loud start (the wake word's end) followed by silence isn't speech.
        e = self.feed(tone(0.3, True) + tone(10, False))
        self.assertFalse(e.spoke)


class FakeListener:
    def __init__(self, text: str):
        self.text = text
        self.names_seen: list[str] | None = None

    def transcribe(self, audio, names):
        self.names_seen = names
        return self.text


class FakeHomeHub:
    names = ['Office Lamp']

    def __init__(self, fail=False):
        self.fail = fail
        self.sent: list[str] = []

    def command(self, text, retry=False):
        if self.fail:
            raise HomeHubError('down')
        self.sent.append(text)
        return CommandResult(True, 'Office Lamp is on.')


class PipelineTest(unittest.TestCase):
    def test_command(self):
        l, h = FakeListener('Turn on the office lamp.'), FakeHomeHub()
        a = answer(b'x', True, l, h)
        self.assertEqual((a.heard, a.reply, a.handled), ('Turn on the office lamp.', 'Office Lamp is on.', True))
        self.assertEqual(l.names_seen, ['Office Lamp'])
        self.assertEqual(h.sent, ['Turn on the office lamp.'])

    def test_silence_skips_everything(self):
        l, h = FakeListener('should not run'), FakeHomeHub()
        self.assertEqual(answer(b'', False, l, h).reply, NOTHING_HEARD)
        self.assertIsNone(l.names_seen)

    def test_nothing_recognised(self):
        h = FakeHomeHub()
        self.assertEqual(answer(b'x', True, FakeListener(' . '), h).reply, NOT_CAUGHT)
        self.assertEqual(h.sent, [])

    def test_homehub_down(self):
        a = answer(b'x', True, FakeListener('turn on the lamp'), FakeHomeHub(fail=True))
        self.assertEqual(a.reply, NO_HOMEHUB)
        self.assertFalse(a.handled)


class StubHomeHub(http.server.BaseHTTPRequestHandler):
    seen: list[tuple[str, str | None, dict | None]] = []

    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        StubHomeHub.seen.append((self.path, self.headers.get('X-Internal-Key'), None))
        if self.headers.get('X-Internal-Key') != 'k':
            return self._send(401, {'error': 'no'})
        self._send(200, {'names': ['Office Lamp', 'Goodnight'], 'version': 'v1'})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        StubHomeHub.seen.append((self.path, self.headers.get('X-Internal-Key'), body))
        if self.path.endswith('/status'):
            return self._send(200, {'ok': True, 'namesVersion': 'v2', 'restart': False})
        if 'garage' in body.get('text', ''):
            return self._send(200, {'handled': True, 'response': "I couldn't reach Garage.", 'actions': [
                {'tool': 'set_power_state', 'args': {'alias': 'Garage', 'state': 'on'}, 'result': {'error': 'timeout'}}]})
        self._send(200, {'handled': True, 'response': 'Done.', 'actions': []})

    def log_message(self, *a):
        pass


class HomeHubClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), StubHomeHub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_address[1]}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_names_and_command(self):
        h = HomeHub(self.url, 'k')
        self.assertEqual(h.refresh_names(), ['Office Lamp', 'Goodnight'])
        self.assertEqual(h.names_version, 'v1')
        self.assertEqual(h.command('turn on garage').failed, ['Garage'])
        self.assertEqual(h.command('turn on office lamp'), CommandResult(True, 'Done.'))
        self.assertEqual(StubHomeHub.seen[-1], ('/internal/voice/command', 'k', {'text': 'turn on office lamp'}))

    def test_report(self):
        res = HomeHub(self.url, 'k').report('0.1.0', [{'name': 'Tablet', 'address': '10.0.0.20', 'connected': True}])
        self.assertEqual((res['namesVersion'], res['restart']), ('v2', False))
        path, key, body = StubHomeHub.seen[-1]
        self.assertEqual((path, key), ('/internal/voice/status', 'k'))
        self.assertEqual(body['speakers'], [{'name': 'Tablet', 'address': '10.0.0.20', 'connected': True}])
        self.assertEqual((body['version'], body['state'], body['kind']), ('0.1.0', 'running', 'service'))
        self.assertEqual(len(body['id']), 12)

    def test_wrong_key_keeps_old_names(self):
        h = HomeHub(self.url, 'wrong')
        h.names = ['Old']
        self.assertEqual(h.refresh_names(), ['Old'])
        with self.assertRaises(HomeHubError):
            HomeHub('http://127.0.0.1:9', 'k', timeout=2).command('x')


class FakeClient:
    """Stands in for aioesphomeapi.APIClient: one voice speaker."""

    instances: list['FakeClient'] = []
    voice_flags = 1

    def __init__(self, host, port, password, **kw):
        self.events = []
        self.on_stop = None
        self.handlers = None
        FakeClient.instances.append(self)

    async def connect(self, on_stop, login):
        self.on_stop = on_stop

    async def device_info(self):
        return mock.Mock(friendly_name='Test Speaker', name='test', voice_assistant_feature_flags=FakeClient.voice_flags)

    def subscribe_voice_assistant(self, **handlers):
        self.handlers = handlers

    async def get_voice_assistant_configuration(self, timeout):
        return None

    def send_voice_assistant_event(self, kind, data):
        self.events.append((kind.name, data))

    async def disconnect(self):
        pass


class SpeakerLinkTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        FakeClient.instances.clear()
        FakeClient.voice_flags = 1

    async def connected_link(self, answer_fn):
        from homehub_voice import speakers

        link = speakers.SpeakerLink(cfg.Speaker('10.0.0.5'), answer_fn, lambda text, host, lang='en': f'http://me/{len(text)}.wav', listed=True)
        with mock.patch.object(speakers.api, 'APIClient', FakeClient):
            link.start()
            for _ in range(50):
                await asyncio.sleep(0.01)
                if FakeClient.instances and FakeClient.instances[0].handlers:
                    break
        return link, FakeClient.instances[0]

    async def test_one_command(self):
        heard = []

        def answer_fn(audio, spoke, asked=None, prefer=None):
            heard.append((len(audio), spoke))
            return mock.Mock(heard='turn on office lamp', reply='Office Lamp is on.', handled=True, stt_s=0.1, homehub_s=0.1, lang='en', asked=None)

        link, c = await self.connected_link(answer_fn)
        self.assertEqual(link.name, 'Test Speaker')
        self.assertTrue(link.connected)
        port = await c.handlers['handle_start']('conv1', 0, None, 'okay nabu')
        self.assertEqual(port, 0)
        for ch in chunks(tone(0.5, False) + tone(1, True) + tone(2, False)):
            await c.handlers['handle_audio'](ch, None)
        for _ in range(100):
            await asyncio.sleep(0.01)
            if c.events and c.events[-1][0] == 'VOICE_ASSISTANT_RUN_END':
                break
        kinds = [k for k, _ in c.events]
        self.assertEqual(kinds, [
            'VOICE_ASSISTANT_RUN_START', 'VOICE_ASSISTANT_STT_START', 'VOICE_ASSISTANT_STT_VAD_START',
            'VOICE_ASSISTANT_STT_VAD_END', 'VOICE_ASSISTANT_STT_END', 'VOICE_ASSISTANT_INTENT_START',
            'VOICE_ASSISTANT_INTENT_END', 'VOICE_ASSISTANT_TTS_START', 'VOICE_ASSISTANT_TTS_END', 'VOICE_ASSISTANT_RUN_END',
        ])
        self.assertEqual(dict(c.events)['VOICE_ASSISTANT_STT_END'], {'text': 'turn on office lamp'})
        self.assertEqual(dict(c.events)['VOICE_ASSISTANT_TTS_END'], {'url': 'http://me/18.wav'})
        self.assertEqual(heard[0][1], True)
        self.assertAlmostEqual(heard[0][0] / BYTES_PER_SECOND, 2.3, delta=0.1)
        self.assertNotIn('continue_conversation', dict(c.events)['VOICE_ASSISTANT_INTENT_END'])
        link.task.cancel()

    async def say(self, c, n, wake=None):
        c.events.clear()
        await c.handlers['handle_start'](f'conv{n}', 0, None, wake)
        for ch in chunks(tone(0.5, False) + tone(1, True) + tone(2, False)):
            await c.handlers['handle_audio'](ch, None)
        for _ in range(200):
            await asyncio.sleep(0.01)
            if c.events and c.events[-1][0] == 'VOICE_ASSISTANT_RUN_END':
                return dict(c.events)

    async def test_a_vietnamese_wake_word_asks_for_vietnamese(self):
        langs = []

        def answer_fn(audio, spoke, asked=None, prefer=None):
            langs.append(prefer)
            return mock.Mock(heard='bật đèn bếp', reply='Đã bật đèn bếp.', handled=True, stt_s=0, homehub_s=0, lang='vi', asked=None)

        link, c = await self.connected_link(answer_fn)
        await self.say(c, 1, 'Xin Chào')
        await self.say(c, 2, 'Okay Nabu')
        await self.say(c, 3)
        self.assertEqual(langs, ['vi', None, None])
        link.task.cancel()

    async def test_talk_that_never_stops_gets_no_reply(self):
        # From the tablet, 2026-11-13: "Hey Woman" woken by a TV, then eight seconds of its talk,
        # answered "I heard words, just not ones I know. Try again?".
        handled = [False]

        def answer_fn(audio, spoke, asked=None, prefer=None):
            return mock.Mock(heard="I don't want to pay for your drink.", reply="Sorry, I didn't understand that.",
                             handled=handled[0], stt_s=0, homehub_s=0, lang='en', asked=None)

        async def talk(c, n):
            c.events.clear()
            await c.handlers['handle_start'](f'tv{n}', 0, None, 'Hey Woman')
            for ch in chunks(tone(0.3, False) + tone(9, True)):
                await c.handlers['handle_audio'](ch, None)
            for _ in range(300):
                await asyncio.sleep(0.01)
                if c.events and c.events[-1][0] == 'VOICE_ASSISTANT_RUN_END':
                    return dict(c.events)

        link, c = await self.connected_link(answer_fn)
        quiet = await talk(c, 1)
        self.assertNotIn('VOICE_ASSISTANT_TTS_START', quiet)
        # A command in it is still carried out, and said so.
        handled[0] = True
        done = await talk(c, 2)
        self.assertIn('VOICE_ASSISTANT_TTS_START', done)
        # An ordinary command that isn't understood still gets "Sorry".
        handled[0] = False
        short = await self.say(c, 3)
        self.assertIn('VOICE_ASSISTANT_TTS_START', short)
        link.task.cancel()

    def test_background_talk(self):
        from homehub_voice.speakers import background_talk
        self.assertTrue(background_talk(8.0, 7.6))
        self.assertFalse(background_talk(8.0, 5.2), 'someone pausing as they speak')
        self.assertFalse(background_talk(3.5, 3.4), 'a command, however much of it is voiced')

    async def test_a_question_keeps_listening_and_its_answer_gets_the_name(self):
        from homehub_voice import speakers
        given, langs = [], []

        def answer_fn(audio, spoke, asked=None, prefer=None):
            given.append(asked)
            langs.append(prefer)
            if asked is None:   # the light's name alone: ask
                return mock.Mock(heard='廚房燈', reply='你想開定熄廚房燈？', handled=False, stt_s=0, homehub_s=0, lang='yue', asked='廚房燈')
            return mock.Mock(heard='開', reply='開咗廚房燈。', handled=True, stt_s=0, homehub_s=0, lang='yue', asked=None)

        link, c = await self.connected_link(answer_fn)
        first = await self.say(c, 1)
        self.assertEqual(first['VOICE_ASSISTANT_INTENT_END'].get('continue_conversation'), '1')
        second = await self.say(c, 2)
        self.assertEqual(given, [None, '廚房燈'])   # the follow-up knows what was asked
        self.assertEqual(langs, [None, 'yue'], 'and in which language')
        self.assertNotIn('continue_conversation', second['VOICE_ASSISTANT_INTENT_END'])
        await self.say(c, 3)   # so it asks again
        self.assertEqual(given[-1], None, 'answered once, then forgotten')

        # Too late: the question is forgotten.
        link.asked = (link.asked[0], link.asked[1] - speakers.FOLLOW_UP_S - 1, link.asked[2])
        await self.say(c, 4)
        self.assertEqual(given[-1], None)
        link.task.cancel()

    async def test_woken_by_a_noise_it_stays_quiet(self):
        def answer_fn(audio, spoke, asked=None, prefer=None):
            return mock.Mock(heard='', reply="Sorry, I didn't catch that.", handled=False, stt_s=0, homehub_s=0, lang='en', asked=None)

        link, c = await self.connected_link(answer_fn)
        events = await self.say(c, 1)
        self.assertNotIn('VOICE_ASSISTANT_TTS_START', events)
        self.assertNotIn('VOICE_ASSISTANT_ERROR', events)
        self.assertEqual(c.events[-1][0], 'VOICE_ASSISTANT_RUN_END', 'the run still ends')
        link.task.cancel()

    async def test_failure_still_ends_run(self):
        def boom(audio, spoke, asked=None, prefer=None):
            raise RuntimeError('whisper crashed')

        link, c = await self.connected_link(boom)
        await c.handlers['handle_start']('conv1', 0, None, None)
        await c.handlers['handle_stop'](False)
        for _ in range(100):
            await asyncio.sleep(0.01)
            if c.events and c.events[-1][0] == 'VOICE_ASSISTANT_RUN_END':
                break
        kinds = [k for k, _ in c.events]
        self.assertIn('VOICE_ASSISTANT_ERROR', kinds)
        self.assertEqual(kinds[-1], 'VOICE_ASSISTANT_RUN_END')
        link.task.cancel()

    async def test_only_the_loudest_of_two_speakers_answers(self):
        from homehub_voice import speakers

        answered = []

        def answer_fn(audio, spoke, asked=None, prefer=None):
            answered.append(len(audio))
            return mock.Mock(heard='turn on office lamp', reply='Office Lamp is on.', handled=True, stt_s=0, homehub_s=0, lang='en', asked=None)

        one = speakers.OneAnswers()
        links, clients = [], []
        with mock.patch.object(speakers.api, 'APIClient', FakeClient):
            for host in ('10.0.0.5', '10.0.0.6'):
                link = speakers.SpeakerLink(cfg.Speaker(host), answer_fn, lambda t, h, lang='en': 'http://me/r.wav', listed=True, one_answers=one)
                link.start()
                links.append(link)
            for _ in range(50):
                await asyncio.sleep(0.01)
                if len(FakeClient.instances) == 2 and all(c.handlers for c in FakeClient.instances):
                    break
        near, far = FakeClient.instances

        def speech(volume):
            loud = (np.sin(np.arange(16000) * 0.2) * volume).astype(np.int16).tobytes()
            return tone(0.5, False) + loud + tone(2, False)

        def earlier_commands_were_long_ago():
            for r in one.runs:
                r.started -= 10

        async def say_both(first, second):
            earlier_commands_were_long_ago()
            for c in (first, second):
                c.events.clear()
            await first.handlers['handle_start']('a', 0, None, None)
            await second.handlers['handle_start']('b', 0, None, None)
            for a, b in zip(chunks(speech(9000 if first is near else 2000)), chunks(speech(9000 if second is near else 2000))):
                await first.handlers['handle_audio'](a, None)
                await second.handlers['handle_audio'](b, None)
            for _ in range(300):
                await asyncio.sleep(0.01)
                if all(c.events and c.events[-1][0] == 'VOICE_ASSISTANT_RUN_END' for c in (near, far)):
                    break

        # Whichever wakes first, the nearer (louder) speaker answers and the other goes quiet.
        for first, second in ((far, near), (near, far)):
            answered.clear()
            await say_both(first, second)
            self.assertEqual(len(answered), 1, 'the command is carried out once')
            self.assertIn('VOICE_ASSISTANT_TTS_END', [k for k, _ in near.events])
            far_kinds = [k for k, _ in far.events]
            self.assertNotIn('VOICE_ASSISTANT_TTS_START', far_kinds)
            self.assertEqual(far_kinds[-1], 'VOICE_ASSISTANT_RUN_END', 'the quiet one still ends its run')

        # A speaker alone isn't held up.
        earlier_commands_were_long_ago()
        answered.clear()
        far.events.clear()
        await far.handlers['handle_start']('c', 0, None, None)
        for ch in chunks(speech(2000)):
            await far.handlers['handle_audio'](ch, None)
        for _ in range(300):
            await asyncio.sleep(0.01)
            if far.events and far.events[-1][0] == 'VOICE_ASSISTANT_RUN_END':
                break
        self.assertIn('VOICE_ASSISTANT_TTS_END', [k for k, _ in far.events])
        for link in links:
            link.task.cancel()

    async def test_not_a_speaker_is_left_alone(self):
        FakeClient.voice_flags = 0
        from homehub_voice import speakers

        link = speakers.SpeakerLink(cfg.Speaker('10.0.0.6'), lambda a, s: None, lambda t, h: '', listed=False)
        with mock.patch.object(speakers.api, 'APIClient', FakeClient):
            link.start()
            await asyncio.wait_for(link.task, 2)  # returns instead of reconnecting
        self.assertIsNone(FakeClient.instances[0].handlers)
        self.assertFalse(link.usable)

    async def test_status_lists_speakers_only(self):
        from homehub_voice import speakers

        made = []

        def make(s, listed):
            link = speakers.SpeakerLink(s, lambda a, sp: None, lambda t, h: '', listed)
            link.start = lambda: None  # no connection in this test
            made.append(link)
            return link

        group = speakers.Speakers([], make, discover=False)
        group.add(cfg.Speaker('10.0.0.5'), True)
        group.add(cfg.Speaker('10.0.0.6'), False)
        group.add(cfg.Speaker('10.0.0.5'), False)  # the same one, found again
        self.assertEqual(len(made), 2)
        self.assertTrue(group.changed.is_set())
        made[0].connected = True
        made[1].usable = False
        self.assertEqual(group.status(), [{'name': '10.0.0.5', 'address': '10.0.0.5', 'connected': True}])




class EnglishVoiceTest(unittest.TestCase):
    def test_the_research_only_voice_is_removed_and_the_new_one_kept(self):
        from homehub_voice import models
        with tempfile.TemporaryDirectory() as d:
            folder = Path(d)
            for name in ['en_US-ljspeech-medium.onnx', 'en_US-ljspeech-medium.onnx.json', *models.OLD_VOICES]:
                (folder / name).write_text('x')
            with mock.patch.object(models, '_fetch') as fetch:
                models.piper_voice(folder / 'en_US-ljspeech-medium.onnx')
            fetch.assert_not_called()   # already there: nothing downloaded
            self.assertEqual(sorted(p.name for p in folder.iterdir()),
                             ['en_US-ljspeech-medium.onnx', 'en_US-ljspeech-medium.onnx.json'])

    def test_the_default_voice_is_public_domain(self):
        from homehub_voice import models
        self.assertIn('ljspeech', models.PIPER)


class CountingVoice:
    """A voice that writes a small WAV and counts what it was asked to say."""
    def __init__(self, model_file=None):
        self.said: list[str] = []
        self.model_file = model_file

    def say(self, text, path):
        import wave
        self.said.append(text)
        with wave.open(str(path), 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(text.encode() * 100)


class ReplyCacheTest(unittest.TestCase):
    def setUp(self):
        from homehub_voice.replies import ReplyServer
        self.tmp = Path(tempfile.mkdtemp())
        self.server = ReplyServer(0)
        self.addCleanup(self.server.close)

    def speak_fn(self, voices, folder=None, keep=500):
        from homehub_voice.replies import ReplyCache, speak_with
        return speak_with(self.server, ReplyCache(self.tmp / 'cache' if folder is None else folder, keep), voices)

    def served(self, url):
        return (self.server.dir / url.rsplit('/', 1)[1]).read_bytes()

    def test_a_reply_said_before_is_reused(self):
        en, yue = CountingVoice(), CountingVoice()
        speak = self.speak_fn({'en': en, 'yue': yue})
        first = speak('熄咗廚房燈。', '127.0.0.1', 'yue')
        again = speak('熄咗廚房燈。', '127.0.0.1', 'yue')
        self.assertEqual(yue.said, ['熄咗廚房燈。'], 'made once')
        self.assertNotEqual(first, again, 'each answer gets its own file to play')
        self.assertEqual(self.served(first), self.served(again))
        speak('開咗廚房燈。', '127.0.0.1', 'yue')
        speak('Kitchen lights is on.', '127.0.0.1')
        self.assertEqual(len(yue.said), 2)
        self.assertEqual(en.said, ['Kitchen lights is on.'])

    def test_kept_across_restarts_but_not_for_a_new_voice(self):
        model = self.tmp / 'voice.onnx'
        model.write_bytes(b'one')
        speak = self.speak_fn({'en': CountingVoice(model)})
        speak('Office lamp is off.', '127.0.0.1')
        after_restart = CountingVoice(model)
        self.speak_fn({'en': after_restart})('Office lamp is off.', '127.0.0.1')
        self.assertEqual(after_restart.said, [])
        model.write_bytes(b'a new voice')
        new_voice = CountingVoice(model)
        self.speak_fn({'en': new_voice})('Office lamp is off.', '127.0.0.1')
        self.assertEqual(new_voice.said, ['Office lamp is off.'])

    def test_the_least_recently_used_are_dropped(self):
        import os
        import time as t
        voice = CountingVoice()
        speak = self.speak_fn({'en': voice}, keep=2)
        speak('one', '127.0.0.1')
        speak('two', '127.0.0.1')
        cache = self.tmp / 'cache'
        for i, f in enumerate(sorted(cache.glob('*.wav'), key=lambda f: f.stat().st_mtime)):
            os.utime(f, (t.time() - 100 + i, t.time() - 100 + i))   # 'one' older than 'two'
        speak('one', '127.0.0.1')     # used again: now the newest
        speak('three', '127.0.0.1')   # so 'two' goes
        self.assertEqual(len(list(cache.glob('*.wav'))), 2)
        speak('one', '127.0.0.1')
        speak('two', '127.0.0.1')
        self.assertEqual(voice.said, ['one', 'two', 'three', 'two'])

    def test_a_folder_that_cant_be_used_only_means_replies_are_made_each_time(self):
        blocked = self.tmp / 'a-file'
        blocked.write_text('not a folder')
        voice = CountingVoice()
        speak = self.speak_fn({'en': voice}, folder=blocked / 'cache')
        url = speak('hello', '127.0.0.1')
        speak('hello', '127.0.0.1')
        self.assertEqual(voice.said, ['hello', 'hello'])
        self.assertGreater(len(self.served(url)), 44)

    def test_a_kept_reply_that_vanished_is_made_again(self):
        voice = CountingVoice()
        speak = self.speak_fn({'en': voice})
        speak('hello', '127.0.0.1')
        for f in (self.tmp / 'cache').glob('*.wav'):
            f.write_bytes(b'')   # cut short, say by a full disk
        url = speak('hello', '127.0.0.1')
        self.assertEqual(voice.said, ['hello', 'hello'])
        self.assertGreater(len(self.served(url)), 44)


class ProgressTest(unittest.TestCase):
    """What Settings → Voice control shows while the bridge downloads and loads its models."""

    def test_progress_text(self):
        from homehub_voice.models import Progress
        p = Progress()
        self.assertEqual(p.text(), '')
        p.start('Downloading the Vietnamese voice')
        self.assertEqual(p.text(), 'Downloading the Vietnamese voice')
        p.total, p.done = 60_000_000, 27_000_000
        self.assertEqual(p.text(), 'Downloading the Vietnamese voice: 45% of 60 MB')
        p.total, p.done = 0, 12_000_000
        self.assertEqual(p.text(), 'Downloading the Vietnamese voice: 12 MB so far')

    def test_check_in_says_languages_and_progress(self):
        from homehub_voice.homehub import HomeHub
        h = HomeHub('http://h:3000', 'k')
        sent = []
        h._call = lambda path, body=None: sent.append((path, body)) or {}
        h.report('1.0', [], 'starting', ['en', 'vi'], 'Downloading the Vietnamese voice: 45% of 60 MB')
        h.report('1.0', [])
        self.assertEqual(sent[0][1]['languages'], ['en', 'vi'])
        self.assertEqual(sent[0][1]['detail'], 'Downloading the Vietnamese voice: 45% of 60 MB')
        self.assertNotIn('languages', sent[1][1])
        self.assertNotIn('detail', sent[1][1])


if __name__ == '__main__':
    unittest.main()


class SeveralDevicesTest(unittest.TestCase):
    """"Turn on the lights" fits every light: the speaker asks which, rather than reading them all out."""

    class Hub:
        names = ['Kitchen lights', 'Kitchen counter lights', 'Living room lamps']

        def __init__(self):
            self.sent = []

        def command(self, text, retry=False):
            from homehub_voice.homehub import CommandResult
            self.sent.append(text)
            if text.lower().rstrip('.').endswith(('the lights', 'lights for 10 minutes')) and 'kitchen' not in text.lower():
                return CommandResult(True, 'Which one do you mean: "Kitchen lights", "Kitchen counter lights", "Living room lamps"?')
            return CommandResult(True, f'Done: {text}')

    class Ears:
        def __init__(self, text):
            self.text = text

        def hear(self, audio):
            return 'en', self.text

        def transcribe(self, audio):
            return self.text

    class NoWhisper:
        def transcribe(self, audio, names):
            raise AssertionError('Whisper not needed')

    def test_asks_which_light_then_takes_the_name(self):
        from homehub_voice.pipeline import answer
        hub = self.Hub()
        a = answer(b'\0' * 32000, True, self.NoWhisper(), hub, self.Ears('Turn on the lights for 10 minutes.'))
        self.assertEqual((a.reply, a.handled), ('Which light?', False))
        self.assertTrue(a.asked.startswith('en-which:'))
        b = answer(b'\0' * 32000, True, self.NoWhisper(), hub, self.Ears('The kitchen.'), asked=a.asked, prefer='en')
        self.assertEqual(hub.sent[-1], 'turn on The kitchen for 10 minutes')
        self.assertTrue(b.handled)
        # Or the whole command again.
        c = answer(b'\0' * 32000, True, self.NoWhisper(), hub, self.Ears('Turn off kitchen lights.'), asked=a.asked, prefer='en')
        self.assertEqual(hub.sent[-1], 'Turn off kitchen lights.')

    def test_the_question_names_the_kind(self):
        from homehub_voice.pipeline import which_asked
        self.assertEqual(which_asked('Turn off the lamps')[0], 'Which lamp?')
        self.assertEqual(which_asked('turn on the lights for 5 minutes')[0], 'Which light?')
        self.assertEqual(which_asked('turn them off')[0], 'Which one?')

    def test_cantonese_is_not_held_up_by_the_vietnamese_model(self):
        # Both listen at once: SenseVoice doesn't wait for the Vietnamese model to finish.
        import threading
        from homehub_voice.pipeline import answer
        started = threading.Event()

        class SlowVietnamese:
            def transcribe(self, audio):
                self.saw_sensevoice_start = started.wait(2)
                return 'KHÔNG RÕ'

        class Cantonese:
            def hear(self, audio):
                started.set()
                return 'yue', '開廚房燈。'

            def transcribe(self, audio):
                return '開廚房燈。'

        class Hub:
            names = ['廚房燈']

            def command(self, text, retry=False):
                from homehub_voice.homehub import CommandResult
                return CommandResult(True, 'ok')

        viet = SlowVietnamese()
        a = answer(b'\0' * 32000, True, self.NoWhisper(), Hub(), Cantonese(), vi_ears=viet)
        self.assertTrue(viet.saw_sensevoice_start)
        self.assertEqual(a.lang, 'yue')

    def test_the_cantonese_pass_starts_before_the_first_pass_ends(self):
        import threading
        from homehub_voice.pipeline import answer
        second_started = threading.Event()

        class Cantonese:
            def hear(self, audio):
                self.overlapped = second_started.wait(2)
                return 'yue', '嗯。'   # unclear: the Cantonese pass is needed

            def transcribe(self, audio):
                second_started.set()
                return '開廚房燈。'

        class Hub:
            names = ['廚房燈']

            def command(self, text, retry=False):
                from homehub_voice.homehub import CommandResult
                self.text = text
                return CommandResult(True, 'ok')

        ears, hub = Cantonese(), Hub()
        a = answer(b'\0' * 32000, True, self.NoWhisper(), hub, ears, vi_ears=self.Ears('KHÔNG'))
        self.assertTrue(ears.overlapped)
        self.assertEqual((a.lang, a.passes, hub.text), ('yue', 2, 'turn on 廚房燈'))
