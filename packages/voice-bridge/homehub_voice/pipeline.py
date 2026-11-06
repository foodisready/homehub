"""From a spoken command to HomeHub's reply text. Kept apart from the speaker
connection so it can be tested with recordings.

With Cantonese on, SenseVoice hears each command first and says which
language it is in. English goes on to Whisper as before; Cantonese is read by
sound against the home's Cantonese names (see cantonese.py)."""
from __future__ import annotations

import logging
import re
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
    # The device HomeHub just asked "on or off?" about, waiting for the answer.
    asked: str | None = None


# "On", "off", "turn it on", "switch it off, please": an answer to "on or off?".
ON_OR_OFF = re.compile(r'^\s*(?:(?:turn|switch)\s+(?:it\s+|them\s+)?)?(on|off)(?:\s+(?:it|them))?(?:,?\s*please)?[\s.!?]*$', re.I)


# Languages SenseVoice reports for Cantonese. Short commands are sometimes labelled Chinese.
CANTONESE = {'yue', 'zh'}


def answer(audio: bytes, spoke: bool, listener: Transcriber, homehub: Commander,
           ears: CantoneseEars | None = None, asked: str | None = None) -> Answer:
    """asked: the device HomeHub just asked "on or off?" about, if any, so "on" alone answers it."""
    if not spoke:
        return Answer('', NOTHING_HEARD, False)
    t0 = time.monotonic()
    if ears is not None and ears.language(audio) in CANTONESE:
        return answer_cantonese(audio, ears, homehub, t0, asked)
    text = listener.transcribe(audio, homehub.names)
    t1 = time.monotonic()
    if not text.strip(' .,!?'):
        return Answer('', NOT_CAUGHT, False, t1 - t0)
    # "On" alone, answering "on or off?" about a device.
    reply_to = ON_OR_OFF.match(text) if asked else None
    send = f'turn {reply_to.group(1).lower()} {asked}' if reply_to else text
    heard = f'{text} → {send}' if reply_to else text
    try:
        res = homehub.command(send)
    except HomeHubError as e:
        log.warning('%s', e)
        return Answer(heard, NO_HOMEHUB, False, t1 - t0, time.monotonic() - t1)
    return Answer(heard, res.response or NOT_CAUGHT, res.handled, t1 - t0, time.monotonic() - t1)


def answer_cantonese(audio: bytes, ears: CantoneseEars, homehub: Commander, t0: float, asked: str | None = None) -> Answer:
    text = ears.transcribe(audio)
    command = yue.parse(text, homehub.names, getattr(homehub, 'scenes', homehub.names))
    # 開 or 熄 alone, answering "你想開定熄廚房燈？".
    if asked and (command is None or command.action == 'ask'):
        verb = yue.verb_alone(text)
        if verb:
            command = yue.Command(verb, asked, 1.0)
    t1 = time.monotonic()
    if not text.strip(' 。，.,!?！？'):
        return Answer('', yue.NOT_UNDERSTOOD, False, t1 - t0, lang='yue')
    # A name alone switches nothing: HomeHub can't know whether on or off was meant.
    act = command if command and command.action != 'ask' else None
    heard = f'{text} → {act.homehub_text}' if act else text
    try:
        # Unread commands go to HomeHub too, as heard, so they're listed with the commands it missed.
        res = homehub.command(act.homehub_text if act else yue.traditional(text))
    except HomeHubError as e:
        log.warning('%s', e)
        return Answer(heard, yue.NO_HOMEHUB, False, t1 - t0, time.monotonic() - t1, lang='yue')
    reply = yue.reply(command, res.handled, res.response, res.failed)
    return Answer(heard, reply, bool(act) and res.handled, t1 - t0, time.monotonic() - t1, lang='yue',
                  asked=command.name if command and command.action == 'ask' else None)
