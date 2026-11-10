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
from .endpoint import MAX_S, Endpointer, loudness
from .pipeline import Answer

log = logging.getLogger('homehub-voice')

ESPHOME_SERVICE = '_esphomelib._tcp.local.'
# How long an "on or off?" question waits for its answer, from when it was asked.
FOLLOW_UP_S = 15.0
# Speakers that wake within this long of each other heard the same person say the wake word.
SAME_WAKE_S = 1.0
# How long a speaker that has finished listening waits for another that heard the same command.
WAIT_FOR_OTHERS_S = 2.0


@dataclass(eq=False)
class Run:
    n: int
    conversation: str
    listen: Endpointer = field(default_factory=Endpointer)
    ended: asyncio.Event = field(default_factory=asyncio.Event)
    started: float = field(default_factory=time.monotonic)
    # Which speaker heard it, by address: two speakers can have the same name.
    speaker: str = ''
    # Cancelled by the speaker, so it can't be the one to answer.
    dropped: bool = False
    # The wake word the speaker heard, as it names it; empty when it listens again after a question.
    wake: str = ''

    def volume(self) -> float:
        return loudness(bytes(self.listen.audio)) if self.listen.spoke else 0.0


# Runs are remembered this long, so a speaker that finishes listening late still sees who answered.
REMEMBER_S = 30.0


class OneAnswers:
    """When several speakers wake for the same command, only the one that heard it loudest
    (most likely the nearest) answers; the others go quiet. Shared by all the speakers."""

    def __init__(self) -> None:
        self.runs: list[Run] = []

    def started(self, run: Run) -> None:
        self.runs = [r for r in self.runs if run.started - r.started <= REMEMBER_S] + [run]

    async def answers(self, run: Run) -> bool:
        """Called when `run` has finished listening. False if another speaker should answer instead."""
        others = [r for r in self.runs if r.speaker != run.speaker and not r.dropped and abs(r.started - run.started) <= SAME_WAKE_S]
        if not others:
            return True
        waits = [asyncio.ensure_future(r.ended.wait()) for r in others]
        await asyncio.wait(waits, timeout=WAIT_FOR_OTHERS_S)
        for w in waits:
            w.cancel()
        # Every speaker reaches the same verdict: loudest, then the one that woke first, then by name.
        rank = lambda r: (r.volume(), -r.started, r.speaker, -r.n)  # noqa: E731
        return max([run, *[r for r in others if not r.dropped]], key=rank) is run


class StopTrying(Exception):
    """This device can't be used as a speaker, so don't reconnect."""


class SpeakerLink:
    """One speaker: keeps it connected and handles each command it sends."""

    def __init__(
        self,
        speaker: Speaker,
        answer: Callable[[bytes, bool, str | None], Answer],
        speak: Callable[[str, str, str], str],
        listed: bool,
        on_change: Callable[[], None] = lambda: None,
        one_answers: OneAnswers | None = None,
    ) -> None:
        self.speaker = speaker
        self.one_answers = one_answers or OneAnswers()
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
        # The device this speaker was just asked "on or off?" about, and when.
        self.asked: tuple[str, float] | None = None

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
                run.dropped = True
                return
            t_end = time.monotonic()
            event(E.VOICE_ASSISTANT_STT_VAD_END)
            try:
                if not await self.one_answers.answers(run):
                    log.info('%s #%d (%s): another speaker heard the same command louder, so it answers', self.name, run.n, run.wake or 'no wake word')
                    return
                # A question asked lately is answered by this command, or forgotten.
                asked = self.asked[0] if self.asked and time.monotonic() - self.asked[1] <= FOLLOW_UP_S else None
                self.asked = None
                a = await loop.run_in_executor(None, self.answer, bytes(run.listen.audio), run.listen.spoke, asked)
                # No words at all: most often the wake word heard in a noise or a conversation, so the
                # speaker goes quiet instead of saying "Sorry, I didn't hear anything" to nobody.
                if not a.heard.strip(' 。，.,!?！？') and not a.handled:
                    log.info('%s #%d (%s) woke but heard no words, so it stays quiet (speech %.1fs, recognise %.2fs)',
                             self.name, run.n, run.wake or 'no wake word', run.listen.seconds, a.stt_s)
                    return
                follow_up = a.asked if isinstance(getattr(a, 'asked', None), str) else None
                event(E.VOICE_ASSISTANT_STT_END, {'text': a.heard or ' '})
                event(E.VOICE_ASSISTANT_INTENT_START)
                # A question: the speaker listens again after the reply, with no wake word.
                event(E.VOICE_ASSISTANT_INTENT_END, {'conversation_id': run.conversation,
                                                     **({'continue_conversation': '1'} if follow_up else {})})
                event(E.VOICE_ASSISTANT_TTS_START, {'text': a.reply})
                url = await loop.run_in_executor(None, self.speak, a.reply, self.speaker.host, a.lang)
                event(E.VOICE_ASSISTANT_TTS_END, {'url': url})
                if follow_up:
                    self.asked = (follow_up, time.monotonic())
                passes = getattr(a, 'passes', 0)
                log.info(
                    '%s #%d (%s) heard %r -> %r (%s; speech %.1fs, recognise %.2fs%s, HomeHub %.2fs, reply ready %.2fs after speech ended)',
                    self.name, run.n, run.wake or 'no wake word', a.heard, a.reply, 'done' if a.handled else 'not handled',
                    run.listen.seconds, a.stt_s, {1: ' in 1 pass', 2: ' in 2 passes'}.get(passes, '') if isinstance(passes, int) else '',
                    a.homehub_s, time.monotonic() - t_end,
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
            run = Run(self.count, conversation or f'homehub-{self.count}', speaker=f'{self.speaker.host}:{self.speaker.port}')
            if self.run:
                self.run.dropped = True
                self.run.ended.set()
            self.run = run
            self.one_answers.started(run)
            run.wake = (wake_word or '').strip()
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
                    run.dropped = True
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
