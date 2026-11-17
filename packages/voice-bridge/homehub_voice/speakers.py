"""Connections to ESPHome voice speakers (Home Assistant Voice, Ava on a tablet, ...)."""
from __future__ import annotations

import asyncio
import logging
import re
import socket
import time
from dataclasses import dataclass, field
from typing import Callable

import aioesphomeapi as api
from aioesphomeapi.model import VoiceAssistantEventType as E
from aioesphomeapi.model import VoiceAssistantFeature

from . import confirm
from .chatter import command_over_noise
from .config import Speaker
from .endpoint import MAX_S, Endpointer, loudness
from .pipeline import Answer, wake_language

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


# Talk heard right up to the longest a command can be, nearly all of it voiced, is background talk.
# A command is a second or two of speech; a TV that woke the speaker fills all eight seconds.
BACKGROUND_VOICED = 0.75


def background_talk(seconds: float, voiced: float, heard: str = '') -> bool:
    """Whether eight seconds of sound that never stopped was the room talking, not someone talking
    to the speaker. Unless only a few words were made out of it and they have something of a
    command in them ("BẬT ĐÈN VU"): that's someone speaking over a TV, a fan or a conversation."""
    if seconds < MAX_S - 0.25 or voiced < BACKGROUND_VOICED * seconds:
        return False
    return not command_over_noise(heard)


# A reminder waits this long for a command being answered to finish, then is said anyway.
ANNOUNCE_WAIT_S = 20.0
# How long a speaker has to say a reminder.
ANNOUNCE_TIMEOUT_S = 60.0

# Its own reply, heard back within this long of saying it, isn't a command.
ECHO_S = 30.0


