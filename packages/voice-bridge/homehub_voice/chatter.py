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


# Talk that names one of the home's devices is at most this long when it's a command misheard over a
# noisy room ("Have fun for your little lamb for 2 hours."), not a TV's fifteen words or more.
NAMED_WORDS = 12
NAMED_SYLLABLES = 14
# Words in names that aren't the name itself: things, rooms, on and off, little words.
NOT_A_NAME = EN_COMMAND | THINGS | {'room', 'rooms', 'the', 'and', 'with', 'your', 'from', 'that', 'this', 'side', 'left', 'right'}
ZH_NOT_A_NAME = set('係系咪要唔好開开熄關关閂闩燈灯仔個个嘅啦呀咗下埋返分鐘钟半小時时頭头一二兩两三四五六七八九十是不嗎吗吧把打房廳厅')


def says_a_name(heard: str, names: list[str]) -> bool:
    """Whether a few words heard over a noisy room have part of one of the home's names in them:
    "little" of Little breakfast lamp in "Have fun for your little lamb for 2 hours", 早餐 in
    早餐灯仔分钟. Then it was someone speaking to the speaker, however badly it was heard, and it
    answers (asks "Turn on …?", or says it didn't understand and listens once more) rather than
    staying quiet as it does for a TV."""
    text = heard.split(' → ')[0].strip()
    if not text or not names:
        return False
    if yue.has_chinese(text):
        if len(yue.syllables(text)) > NAMED_SYLLABLES:
            return False
        han = lambda t: re.sub(r'[^\u3400-\u9fff]', '', yue.traditional(t))  # noqa: E731
        h = han(text)
        named = [han(n) for n in names if yue.has_chinese(n)]
        return any(h[i:i + 2] in n for i in range(len(h) - 1) if not set(h[i:i + 2]) & ZH_NOT_A_NAME for n in named)
    plain = (lambda t: vi.plain(t)) if vi.has_vietnamese(text) else (lambda t: t)
    ws = _words(plain(text))
    if not ws or len(ws) > NAMED_WORDS:
        return False
    shortest = 3 if vi.has_vietnamese(text) else 4
    not_names = NOT_A_NAME | VI_COMMAND | {vi.plain(w) for w in VI_COMMAND}
    name_words = {w for n in names for w in _words(plain(n)) if len(w) >= shortest and w not in not_names and not w.isdigit()}
    return any(w in name_words for w in ws)


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
    return not any((w in EN_COMMAND and (w not in ON_OFF or switched(ws, i))) or w in THINGS for i, w in enumerate(ws))


# "On" and "off" are everywhere on TV ("fragrances on here", 老友 woke to a Sephora ad, 2026-11-28),
# so in longer talk they count only next to a verb or a thing switched: "turn it on", "lights off".
ON_OFF = {'on', 'off'}
SWITCHED = {'turn', 'switch', 'put', 'fan', 'fans'} | THINGS
SHORT_WORDS = 5


def switched(ws: list[str], i: int) -> bool:
    """Whether the "on" or "off" at ws[i] sounds like a command: in a few words ("kitchen on"), or near a
    verb or a thing people switch ("turn the fan on")."""
    return len(ws) <= SHORT_WORDS or any(w in SWITCHED for w in ws[max(0, i - 5): i + 2])
