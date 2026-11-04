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

    def command(self, text):
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
        self._send(200, {'names': ['Office Lamp', 'Goodnight']})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        StubHomeHub.seen.append((self.path, self.headers.get('X-Internal-Key'), body))
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
        self.assertEqual(h.command('turn on office lamp'), CommandResult(True, 'Done.'))
        self.assertEqual(StubHomeHub.seen[-1], ('/internal/voice/command', 'k', {'text': 'turn on office lamp'}))

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

        link = speakers.SpeakerLink(cfg.Speaker('10.0.0.5'), answer_fn, lambda text, host: f'http://me/{len(text)}.wav', listed=True)
        with mock.patch.object(speakers.api, 'APIClient', FakeClient):
            link.start()
            for _ in range(50):
                await asyncio.sleep(0.01)
                if FakeClient.instances and FakeClient.instances[0].handlers:
                    break
        return link, FakeClient.instances[0]

    async def test_one_command(self):
        heard = []

        def answer_fn(audio, spoke):
            heard.append((len(audio), spoke))
            return mock.Mock(heard='turn on office lamp', reply='Office Lamp is on.', handled=True, stt_s=0.1, homehub_s=0.1)

        link, c = await self.connected_link(answer_fn)
        self.assertEqual(link.name, 'Test Speaker')
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
        link.task.cancel()

    async def test_failure_still_ends_run(self):
        def boom(audio, spoke):
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

    async def test_not_a_speaker_is_left_alone(self):
        FakeClient.voice_flags = 0
        from homehub_voice import speakers

        link = speakers.SpeakerLink(cfg.Speaker('10.0.0.6'), lambda a, s: None, lambda t, h: '', listed=False)
        with mock.patch.object(speakers.api, 'APIClient', FakeClient):
            link.start()
            await asyncio.wait_for(link.task, 2)  # returns instead of reconnecting
        self.assertIsNone(FakeClient.instances[0].handlers)


if __name__ == '__main__':
    unittest.main()