def own_words(heard: str, said: str) -> bool:
    """Whether what was heard is the reply just said: 唔好意思我聽唔明 after 唔好意思，我聽唔明。
    Compared without punctuation or spaces, Chinese in traditional characters, mostly the same."""
    from difflib import SequenceMatcher
    from .cantonese import has_chinese, traditional
    norm = lambda t: re.sub(r"[\W_]+", '', traditional(t) if has_chinese(t) else t.lower())  # noqa: E731
    h, s = norm(heard.split(' → ')[0]), norm(said)
    # A word or two ("on", 開) can be in any reply: too short to tell an echo.
    return len(h) >= 4 and bool(s) and (h in s or SequenceMatcher(None, h, s).ratio() >= 0.7)


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
        answer: Callable[[bytes, bool, str | None, str | None], Answer],
        speak: Callable[[str, str, str], str],
        listed: bool,
        on_change: Callable[[], None] = lambda: None,
        one_answers: OneAnswers | None = None,
        languages: list[str] | None = None,
    ) -> None:
        self.speaker = speaker
        self.languages = languages  # the ones that are on, so a wake word's language is one of them
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
        # The device this speaker was just asked "on or off?" about, when, and in which language.
        self.asked: tuple[str, float, str] | None = None
        # The last thing it said, and when: heard back straight after, it isn't a command.
        self.said: tuple[str, float] | None = None
        # When a command wasn't understood, and in which language (None: unsure): the speaker listens once more, with no wake word.
        self.again: tuple[float, str | None] | None = None
        # The open connection, while connected, and whether the speaker can say things it wasn't asked.
        self.client: api.APIClient | None = None
        self.can_announce = False
        # Listens straight after an announcement, with no wake word: for a reminder that asks back.
        self.can_start = False

    @property
    def who(self) -> str:
        """For the log: the name, and the address, since two speakers can share a name."""
        return f'{self.name} [{self.speaker.label}]' if self.name != self.speaker.label else self.name

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
                log.info('%s disconnected; reconnecting', self.who)
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
            self.can_announce = bool(info.voice_assistant_feature_flags & VoiceAssistantFeature.ANNOUNCE)
            self.can_start = bool(info.voice_assistant_feature_flags & VoiceAssistantFeature.START_CONVERSATION)
            self.client = c
            self._subscribe(c)
            try:
                await asyncio.wait_for(c.get_voice_assistant_configuration(5), 6)
            except Exception:  # noqa: BLE001 — older firmware doesn't support it
                pass
            log.info('%s connected (%s), listening%s', self.name, self.speaker.label, '' if self.can_announce else "; it can't say reminders")
            self._set_connected(True)
            await gone.wait()
        finally:
            self.client = None
            self._set_connected(False)
            if self.run:
                self.run.ended.set()
            await c.disconnect()

    async def announce(self, text: str, lang: str, ask: int | None = None) -> bool:
        """Says something nobody asked for, such as a reminder. A command being answered finishes first.
        ask: the reminder asks back, so the speaker listens for the answer straight after, if it can."""
        c = self.client
        if not c or not self.connected or not self.can_announce:
            return False
        waited = 0.0
        while self.run is not None and waited < ANNOUNCE_WAIT_S:
            await asyncio.sleep(0.5)
            waited += 0.5
        loop = asyncio.get_running_loop()
        url = await loop.run_in_executor(None, self.speak, text, self.speaker.host, lang)
        self.said = (text, time.monotonic())   # heard back, it isn't a command
        try:
            listen = ask is not None and self.can_start
            done = await c.send_voice_assistant_announcement_await_response(url, ANNOUNCE_TIMEOUT_S, text, start_conversation=listen)
        except Exception as e:  # noqa: BLE001 — one speaker failing mustn't stop the others
            log.warning('%s could not say %r: %s', self.who, text, e)
            return False
        if getattr(done, 'success', True) is False:
            log.warning('%s did not say %r', self.who, text)
            return False
        log.info('%s said %r', self.who, text)
        if ask is not None:
            # The answer that follows ("食咗") isn't TV talk: it's the reply to this.
            from .ask import PREFIX
            self.asked = (f'{PREFIX}{ask}', time.monotonic(), lang)
        return True

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
                    log.info('%s #%d (%s): another speaker heard the same command louder, so it answers', self.who, run.n, run.wake or 'no wake word')
                    return
                # A question asked lately is answered by this command, or forgotten.
                recent = self.asked if self.asked and time.monotonic() - self.asked[1] <= FOLLOW_UP_S else None
                self.asked = None
                asked = recent[0] if recent else None
                again = self.again if self.again and time.monotonic() - self.again[0] <= FOLLOW_UP_S else None
                self.again = None
                # The answer to a question is in the question's language; otherwise the wake word's, if it says;
                # a second try with no wake word is in the first try's language.
                prefer = recent[2] if recent else wake_language(run.wake, self.languages) or (again[1] if again else None)
                a = await loop.run_in_executor(None, self.answer, bytes(run.listen.audio), run.listen.spoke, asked, prefer)
                # No words at all: most often the wake word heard in a noise or a conversation, so the
                # speaker goes quiet instead of saying "Sorry, I didn't hear anything" to nobody.
                if not a.heard.strip(' 。，.,!?！？') and not a.handled:
                    log.info('%s #%d (%s) woke but heard no words, so it stays quiet (speech %.1fs, recognise %.2fs)',
                             self.who, run.n, run.wake or 'no wake word', run.listen.seconds, a.stt_s)
                    return
                follow_up = a.asked if isinstance(getattr(a, 'asked', None), str) else None
                # Talk that never stopped until the speaker gave up listening, and wasn't a command: a TV
                # or a conversation that sounded like the wake word, not someone speaking to it.
                # A question HomeHub would ask about it ("Turn on …?") doesn't make TV talk a command.
                asks_back = bool(follow_up and follow_up.startswith(confirm.PREFIX))
                # A few command words heard over the noise are still answered (see background_talk).
                if not a.handled and (not follow_up or asks_back) and background_talk(run.listen.seconds, run.listen.voiced, a.heard):
                    log.info('%s #%d (%s) heard %r in %.1fs of talk that didn\'t stop, most likely a TV or a conversation, so it stays quiet',
                             self.who, run.n, run.wake or 'no wake word', a.heard, run.listen.seconds)
                    return
                # Its own reply, heard back as it listened again: never a command.
                if not a.handled and self.said and time.monotonic() - self.said[1] <= ECHO_S and own_words(a.heard, self.said[0]):
                    log.info('%s #%d (%s) heard its own reply %r, so it stays quiet', self.who, run.n, run.wake or 'no wake word', a.heard)
                    return
                # A miss with nothing of a command in it: talk from a TV or the room.
                if not follow_up and getattr(a, 'chatter', False) is True:
                    log.info('%s #%d (%s) heard %r, nothing like a command, most likely a TV or a conversation, so it stays quiet',
                             self.who, run.n, run.wake or 'no wake word', a.heard)
                    return
                # Not understood: one more try, with no wake word. Only one, so a misheard TV can't keep it listening.
                try_again = not a.handled and not follow_up and not again
                event(E.VOICE_ASSISTANT_STT_END, {'text': a.heard or ' '})
                event(E.VOICE_ASSISTANT_INTENT_START)
                # A question: the speaker listens again after the reply, with no wake word.
                event(E.VOICE_ASSISTANT_INTENT_END, {'conversation_id': run.conversation,
                                                     **({'continue_conversation': '1'} if follow_up or try_again else {})})
                event(E.VOICE_ASSISTANT_TTS_START, {'text': a.reply})
                self.said = (a.reply, time.monotonic())
                url = await loop.run_in_executor(None, self.speak, a.reply, self.speaker.host, a.lang)
                event(E.VOICE_ASSISTANT_TTS_END, {'url': url})
                lang = a.lang if isinstance(getattr(a, 'lang', None), str) else 'en'
                if follow_up:
                    self.asked = (follow_up, time.monotonic(), lang)
                if try_again:
                    # A guess between Cantonese and Mandarin isn't held to: the next try reads both again.
                    self.again = (time.monotonic(), None if getattr(a, 'unsure', False) is True else lang)
                passes = getattr(a, 'passes', 0)
                label = getattr(a, 'label', '')
                how = ({1: ' in 1 pass', 2: ' in 2 passes'}.get(passes, '') if isinstance(passes, int) else '')
                how += f' labelled {label}' if isinstance(label, str) and label else ''
                log.info(
                    '%s #%d (%s) heard %r -> %r (%s; speech %.1fs of which voiced %.1fs, loudness %.3f-%.3f, recognise %.2fs%s, HomeHub %.2fs, reply ready %.2fs after speech ended)',
                    self.who, run.n, run.wake or 'no wake word', a.heard, a.reply, 'done' if a.handled else 'not handled',
                    run.listen.seconds, run.listen.voiced, min(run.listen.floor, run.listen.peak), run.listen.peak, a.stt_s, how,
                    a.homehub_s, time.monotonic() - t_end,
                )
            except Exception as e:  # noqa: BLE001 — the speaker must always hear the run end
                log.exception('%s #%d failed', self.who, run.n)
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


