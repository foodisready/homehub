"""Connections to ESPHome voice speakers (Home Assistant Voice, Ava on a tablet, ...)."""
from __future__ import annotations

import asyncio
import logging
import socket
import time
from dataclasses import dataclass, field
from typing import Callable

import aioesphomeapi as api
from aioesphomeapi.model import VoiceAssistantEventType as E

from .config import Speaker
from .endpoint import MAX_S, Endpointer
from .pipeline import Answer

log = logging.getLogger('homehub-voice')

ESPHOME_SERVICE = '_esphomelib._tcp.local.'


@dataclass
class Run:
    n: int
    conversation: str
    listen: Endpointer = field(default_factory=Endpointer)
    ended: asyncio.Event = field(default_factory=asyncio.Event)
    started: float = field(default_factory=time.monotonic)


class StopTrying(Exception):
    """This device can't be used as a speaker, so don't reconnect."""


class SpeakerLink:
    """One speaker: keeps it connected and handles each command it sends."""

    def __init__(
        self,
        speaker: Speaker,
        answer: Callable[[bytes, bool], Answer],
        speak: Callable[[str, str, str], str],
        listed: bool,
        on_change: Callable[[], None] = lambda: None,
    ) -> None:
        self.speaker = speaker
        self.answer = answer
        self.speak = speak  # (text, speaker host, language) -> URL of the spoken reply
        self.listed = listed  # listed in SPEAKERS rather than found on the network
        self.name = speaker.label
        self.run: Run | None = None
        self.count = 0
        self.task: asyncio.Task | None = None
        self.connected = False
        self.usable = True  # False once it turns out not to be a speaker
        self.on_change = on_change

    def _set_connected(self, value: bool) -> None:
        if value != self.connected:
            self.connected = value
            self.on_change()

    def start(self) -> None:
        self.task = asyncio.create_task(self._keep_connected(), name=f'speaker {self.name}')

    async def _keep_connected(self) -> None:
        delay = 5.0
        last_error = ''
        while True:
            try:
                await self._session()
                delay = 5.0
                last_error = ''
                log.info('%s disconnected; reconnecting', self.name)
            except StopTrying as e:
                log.info('%s: %s', self.name, e)
                self.usable = False
                self.on_change()
                return
            except asyncio.CancelledError:
                raise
            except (api.InvalidEncryptionKeyAPIError, api.RequiresEncryptionAPIError, api.EncryptionPlaintextAPIError) as e:
                msg = f'{self.name} needs its encryption key. Add it to SPEAKERS as {self.speaker.host}|<key>'
                if self.speaker.key:
                    msg = f'{self.name} refused its encryption key ({type(e).__name__})'
                if msg != last_error:
                    log.warning('%s', msg)
                    last_error = msg
                if not self.listed:
                    self.usable = False
                    self.on_change()
                    return
                delay = 300
            except Exception as e:  # noqa: BLE001 — a speaker that's off or asleep is normal
                msg = f'{self.name} unreachable: {type(e).__name__} {e}'
                if msg != last_error:
                    log.warning('%s', msg)
                    last_error = msg
                delay = min(delay * 2, 60)
            await asyncio.sleep(delay)

    async def _session(self) -> None:
        gone = asyncio.Event()

        async def on_disconnect(expected: bool) -> None:
            gone.set()

        c = api.APIClient(self.speaker.host, self.speaker.port, None, client_info='homehub-voice', noise_psk=self.speaker.key)
        await asyncio.wait_for(c.connect(on_stop=on_disconnect, login=True), 15)
        try:
            info = await c.device_info()
            self.name = info.friendly_name or info.name or self.speaker.label
            if not info.voice_assistant_feature_flags:
                raise StopTrying('not a voice speaker, ignoring it')
            self._subscribe(c)
            try:
                await asyncio.wait_for(c.get_voice_assistant_configuration(5), 6)
            except Exception:  # noqa: BLE001 — older firmware doesn't support it
                pass
            log.info('%s connected (%s), listening', self.name, self.speaker.label)
            self._set_connected(True)
            await gone.wait()
        finally:
            self._set_connected(False)
            if self.run:
                self.run.ended.set()
            await c.disconnect()

    def _subscribe(self, c: api.APIClient) -> None:
        loop = asyncio.get_running_loop()

        def event(kind: E, data: dict | None = None) -> None:
            c.send_voice_assistant_event(kind, data or {})

        async def process(run: Run) -> None:
            try:
                await asyncio.wait_for(run.ended.wait(), MAX_S + 1)
            except TimeoutError:
                pass
            if self.run is not run:
                return
            t_end = time.monotonic()
            event(E.VOICE_ASSISTANT_STT_VAD_END)
            try:
                a = await loop.run_in_executor(None, self.answer, bytes(run.listen.audio), run.listen.spoke)
                event(E.VOICE_ASSISTANT_STT_END, {'text': a.heard or ' '})
                event(E.VOICE_ASSISTANT_INTENT_START)
                event(E.VOICE_ASSISTANT_INTENT_END, {'conversation_id': run.conversation})
                event(E.VOICE_ASSISTANT_TTS_START, {'text': a.reply})
                url = await loop.run_in_executor(None, self.speak, a.reply, self.speaker.host, a.lang)
                event(E.VOICE_ASSISTANT_TTS_END, {'url': url})
                log.info(
                    '%s #%d heard %r -> %r (%s; speech %.1fs, recognise %.2fs, HomeHub %.2fs, reply ready %.2fs after speech ended)',
                    self.name, run.n, a.heard, a.reply, 'done' if a.handled else 'not handled',
                    run.listen.seconds, a.stt_s, a.homehub_s, time.monotonic() - t_end,
                )
            except Exception as e:  # noqa: BLE001 — the speaker must always hear the run end
                log.exception('%s #%d failed', self.name, run.n)
                event(E.VOICE_ASSISTANT_ERROR, {'code': 'bridge-error', 'message': str(e)[:200]})
            finally:
                event(E.VOICE_ASSISTANT_RUN_END)
                if self.run is run:
                    self.run = None

        async def on_start(conversation: str, flags: int, settings, wake_word: str | None) -> int:
            self.count += 1
            run = Run(self.count, conversation or f'homehub-{self.count}')
            if self.run:
                self.run.ended.set()
            self.run = run
            log.debug('%s #%d wake word %r', self.name, run.n, wake_word)
            event(E.VOICE_ASSISTANT_RUN_START, {'conversation_id': run.conversation})
            event(E.VOICE_ASSISTANT_STT_START)
            event(E.VOICE_ASSISTANT_STT_VAD_START)
            asyncio.create_task(process(run))
            return 0  # 0: send audio over this connection

        async def on_stop(abort: bool) -> None:
            run = self.run
            if run:
                if abort:
                    self.run = None
                run.ended.set()

        async def on_audio(data: bytes, *_rest) -> None:
            run = self.run
            if run and not run.ended.is_set() and run.listen.add(data):
                run.ended.set()

        c.subscribe_voice_assistant(handle_start=on_start, handle_stop=on_stop, handle_audio=on_audio)


