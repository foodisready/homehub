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


# A command is a few words. The household's recorded commands are at most six Vietnamese words
# (Bật đèn phòng ngủ lớn) or five Chinese characters (開主人房燈), and a time adds about three
# more. Talk from a TV or a video fills the eight seconds a speaker listens with fifteen or more.
COMMAND_WORDS = 8
COMMAND_SYLLABLES = 10


def command_over_noise(heard: str) -> bool:
    """Whether what was heard is a command said over a noisy room rather than the room's own talk:
    a few words, with an on or off word or a thing people switch in them ("BẬT ĐÈN VU", 开啊皇帝灯).
    Read from the words alone, so it holds whatever HomeHub made of them."""
    text = heard.split(' → ')[0].strip()
    if not text:
        return False
    if yue.has_chinese(text):
        s = yue.syllables(text)
        return len(s) <= COMMAND_SYLLABLES and bool(
            yue.read_verb(s)[0] or zh.read_verb(zh.syllables(text))[0] or THING_SOUNDS & set(s))
    ws = _words(vi.plain(text) if vi.has_vietnamese(text) else text)
    if not ws or len(ws) > COMMAND_WORDS:
        return False
    if vi.has_vietnamese(text) and any(w in VI_COMMAND for w in vi.words(text.lower())):
        return True
    return any(w in EN_COMMAND or w in THINGS for w in ws)


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


def expects_another_language(wake: str, again_lang: str | None = None) -> bool:
    """Whether the person is expected to speak Cantonese, Mandarin or Vietnamese: the wake word is
    written in Chinese characters (老友) or Vietnamese (Xin Chào), or this is the second try after a
    miss in one of them. Unlike pipeline.wake_language, it doesn't need to know which one."""
    wake = wake or ''
    if yue.has_chinese(wake) or vi.has_vietnamese(wake) or 'xin chao' in vi.plain(wake):
        return True
    return again_lang in ('yue', 'zh', 'vi')


def english_talk(heard: str, wake: str, again_lang: str | None = None) -> bool:
    """English with nothing of a command in it, after a Cantonese, Mandarin or Vietnamese wake word:
    a TV or a conversation, not someone speaking to HomeHub. On 2026-11-18, 老友 woke nine times in
    twelve minutes to English TV ("Better day outside. Healthy."), and the room's names in it
    ("outside", "good night") kept looks_like_chatter from calling it talk.

    A short miss is still answered: "Sick." may be 熄 cut off. So is anything with an on or off word
    or a thing people switch in it, in English or in Vietnamese written without its accents."""
    if not expects_another_language(wake, again_lang):
        return False
    text = heard.split(' → ')[0].strip()
    if not text or yue.has_chinese(text) or vi.has_vietnamese(text) or not re.search('[A-Za-z]', text):
        return False
    ws = _words(text)
    if len(ws) < MIN_WORDS:
        return False
    if any(w in VI_COMMAND for w in vi.words(text.lower())):
        return False
    return not any(w in EN_COMMAND or w in THINGS for w in ws)
