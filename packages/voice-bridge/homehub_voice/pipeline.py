"""From a spoken command to HomeHub's reply text. Kept apart from the speaker
connection so it can be tested with recordings.

With Cantonese on, SenseVoice hears each command first and says which
language it is in. Cantonese is read by sound against the home's Cantonese
names (see cantonese.py). English is tried with SenseVoice's words first,
which takes about a second on a Pi, and goes to Whisper, about ten seconds
but better at the home's names, only if HomeHub doesn't understand them.
Without Cantonese, English goes straight to Whisper."""
from __future__ import annotations

import difflib
import logging
import re
import time
from dataclasses import dataclass
from typing import Protocol

from . import cantonese as yue
from . import vietnamese as vi
from .homehub import CommandResult, HomeHubError

log = logging.getLogger('homehub-voice')

NOTHING_HEARD = "Sorry, I didn't hear anything."
NOT_CAUGHT = "Sorry, I didn't catch that."
NO_HOMEHUB = "I can't reach HomeHub right now."


class Transcriber(Protocol):
    def transcribe(self, audio: bytes, names: list[str]) -> str: ...


class CantoneseEars(Protocol):
    def hear(self, audio: bytes) -> tuple[str, str]: ...
    def transcribe(self, audio: bytes) -> str: ...


class VietnameseEars(Protocol):
    def transcribe(self, audio: bytes) -> str: ...


class Commander(Protocol):
    names: list[str]

    def command(self, text: str, retry: bool = False) -> CommandResult: ...


@dataclass
class Answer:
    heard: str
    reply: str
    handled: bool
    stt_s: float = 0.0
    homehub_s: float = 0.0
    # The reply's language: 'en', 'yue' or 'vi'.
    lang: str = 'en'
    # The device HomeHub just asked "on or off?" about, waiting for the answer.
    asked: str | None = None
    # How many times SenseVoice listened to a Cantonese command: once if the first was clear.
    passes: int = 0


# "On", "off", "turn it on", "switch it off, please": an answer to "on or off?".
ON_OR_OFF = re.compile(r'^\s*(?:(?:turn|switch)\s+(?:it\s+|them\s+)?)?(on|off)(?:\s+(?:it|them))?(?:,?\s*please)?[\s.!?]*$', re.I)


# Languages SenseVoice reports for Cantonese. Short commands are sometimes labelled Chinese.
CANTONESE = {'yue', 'zh'}


def answer(audio: bytes, spoke: bool, listener: Transcriber, homehub: Commander,
           ears: CantoneseEars | None = None, asked: str | None = None,
           vi_ears: VietnameseEars | None = None) -> Answer:
    """asked: the device HomeHub just asked "on or off?" about, if any, so "on" alone answers it."""
    if not spoke:
        return Answer('', NOTHING_HEARD, False)
    t0 = time.monotonic()
    which = asked if asked and asked.startswith(vi.WHICH_PREFIX) else None
    if which:
        asked = None   # not a device's name: English and Cantonese have nothing to answer
    if vi_ears is not None:
        # First, since SenseVoice takes most Vietnamese for Cantonese. It takes about a third of a
        # second on a Pi, and what it writes for English or Cantonese is never a Vietnamese command.
        heard = vi_ears.transcribe(audio)
        if which and has_words(heard):
            command = vi.answer_which(which, heard, homehub.names, getattr(homehub, 'groups', None))
            if command is not None:
                return send_vietnamese(heard, command, homehub, t0)
        if vi.is_vietnamese(heard, homehub.names, getattr(homehub, 'scenes', homehub.names),
                            getattr(homehub, 'groups', None), asked):
            return answer_vietnamese(heard, homehub, t0, asked)
    quick = ''
    if ears is not None:
        lang, quick = ears.hear(audio)
        if lang in CANTONESE:
            return answer_cantonese(audio, ears, homehub, t0, asked, quick)
    # English. SenseVoice has already heard the words, in about a second; Whisper takes about ten
    # on a Pi, but knows the home's device names. So try SenseVoice's words first, and ask Whisper
    # only if HomeHub doesn't understand them.
    if quick.strip(' .,!?'):
        # As heard, then with the device's name spelled as HomeHub knows it ("my office la" → "My office lamp").
        for text in dict.fromkeys([quick, closest_name(quick, homehub.names)]):
            first = english(text, homehub, asked, retry=True)
            if first[1] is None or first[1].handled:
                return finish(first, time.monotonic() - t0)
    text = listener.transcribe(audio, homehub.names)
    if not text.strip(' .,!?'):
        return Answer('', NOT_CAUGHT, False, time.monotonic() - t0)
    return finish(english(text, homehub, asked), time.monotonic() - t0)


# "Turn on my office la.": a verb, then a name.
SWITCH = re.compile(r'^\s*(?:please\s+)?((?:turn|switch)\s+(?:on|off))\b[\s,]*(.+?)[\s.,!?]*$', re.I)
# How alike a heard name and a real one must be, from 0 to 1, and how far ahead of the next-best name.
NAME_MATCH = 0.75
NAME_MARGIN = 0.05


def closest_name(text: str, names: list[str]) -> str:
    """The command with its device name replaced by the closest English name HomeHub knows, if one is
    clearly closest. SenseVoice doesn't know the home's names the way Whisper does, so it gets them
    nearly right: "office la" for "office lamp". Otherwise the text as it was."""
    m = SWITCH.match(text)
    if not m:
        return text
    key = lambda s: re.sub(r"^(my|the)\s+|['’]s\b", '', s.lower().strip())  # noqa: E731
    said = key(m.group(2))
    scored = sorted(((difflib.SequenceMatcher(None, said, key(n)).ratio(), n) for n in set(names) if n.isascii()), reverse=True)
    if not scored or scored[0][0] < NAME_MATCH or (len(scored) > 1 and scored[0][0] - scored[1][0] < NAME_MARGIN):
        return text
    return f'{m.group(1)} {scored[0][1]}'