def resolve(host: str) -> str:
    try:
        return socket.gethostbyname(host)
    except OSError:
        return host


class Speakers:
    """Listed speakers, plus any found on the network while discovery is on."""

    def __init__(self, listed: list[Speaker], make: Callable[[Speaker, bool], SpeakerLink], discover: bool) -> None:
        self.make = make
        self.discover = discover
        self.links: dict[str, SpeakerLink] = {}
        self.listed = listed
        self.changed = asyncio.Event()

    def status(self) -> list[dict]:
        """Speakers for HomeHub's Health page. Devices that turned out not to be speakers are left out."""
        return [
            {'name': l.name, 'address': l.speaker.label, 'connected': l.connected}
            for l in self.links.values() if l.usable
        ]

    def add(self, speaker: Speaker, listed: bool) -> None:
        key = f'{resolve(speaker.host)}:{speaker.port}'
        if key in self.links:
            return
        link = self.make(speaker, listed)
        self.links[key] = link
        link.start()
        self.changed.set()

    async def run(self) -> None:
        for s in self.listed:
            self.add(s, True)
        if not self.discover:
            await asyncio.Event().wait()
        from zeroconf import ServiceStateChange
        from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf

        zc = AsyncZeroconf()
        pending: set[asyncio.Task] = set()

        async def found(name: str) -> None:
            info = AsyncServiceInfo(ESPHOME_SERVICE, name)
            if not await info.async_request(zc.zeroconf, 3000):
                return
            addrs = info.parsed_addresses(version=__import__('zeroconf').IPVersion.V4Only)
            if addrs and info.port:
                self.add(Speaker(addrs[0], info.port), False)

        def changed(zeroconf, service_type, name, state_change) -> None:
            if state_change is ServiceStateChange.Added:
                t = asyncio.ensure_future(found(name))
                pending.add(t)
                t.add_done_callback(pending.discard)

        browser = AsyncServiceBrowser(zc.zeroconf, ESPHOME_SERVICE, handlers=[changed])
        log.info('looking for speakers on the network')
        try:
            await asyncio.Event().wait()
        finally:
            await browser.async_cancel()
            await zc.async_close()
