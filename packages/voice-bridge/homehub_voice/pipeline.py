"""From a spoken command to HomeHub's reply text. Kept apart from the speaker
connection so it can be tested with recordings.

With Cantonese on, SenseVoice hears each command first and says which
language it is in. English goes on to Whisper as before; Cantonese is read by
sound against the home's Cantonese names (see cantonese.py)."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Protocol

from . import cantonese as yue
from .homehub import CommandResult, HomeHubError

log = logging.getLogger('homehub-voice')

NOTHING_HEARD = "Sorry, I didn't hear anything."
NOT_CAUGHT = "Sorry, I didn't catch that."
NO_HOMEHUB = "I can't reach HomeHub right now."


class Transcriber(Protocol):
    def transcribe(self, audio: bytes, names: list[str]) -> str: ...


class CantoneseEars(Protocol):
    def language(self, audio: bytes) -> str: ...
    def transcribe(self, audio: bytes) -> str: ...


class Commander(Protocol):
    names: list[str]

    def command(self, text: str) -> CommandResult: ...


@dataclass
class Answer:
    heard: str
    reply: str
    handled: bool
    stt_s: float = 0.0
    homehub_s: float = 0.0
    # The reply's language: 'en' or 'yue'.
    lang: str = 'en'


# Languages SenseVoice reports for Cantonese. Short commands are sometimes labelled Chinese.
CANTONESE = {'yue', 'zh'}


def answer(audio: bytes, spoke: bool, listener: Transcriber, homehub: Commander,
           ears: CantoneseEars | None = None) -> Answer:
    if not spoke:
        return Answer('', NOTHING_HEARD, False)
    t0 = time.monotonic()
    if ears is not None and ears.language(audio) in CANTONESE:
        return answer_cantonese(audio, ears, homehub, t0)
    text = listener.transcribe(audio, homehub.names)
    t1 = time.monotonic()
    if not text.strip(' .,!?'):
        return Answer('', NOT_CAUGHT, False, t1 - t0)
    try:
        res = homehub.command(text)
    except HomeHubError as e:
        log.warning('%s', e)
        return Answer(text, NO_HOMEHUB, False, t1 - t0, time.monotonic() - t1)
    return Answer(text, res.response or NOT_CAUGHT, res.handled, t1 - t0, time.monotonic() - t1)


def answer_cantonese(audio: bytes, ears: CantoneseEars, homehub: Commander, t0: float) -> Answer:
    text = ears.transcribe(audio)
    command = yue.parse(text, homehub.names, homehub.names)
    t1 = time.monotonic()
    if not text.strip(' 。，.,!?！？'):
        return Answer('', yue.NOT_UNDERSTOOD, False, t1 - t0, lang='yue')
    heard = f'{text} → {command.homehub_text}' if command else text
    try:
        # Unread commands go to HomeHub too, so they're listed with the commands it missed.
        res = homehub.command(command.homehub_text if command else yue.traditional(text))
    except HomeHubError as e:
        log.warning('%s', e)
        return Answer(heard, yue.NO_HOMEHUB, False, t1 - t0, time.monotonic() - t1, lang='yue')
    reply = yue.reply(command, res.handled, res.response, res.failed)
    return Answer(heard, reply, bool(command) and res.handled, t1 - t0, time.monotonic() - t1, lang='yue')
