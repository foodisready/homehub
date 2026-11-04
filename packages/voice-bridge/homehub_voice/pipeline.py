"""From a spoken command to HomeHub's reply text. Kept apart from the speaker
connection so it can be tested with recordings."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Protocol

from .homehub import CommandResult, HomeHubError

log = logging.getLogger('homehub-voice')

NOTHING_HEARD = "Sorry, I didn't hear anything."
NOT_CAUGHT = "Sorry, I didn't catch that."
NO_HOMEHUB = "I can't reach HomeHub right now."


class Transcriber(Protocol):
    def transcribe(self, audio: bytes, names: list[str]) -> str: ...


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


def answer(audio: bytes, spoke: bool, listener: Transcriber, homehub: Commander) -> Answer:
    if not spoke:
        return Answer('', NOTHING_HEARD, False)
    t0 = time.monotonic()
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