def english(text: str, homehub: Commander, asked: str | None, retry: bool = False) -> tuple[str, CommandResult | None, float]:
    """Sends English words to HomeHub: what was heard, HomeHub's result (None if it can't be reached), and how long it took."""
    # "On" alone, answering "on or off?" about a device.
    reply_to = ON_OR_OFF.match(text) if asked else None
    send = f'turn {reply_to.group(1).lower()} {asked}' if reply_to else text
    heard = f'{text} → {send}' if reply_to else text
    t = time.monotonic()
    try:
        return heard, homehub.command(send, retry=retry), time.monotonic() - t
    except HomeHubError as e:
        log.warning('%s', e)
        return heard, None, time.monotonic() - t


def finish(sent: tuple[str, CommandResult | None, float], total_s: float) -> Answer:
    heard, res, homehub_s = sent
    if res is None:
        return Answer(heard, NO_HOMEHUB, False, total_s - homehub_s, homehub_s)
    return Answer(heard, res.response or NOT_CAUGHT, res.handled, total_s - homehub_s, homehub_s)


# How sure a Cantonese command read from SenseVoice's first pass must be to skip the second, from 0 to 1.
# The first pass tells the language; the second, set to Cantonese, hears the words better but takes a
# second or two more on a Pi. Most commands are already clear the first time.
SURE = 0.9


def answer_cantonese(audio: bytes, ears: CantoneseEars, homehub: Commander, t0: float, asked: str | None = None,
                     quick: str = '') -> Answer:
    scenes = getattr(homehub, 'scenes', homehub.names)
    command = yue.parse(quick, homehub.names, scenes) if quick else None
    passes = 1
    if command is not None and command.action in ('on', 'off', 'scene') and command.score >= SURE:
        text = quick
    else:
        # Not sure, or a name alone, or an answer to a question: listen again, set to Cantonese.
        text, passes = ears.transcribe(audio), 2
        command = yue.parse(text, homehub.names, scenes)
    # 開 or 熄 alone, answering "你想開定熄廚房燈？".
    if asked and (command is None or command.action == 'ask'):
        verb = yue.verb_alone(text)
        if verb:
            command = yue.Command(verb, asked, 1.0)
    t1 = time.monotonic()
    if not text.strip(' 。，.,!?！？'):
        return Answer('', yue.NOT_UNDERSTOOD, False, t1 - t0, lang='yue', passes=passes)
    # A name alone switches nothing: HomeHub can't know whether on or off was meant.
    act = command if command and command.action != 'ask' else None
    heard = f'{text} → {act.homehub_text}' if act else text
    try:
        # Unread commands go to HomeHub too, as heard, so they're listed with the commands it missed.
        res = homehub.command(act.homehub_text if act else yue.traditional(text))
    except HomeHubError as e:
        log.warning('%s', e)
        return Answer(heard, yue.NO_HOMEHUB, False, t1 - t0, time.monotonic() - t1, lang='yue', passes=passes)
    reply = yue.reply(command, res.handled, res.response, res.failed)
    return Answer(heard, reply, bool(act) and res.handled, t1 - t0, time.monotonic() - t1, lang='yue',
                  asked=command.name if command and command.action == 'ask' else None, passes=passes)


def has_words(text: str) -> bool:
    return bool(text.strip(' .,!?'))


def answer_vietnamese(text: str, homehub: Commander, t0: float, asked: str | None = None) -> Answer:
    scenes = getattr(homehub, 'scenes', homehub.names)
    command = vi.parse(text, homehub.names, scenes, getattr(homehub, 'groups', None))
    # "Bật" or "tắt" alone, answering "Bật hay tắt đèn bếp?".
    if asked and (command is None or command.action == 'ask'):
        verb = vi.verb_alone(text)
        if verb:
            command = vi.Command(verb, asked, 1.0, verb='bật' if verb == 'on' else 'tắt')
    return send_vietnamese(text, command, homehub, t0)


def send_vietnamese(text: str, command: vi.Command | None, homehub: Commander, t0: float) -> Answer:
    t1 = time.monotonic()
    if command is not None and command.action == 'which':
        # "Bật đèn": the name was lost. Ask which, and listen for it.
        return Answer(text, vi.reply(command, False, '', []), False, t1 - t0, lang='vi', asked=vi.which_asked(command))
    # A name alone switches nothing: HomeHub can't know whether on or off was meant.
    act = command if command and command.action != 'ask' else None
    heard = f'{text} → {act.homehub_text}' if act else text
    if command is not None and command.action == 'ask':
        return Answer(heard, vi.reply(command, False, '', []), False, t1 - t0, lang='vi', asked=command.name)
    try:
        # Unread commands go to HomeHub too, as heard, so they're listed with the commands it missed.
        res = homehub.command(act.homehub_text if act else ' '.join(vi.words(text)))
    except HomeHubError as e:
        log.warning('%s', e)
        return Answer(heard, vi.NO_HOMEHUB, False, t1 - t0, time.monotonic() - t1, lang='vi')
    reply = vi.reply(command, res.handled, res.response, res.failed)
    return Answer(heard, reply, bool(act) and res.handled, t1 - t0, time.monotonic() - t1, lang='vi')
