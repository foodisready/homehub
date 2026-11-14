"""Telling talk that wasn't meant for HomeHub from a command it misheard.

A wake word heard in a TV show or a conversation is followed by whatever is said next:
"I don't want to pay for your drink." Answering it ("I heard words, just not ones I know")
talks over the room for nothing. A command that was misheard, though, should be answered,
so the person knows to say it again.

So a miss stays quiet only when nothing in it points at a command: no on or off word in
any language, no part of any of the home's names, and long enough to be a sentence rather
than a clipped command ("Sick." is 熄 cut short, and gets an answer).
"""
from __future__ import annotations

import re

from . import cantonese as yue
from . import mandarin as zh
from . import vietnamese as vi

# On and off words, and others that start a command, in English.
EN_COMMAND = {'on', 'off', 'turn', 'switch', 'start', 'stop', 'open', 'close', 'lock', 'unlock', 'run', 'set', 'dim', 'pause', 'resume'}
VI_COMMAND = set(vi.ON_VERBS) | set(vi.OFF_VERBS) | vi.UNSURE_VERBS | set(vi.NEAR_VERBS)
# Things people switch, in any language: someone saying one is talking to HomeHub. "đèn tép hai
# mươi phút" is a lamp for twenty minutes, misheard; "đền bà" is đèn bà (grandma's lamp).
THINGS = {'lamp', 'lamps', 'light', 'lights', 'den', 'cua', 'quat'}
THING_SOUNDS = {'dang'}   # 燈, and 等 or 登 as it's often misheard

# Shorter than this, a miss is more likely a command cut short than talk.
MIN_WORDS = 3
MIN_SYLLABLES = 4


def _words(text: str) -> list[str]:
    return [w for w in re.split(r"[^\w']+", text.lower()) if w]


def looks_like_chatter(heard: str, names: list[str]) -> bool:
    """True when a miss has nothing of a command in it: say nothing rather than "didn't understand"."""
    text = heard.split(' → ')[0].strip()
    if not text:
        return False
    if yue.has_chinese(text):
        s = yue.syllables(text)
        if len(s) < MIN_SYLLABLES or yue.read_verb(s)[0] or zh.read_verb(zh.syllables(text))[0] or THING_SOUNDS & set(s):
            return False
        # Two sounds of a name in a row is someone trying to say it: 床头 in 的下量床头等.
        return not any(yue.exact(s, yue.syllables(n)) >= 2 for n in names if yue.has_chinese(n))
    ws = _words(vi.plain(text) if vi.has_vietnamese(text) else text)
    if len(ws) < MIN_WORDS:
        return False
    if vi.has_vietnamese(text) and any(w in VI_COMMAND for w in vi.words(text.lower())):
        return False
    if any(w in EN_COMMAND or w in THINGS for w in ws):
        return False
    # Vietnamese words are short (bàn, bếp): three letters is a word of a name.
    shortest = 3 if vi.has_vietnamese(text) else 4
    name_words = {w for n in names for w in _words(vi.plain(n) if vi.has_vietnamese(n) else n) if len(w) >= shortest}
    return not any(w in name_words for w in ws)