# Asking an announced speaker for its address: soon at first, then less often, never giving up
# while it's still announced (the caller cancels when it goes).
ASK_FIRST_S = 2.0
ASK_MOST_S = 30.0


async def keep_asking(ask: Callable, first: float = ASK_FIRST_S, most: float = ASK_MOST_S):
    delay = first
    while True:
        try:
            got = await ask()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — a network hiccup; try again
            log.debug('asking a speaker for its address failed: %s', e)
            got = None
        if got:
            return got
        await asyncio.sleep(delay)
        delay = min(delay * 2, most)


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
        # Speakers found on the network, by the name they announce: which link is theirs.
        self.named: dict[str, str] = {}
        self.listed = listed
        self.changed = asyncio.Event()

    def status(self) -> list[dict]:
        """Speakers for HomeHub's Health page. Devices that turned out not to be speakers are left out."""
        return [
            {'name': l.name, 'address': l.speaker.label, 'connected': l.connected, 'announce': l.can_announce}
            for l in self.links.values() if l.usable
        ]

    async def announce(self, text: str, lang: str, ask: int | None = None) -> tuple[list[str], str]:
        """Says it on every speaker that can. The names of those that did, or why none did."""
        links = [l for l in self.links.values() if l.usable and l.connected]
        able = [l for l in links if l.can_announce]
        if not links:
            return [], 'no speaker is connected'
        if not able:
            return [], f"{', '.join(l.name for l in links)} can't say reminders: update the speaker's app"
        done = await asyncio.gather(*(l.announce(text, lang, ask) if ask is not None else l.announce(text, lang) for l in able))
        said = [l.name for l, ok in zip(able, done) if ok]
        return said, '' if said else 'the speaker didn’t say it'

    def add(self, speaker: Speaker, listed: bool) -> None:
        key = f'{resolve(speaker.host)}:{speaker.port}'
        if key in self.links:
            return
        link = self.make(speaker, listed)
        self.links[key] = link
        link.start()
        self.changed.set()

    def found(self, name: str, speaker: Speaker) -> None:
        """A speaker announced on the network, at the address it has now. One that moved is followed
        to its new address, and the link to the old one is dropped, so it isn't tried forever."""
        key = f'{resolve(speaker.host)}:{speaker.port}'
        old = self.named.get(name)
        # A phone can be announced under two names at once ("Android Voice Assistant (2)"): the
        # old address is dropped only if no other name still points to it.
        shared = any(k == old for n, k in self.named.items() if n != name)
        if old and old != key and not shared and (link := self.links.pop(old, None)) is not None:
            log.info('%s moved from %s to %s', link.name, link.speaker.label, speaker.label)
            if link.task:
                link.task.cancel()
            self.changed.set()
        self.named[name] = key
        self.add(speaker, False)

    async def run(self) -> None:
        for s in self.listed:
            self.add(s, True)
        if not self.discover:
            await asyncio.Event().wait()
        from zeroconf import ServiceStateChange
        from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf

        zc = AsyncZeroconf()
        looking: dict[str, asyncio.Task] = {}

        async def address(name: str) -> Speaker | None:
            info = AsyncServiceInfo(ESPHOME_SERVICE, name)
            if not await info.async_request(zc.zeroconf, 3000):
                return None
            addrs = info.parsed_addresses(version=__import__('zeroconf').IPVersion.V4Only)
            return Speaker(addrs[0], info.port) if addrs and info.port else None

        async def found(name: str) -> None:
            # A speaker that has just joined the network, or is changing address, often doesn't
            # answer the first time: ask again until it does, for as long as it's announced.
            speaker = await keep_asking(lambda: address(name))
            if speaker:
                self.found(name, speaker)

        def look(name: str) -> None:
            if (t := looking.pop(name, None)):
                t.cancel()
            t = asyncio.ensure_future(found(name))
            looking[name] = t
            t.add_done_callback(lambda done, n=name: looking.pop(n, None) if looking.get(n) is done else None)

        def changed(zeroconf, service_type, name, state_change) -> None:
            # Updated: it may have a new address (a phone that changed its network ID, say).
            if state_change in (ServiceStateChange.Added, ServiceStateChange.Updated):
                look(name)
            elif state_change is ServiceStateChange.Removed and (t := looking.pop(name, None)):
                t.cancel()

        browser = AsyncServiceBrowser(zc.zeroconf, ESPHOME_SERVICE, handlers=[changed])
        log.info('looking for speakers on the network')
        try:
            await asyncio.Event().wait()
        finally:
            await browser.async_cancel()
            await zc.async_close()
