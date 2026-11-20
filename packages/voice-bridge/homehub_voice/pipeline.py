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
from collections.abc import Callable
from contextvars import ContextVar
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from typing import Protocol

from . import cantonese as yue
from .chatter import looks_like_chatter
from . import mandarin as zh
from . import questions
from . import ask
from . import confirm
from . import sos
from . import vietnamese as vi
from .homehub import CommandResult, HomeHubError

log = logging.getLogger('homehub-voice')

NOTHING_HEARD = "Sorry, I didn't hear anything."
NOT_CAUGHT = "Sorry, I didn't catch that."
NO_HOMEHUB = "I can't reach HomeHub right now."


class Transcriber(Protocol):
    def transcribe(self, audio: bytes, names: list[str]) -> str: ...


class CantoneseEars(Protocol):
    """SenseVoice: a quick pass that tells the language, and a second set to Cantonese or Mandarin.
    Its `chinese` says which of the two are on, Cantonese alone if it doesn't say."""
    def hear(self, audio: bytes) -> tuple[str, str]: ...
    def transcribe(self, audio: bytes) -> str: ...


class VietnameseEars(Protocol):
    def transcribe(self, audio: bytes) -> str: ...


class Commander(Protocol):
    names: list[str]

    def command(self, text: str, retry: bool = False) -> CommandResult: ...


# The id of HomeHub's "Turn on …?" this command may be the answer to, while it's being answered.
_confirming: ContextVar[str | None] = ContextVar('confirming', default=None)


def to_homehub(homehub: Commander, text: str, lang: str, retry: bool = False, may_ask: bool = True) -> CommandResult:
    """A command for HomeHub. One it doesn't know may come back as a question to ask (with Claude
    chosen in Settings), when may_ask and HomeHub can."""
    if may_ask and getattr(homehub, 'can_ask', False) is True:
        return homehub.command(text, retry=retry, lang=lang, ask=True)
    return homehub.command(text, retry) if retry else homehub.command(text)


def asked_back(heard: str, res: CommandResult, t0: float, t1: float, passes: int = 0) -> Answer | None:
    """HomeHub's own words, when it sent some: "Turn on Porch light?", listening for the answer, or why
    it won't (a garage door is never opened by voice). None for an ordinary answer."""
    if not res.say:
        return None
    lang = res.say_lang or 'en'
    return Answer(heard, res.say, res.confirm_id is None, t1 - t0, time.monotonic() - t1, lang=lang,
                  asked=f'{confirm.PREFIX}{res.confirm_id}' if res.confirm_id else None, passes=passes)


@dataclass
class Answer:
    heard: str
    reply: str
    handled: bool
    stt_s: float = 0.0
    homehub_s: float = 0.0
    # The reply's language: 'en', 'yue', 'vi' or 'zh'.
    lang: str = 'en'
    # The device HomeHub just asked "on or off?" about, waiting for the answer.
    asked: str | None = None
    # How many times SenseVoice listened to a Cantonese command: once if the first was clear.
    passes: int = 0
    # The language SenseVoice's first pass said it was ('yue', 'zh'), for the log.
    label: str = ''
    # Not understood, with Cantonese and Mandarin both on: `lang` was a guess, so another try
    # shouldn't be held to it.
    unsure: bool = False
    # Not understood, and nothing in it was a command: talk from a TV or a conversation, so the
    # speaker says nothing (see chatter.py).
    chatter: bool = False


# "On", "off", "turn it on", "switch it off, please": an answer to "on or off?".
ON_OR_OFF = re.compile(r'^\s*(?:(?:turn|switch)\s+(?:it\s+|them\s+)?)?(on|off)(?:\s+(?:it|them))?(?:,?\s*please)?[\s.!?]*$', re.I)


# Languages SenseVoice reports for Cantonese and Mandarin. Short Cantonese commands are often labelled
# Mandarin ('zh'), so the label alone doesn't decide between the two.
CANTONESE = {'yue', 'zh'}


# The Chinese languages voice can listen in, both written in Chinese characters.
CHINESE = ('yue', 'zh')


def wake_language(wake: str, languages: list[str] | None = None) -> str | None:
    """The language a wake word is in, from how its name is written: Chinese characters (老友) are
    the Chinese language that's on, Vietnamese letters (Xin Chào) are Vietnamese. None when it
    doesn't say (Hey Jarvis), or when it could be more than one: Cantonese and Mandarin are both
    written in Chinese characters. languages: the ones that are on; None means any."""
    wake = wake or ''
    on = lambda lang: languages is None or lang in languages  # noqa: E731
    if vi.is_chinese(wake):
        chinese = [lang for lang in CHINESE if on(lang)]
        return chinese[0] if len(chinese) == 1 else None
    if (vi.has_vietnamese(wake) or 'xin chao' in vi.plain(wake)) and on('vi'):
        return 'vi'
    return None


# Where SenseVoice listens while the Vietnamese model does: a Pi 4 has four cores, and each model
# uses two, so the pair takes about 0.8 s instead of 1.05 s.
_beside = ThreadPoolExecutor(1, thread_name_prefix='sensevoice')
# Where SenseVoice's second pass, set to Cantonese, starts as soon as the Vietnamese model is done,
# while the first pass still runs. 16 of 37 Cantonese test commands need it; for them the reply came
# 0.4 s sooner on a Pi 4 (1.8 s to 1.4 s), and the rest were about as fast as before. For English the
# result is thrown away.
_second = ThreadPoolExecutor(1, thread_name_prefix='cantonese')

# HomeHub's reply when a name fits several devices ("the lights"). Fine in Chat, but read out it's a
# list of every light, so the speaker asks "Which light?" and listens for the answer instead.
SEVERAL = re.compile(r'^Which one do you mean: ')
# The follow-up after "Which light?": the verb and how long, until the name comes.
EN_WHICH_PREFIX = 'en-which:'
FOR_HOW_LONG = re.compile(r'\s+for\s+\S.*$', re.I)


def answer(audio: bytes, spoke: bool, listener: Transcriber, homehub: Commander,
           ears: CantoneseEars | None = None, asked: str | None = None,
           vi_ears: VietnameseEars | None = None, prefer: str | None = None, where: str = '') -> Answer:
    """What was heard and what to say back; a miss with nothing of a command in it is marked chatter."""
    token = _confirming.set(asked[len(confirm.PREFIX):] if asked and asked.startswith(confirm.PREFIX) else None)
    try:
        a = _answer(audio, spoke, listener, homehub, ears, asked, vi_ears, prefer, where)
    finally:
        _confirming.reset(token)
    if not a.handled and a.asked is None and not asked and looks_like_chatter(a.heard, list(getattr(homehub, 'names', []))):
        a.chatter = True
    return a


def _answer(audio: bytes, spoke: bool, listener: Transcriber, homehub: Commander,
           ears: CantoneseEars | None = None, asked: str | None = None,
           vi_ears: VietnameseEars | None = None, prefer: str | None = None, where: str = '') -> Answer:
    """asked: the device HomeHub just asked "on or off?" about, if any, so "on" alone answers it.
    prefer: the language the speaker was woken in ("Xin chào"), or the question being answered
    was asked in. Misheard Vietnamese is answered in Vietnamese, not taken for Cantonese."""
    if not spoke:
        return Answer('', NOTHING_HEARD, False)
    t0 = time.monotonic()
    # Straight after a reminder asked "done yet?": its answer is read more loosely.
    just_asked = bool(asked and asked.startswith(ask.PREFIX))
    if asked == sos.ASKED or just_asked or (asked and asked.startswith(confirm.PREFIX)):
        asked = None   # listening for "cancel" or an answer: anything else is taken as usual
    which = asked if asked and asked.startswith(vi.WHICH_PREFIX) else None
    en_which = asked if asked and asked.startswith(EN_WHICH_PREFIX) else None
    if which or en_which:
        asked = None   # not a device's name: nothing else has an "on or off?" to answer
    if en_which:
        prefer = 'en'
    use_vi = vi_ears is not None and (prefer not in ('yue', 'zh', 'en') or which)
    # SenseVoice starts at the same time as the Vietnamese model, which is usually done first.
    hearing = _beside.submit(ears.hear, audio) if ears is not None and use_vi else None
    heard_vi = ''
    if use_vi:
        # First, since SenseVoice takes most Vietnamese for Cantonese. It takes about a third of a
        # second on a Pi, and what it writes for English or Cantonese is never a Vietnamese command.
        heard = heard_vi = vi_ears.transcribe(audio)
        if a := special(heard, 'vi', homehub, t0, where, just_asked):
            return a
        if which and has_words(heard):
            command = vi.answer_which(which, heard, homehub.names, getattr(homehub, 'groups', None))
            if command is not None:
                return send_vietnamese(heard, command, homehub, t0)
        kind = questions.vi_kind(heard) if not which else None
        if kind:
            # "Mấy giờ rồi?", "thời tiết hôm nay thế nào?"
            return answer_question(heard, kind, 'vi', homehub, t0)
        if vi.is_vietnamese(heard, homehub.names, getattr(homehub, 'scenes', homehub.names),
                            getattr(homehub, 'groups', None), asked):
            return answer_vietnamese(heard, homehub, t0, asked)
    # Woken in Vietnamese, or answering a Vietnamese question, and the Vietnamese model heard
    # Vietnamese words, but not a command: answer in Vietnamese ("Xin lỗi, tôi không hiểu"), not in
    # the Cantonese SenseVoice would guess. English, which the Vietnamese model writes without
    # Vietnamese letters ("CROUN CUTION"), goes on as English: "Xin chào" is said before English too.
    in_vietnamese = bool(prefer == 'vi' or which) and vi.has_vietnamese(heard_vi)
    quick = ''
    if ears is not None:
        chinese = chinese_on(ears)
        # The second pass starts straight away, set to the language a hint gives, or the first that's on.
        first = prefer if prefer in chinese else chinese[0]
        second = _second.submit(heard_again, ears, audio, first) if not in_vietnamese and not en_which else None
        lang, quick = hearing.result() if hearing is not None else ears.hear(audio)
        if in_vietnamese and lang != 'en':
            return answer_vietnamese(heard_vi, homehub, t0, asked)
        if lang in CANTONESE and not en_which:
            order = tuple(dict.fromkeys(x for x in (prefer, lang, *chinese) if x in chinese))
            for l in order:
                if a := special(quick, l, homehub, t0, where, just_asked):
                    return a
            a = answer_chinese(audio, ears, homehub, t0, asked, quick, second, prefer, lang, where)
            a.label = lang
            return a
    elif in_vietnamese:
        return answer_vietnamese(heard_vi, homehub, t0, asked)
    # English. SenseVoice has already heard the words, in about a second; Whisper takes about ten
    # on a Pi, but knows the home's device names. So try SenseVoice's words first, and ask Whisper
    # only if HomeHub doesn't understand them.
    if quick.strip(' .,!?'):
        quick = completed(quick, en_which)
        # As heard, then with the device's name spelled as HomeHub knows it ("my office la" → "My office lamp").
        if a := special(quick, 'en', homehub, t0, where, just_asked):
            return a
        for text in dict.fromkeys([quick, closest_name(quick, homehub.names)]):
            first = english(text, homehub, asked, retry=True)
            if first[1] is None or first[1].handled:
                return finish(first, time.monotonic() - t0)
    text = listener.transcribe(audio, homehub.names)
    if not text.strip(' .,!?'):
        return Answer('', NOT_CAUGHT, False, time.monotonic() - t0)
    if a := special(text, 'en', homehub, t0, where, just_asked):
        return a
    return finish(english(completed(text, en_which), homehub, asked), time.monotonic() - t0)


def which_asked(sent: str) -> tuple[str, str | None]:
    """For a command whose name fits several devices: the question to ask ("Which light?"), and
    what to remember for the answer. None when the command can't be read back."""
    m = SWITCH.match(sent)
    if not m:
        return 'Which one?', None
    name = m.group(2)
    how_long = FOR_HOW_LONG.search(name)
    name = FOR_HOW_LONG.sub('', name).strip()
    last = name.split()[-1].lower() if name.split() else ''
    kind = last[:-1] if last.endswith('s') and not last.endswith('ss') else last
    question = f'Which {kind}?' if kind.isalpha() and kind not in ('them', 'it', 'all', 'everything') else 'Which one?'
    return question, f'{EN_WHICH_PREFIX}{m.group(1).lower()}|{how_long.group(0) if how_long else ""}'


def completed(text: str, en_which: str | None) -> str:
    """The answer to "Which light?" ("the kitchen") made the command first asked for
    ("turn on the kitchen for 10 minutes"). A whole command again is taken as it is."""
    if not en_which or SWITCH.match(text):
        return text
    verb, _, how_long = en_which[len(EN_WHICH_PREFIX):].partition('|')
    return f'{verb} {text.strip(" .,!?")}{how_long}'


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
        return heard, to_homehub(homehub, send, 'en', retry), time.monotonic() - t
    except HomeHubError as e:
        log.warning('%s', e)
        return heard, None, time.monotonic() - t


def finish(sent: tuple[str, CommandResult | None, float], total_s: float) -> Answer:
    heard, res, homehub_s = sent
    if res is None:
        return Answer(heard, NO_HOMEHUB, False, total_s - homehub_s, homehub_s)
    if res.say:
        return Answer(heard, res.say, res.confirm_id is None, total_s - homehub_s, homehub_s, lang=res.say_lang or 'en',
                      asked=f'{confirm.PREFIX}{res.confirm_id}' if res.confirm_id else None)
    if SEVERAL.match(res.response or ''):
        # "Turn on the lights" fits several: ask which, rather than read out every light's name.
        question, follow_up = which_asked(heard.split(' → ')[-1])
        return Answer(heard, question, False, total_s - homehub_s, homehub_s, asked=follow_up)
    return Answer(heard, res.response or NOT_CAUGHT, res.handled, total_s - homehub_s, homehub_s)


# How sure a Cantonese command read from SenseVoice's first pass must be to skip the second, from 0 to 1.
# The first pass tells the language; the second, set to Cantonese, hears the words better but takes a
# second or two more on a Pi. Most commands are already clear the first time.
SURE = 0.9


@dataclass(frozen=True)
class Chinese:
    """How one Chinese language is read and answered."""
    lang: str
    parse: Callable
    has_verb: Callable[[str], bool]   # starts with an on or off word: a command, if not one understood
    kind: Callable                 # which question it asks, if one
    verb_alone: Callable
    reply: Callable
    unread: Callable[[str], str]   # a command it couldn't read, as sent to HomeHub to be listed
    not_understood: str
    no_homehub: str


WAYS = {
    'yue': Chinese('yue', yue.parse, lambda t: yue.read_verb(yue.syllables(t))[0] is not None, questions.yue_kind, yue.verb_alone, yue.reply, yue.traditional,
                   yue.NOT_UNDERSTOOD, yue.NO_HOMEHUB),
    'zh': Chinese('zh', zh.parse, lambda t: zh.read_verb(zh.syllables(t))[0] is not None, questions.zh_kind, zh.verb_alone, zh.reply, zh.plain,
                  zh.NOT_UNDERSTOOD, zh.NO_HOMEHUB),
}


def chinese_on(ears: CantoneseEars) -> tuple[str, ...]:
    on = getattr(ears, 'chinese', None)
    return tuple(on) if isinstance(on, (tuple, list)) and on else ('yue',)


def heard_again(ears: CantoneseEars, audio: bytes, lang: str) -> str:
    """SenseVoice's second pass, set to `lang`."""
    return ears.transcribe(audio) if lang == chinese_on(ears)[0] else ears.transcribe(audio, lang)


@dataclass
class Reading:
    text: str
    command: yue.Command | None
    kind: str | None   # a question instead: 'time', 'today', ...
    passes: int

    @property
    def understood(self) -> bool:
        return self.kind is not None or (self.command is not None and self.command.action != 'ask')


def read_chinese(way: Chinese, audio: bytes, ears: CantoneseEars, homehub: Commander, asked: str | None,
                 quick: str, second: Future | None) -> Reading:
    """What a Cantonese or Mandarin command says, from SenseVoice's first pass if that's clear,
    otherwise from a second pass set to the language."""
    scenes = getattr(homehub, 'scenes', homehub.names)
    kind = way.kind(quick)
    if kind:
        # 幾點呀？ 今日天氣點？ 现在几点？
        return Reading(quick, None, kind, 1)
    groups = getattr(homehub, 'groups', None)
    command = way.parse(quick, homehub.names, scenes, groups) if quick else None
    passes = 1
    if command is not None and command.action in ('on', 'off', 'scene') and command.score >= SURE:
        text = quick
    else:
        # Not sure, or a name alone, or an answer to a question: listen again, set to the language.
        text, passes = (second.result() if second is not None else heard_again(ears, audio, way.lang)), 2
        if k := special_kind(text, way.lang, homehub):
            return Reading(text, None, k, 2)
        command = way.parse(text, homehub.names, scenes, groups)
        kind = way.kind(text) if command is None else None
        if kind:
            return Reading(text, None, kind, 2)
    # 開 or 熄 alone, answering "你想開定熄廚房燈？"; 开 or 关, answering "你要打开还是关掉厨房灯？".
    if asked and (command is None or command.action == 'ask'):
        verb = way.verb_alone(text)
        if verb:
            command = yue.Command(verb, asked, 1.0)
    return Reading(text, command, None, passes)


def send_chinese(way: Chinese, r: Reading, homehub: Commander, t0: float, where: str = '') -> Answer:
    if r.kind in (sos.RAISE, sos.CANCEL, ask.YES, ask.NO, CONFIRMED):
        a = special(r.text, way.lang, homehub, t0, where)
        return a or Answer(r.text, way.not_understood, False, time.monotonic() - t0, lang=way.lang, passes=r.passes)
    if r.kind:
        return answer_question(r.text, r.kind, way.lang, homehub, t0, passes=r.passes)
    text, command, passes = r.text, r.command, r.passes
    t1 = time.monotonic()
    if not text.strip(' 。，.,!?！？'):
        return Answer('', way.not_understood, False, t1 - t0, lang=way.lang, passes=passes)
    # A name alone switches nothing: HomeHub can't know whether on or off was meant.
    act = command if command and command.action != 'ask' else None
    heard = f'{text} → {act.homehub_text}' if act else text
    try:
        # Unread commands go to HomeHub too, as heard, so they're listed with the commands it missed.
        res = to_homehub(homehub, act.homehub_text if act else way.unread(text), way.lang, may_ask=command is None)
    except HomeHubError as e:
        log.warning('%s', e)
        return Answer(heard, way.no_homehub, False, t1 - t0, time.monotonic() - t1, lang=way.lang, passes=passes)
    if a := asked_back(heard, res, t0, t1, passes):
        return a
    reply = way.reply(command, res.handled, res.response, res.failed)
    return Answer(heard, reply, bool(act) and res.handled, t1 - t0, time.monotonic() - t1, lang=way.lang,
                  asked=command.name if command and command.action == 'ask' else None, passes=passes)


def answer_cantonese(audio: bytes, ears: CantoneseEars, homehub: Commander, t0: float, asked: str | None = None,
                     quick: str = '', second: Future | None = None) -> Answer:
    return send_chinese(WAYS['yue'], read_chinese(WAYS['yue'], audio, ears, homehub, asked, quick, second), homehub, t0)


def answer_chinese(audio: bytes, ears: CantoneseEars, homehub: Commander, t0: float, asked: str | None,
                   quick: str, second: Future | None, prefer: str | None, label: str = '', where: str = '') -> Answer:
    """Cantonese or Mandarin. With one of them on, or a hint (the wake word, or the question being
    answered), that one. With both on and no hint, SenseVoice's label (`label`) and the words decide:
    a first pass that's clearly a command in one language, and not as clearly in the other, is that
    language. 打开厨房灯 reads as well in both, since 打开 is said in both, so then the label decides.
    Otherwise the labelled language is read first, with a second pass, and the other if it misses."""
    chinese = chinese_on(ears)
    if len(chinese) == 1 or prefer in chinese:
        way = WAYS[prefer if prefer in chinese else chinese[0]]
        return send_chinese(way, read_chinese(way, audio, ears, homehub, asked, quick, second), homehub, t0, where)
    order = ['zh', 'yue'] if label == 'zh' else ['yue', 'zh']
    if quick:
        scenes = getattr(homehub, 'scenes', homehub.names)
        sure = [(c.score, -order.index(lang), lang, c) for lang in order
                if (c := WAYS[lang].parse(quick, homehub.names, scenes, getattr(homehub, 'groups', None))) is not None and c.action != 'ask' and c.score >= SURE]
        if sure:
            _, _, lang, command = max(sure, key=lambda x: (x[0], x[1]))
            return send_chinese(WAYS[lang], Reading(quick, command, None, 1), homehub, t0, where)
    # The early second pass was set to the first language that's on; another is heard here.
    pass_for = lambda lang: second if lang == chinese[0] else None  # noqa: E731
    first = read_chinese(WAYS[order[0]], audio, ears, homehub, asked, quick, pass_for(order[0]))
    if first.understood or (first.command is not None and first.command.action == 'ask'):
        return send_chinese(WAYS[order[0]], first, homehub, t0, where)
    other = read_chinese(WAYS[order[1]], audio, ears, homehub, asked, quick, pass_for(order[1]))
    if other.understood:
        return send_chinese(WAYS[order[1]], other, homehub, t0, where)
    # Neither understood it. The reading with an on or off word in it is more likely the language
    # spoken, and its words more use in the list of missed commands: 關主人房燈 heard as Cantonese,
    # not 换检防单 heard as Mandarin. The label decides if both or neither have one.
    if WAYS[order[1]].has_verb(other.text) and not WAYS[order[0]].has_verb(first.text):
        lang, reading = order[1], other
    else:
        lang, reading = order[0], first
    a = send_chinese(WAYS[lang], reading, homehub, t0, where)
    a.unsure = True
    return a


# special_kind's answer for a yes or no to HomeHub's "Turn on …?".
CONFIRMED = 'confirmed'


def special_kind(text: str, lang: str, homehub: Commander) -> str | None:
    """A call for help or "cancel" (sos), or, while a reminder is waiting for one, a yes or no (ask)."""
    if _confirming.get() and confirm.loose_kind(text, lang):
        return CONFIRMED
    return sos.kind(text, lang) or (ask.any_kind(text, lang, homehub) if getattr(homehub, 'asking', None) else None)


def special(text: str, lang: str, homehub: Commander, t0: float, where: str, just_asked: bool = False) -> Answer | None:
    """Said to the speaker rather than a command: a call for help, "cancel" after one, or the answer
    to a reminder's "done yet?". None for anything else, which goes on as usual."""
    k = sos.kind(text, lang)
    if k and (a := answer_sos(k, text, lang, homehub, t0, where)):
        return a
    # "Yes" just after HomeHub asked "Turn on …?": that question, before any reminder's.
    confirming = _confirming.get()
    if confirming and (k := confirm.loose_kind(text, lang)):
        t1 = time.monotonic()
        r = confirm.run(k, confirming, lang, homehub)
        if r is None:
            return Answer(f'{text} → {k}', NO_HOMEHUB if lang == 'en' else {'vi': vi.NO_HOMEHUB, 'yue': yue.NO_HOMEHUB, 'zh': zh.NO_HOMEHUB}.get(lang, NO_HOMEHUB),
                          False, t1 - t0, time.monotonic() - t1, lang=lang)
        # Answered: a second pass of the same words mustn't answer it again.
        _confirming.set(None)
        return Answer(f'{text} → {k}', r.reply, r.handled, t1 - t0, r.homehub_s, lang=r.lang)
    # A check-in's "are you OK?" before a reminder's "done yet?": "好" answers the check-in.
    for what in ask.kinds_waiting(homehub):
        waiting = ask.waiting(homehub, None, what)
        if waiting and (k := (ask.loose_kind if just_asked else ask.kind)(text, lang, what)):
            t1 = time.monotonic()
            r = ask.run(k, lang, homehub, waiting, what)
            if r:
                return Answer(f'{text} → {what} {k}', r.reply, True, t1 - t0, r.homehub_s, lang=lang)
    return None


def answer_sos(k: str, heard: str, lang: str, homehub: Commander, t0: float, where: str) -> Answer | None:
    """A call for help, or "cancel" after one: HomeHub tells the family. None for a "cancel" with
    nothing to cancel, so it's heard as usual."""
    t1 = time.monotonic()
    r = sos.run(k, heard, lang, homehub, where)
    if r is None:
        return None
    return Answer(f'{heard} → SOS {k}', r.reply, r.handled, t1 - t0, r.homehub_s, lang=lang,
                  asked=sos.ASKED if r.listen else None)


def answer_question(heard: str, kind: str, lang: str, homehub: Commander, t0: float, passes: int = 0) -> Answer:
    """The time, the date or the weather, asked in Vietnamese, Cantonese or Mandarin: HomeHub is asked in
    English, and its numbers are said in the language that was spoken."""
    t1 = time.monotonic()
    send = questions.ENGLISH[kind]
    try:
        # What was heard goes too, so HomeHub's Claude (when chosen) can find a city or a follow-up in it
        # and answer in words of its own. A HomeHub that can't ask is sent the question alone, as before.
        res = homehub.command(send, lang=lang, heard=heard) if getattr(homehub, 'can_ask', False) is True else homehub.command(send)
    except HomeHubError as e:
        log.warning('%s', e)
        return Answer(heard, vi.NO_HOMEHUB if lang == 'vi' else WAYS[lang].no_homehub, False, t1 - t0,
                      time.monotonic() - t1, lang=lang, passes=passes)
    if res.handled and res.say:
        return Answer(f'{heard} → {send}', res.say, True, t1 - t0, time.monotonic() - t1,
                      lang=res.say_lang or lang, passes=passes)
    say = {'vi': questions.vi_reply, 'zh': questions.zh_reply}.get(lang, questions.yue_reply)
    reply = say(kind, res.info if res.handled else None)
    return Answer(f'{heard} → {send}', reply, res.handled and res.info is not None, t1 - t0,
                  time.monotonic() - t1, lang=lang, passes=passes)


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
        res = to_homehub(homehub, act.homehub_text if act else ' '.join(vi.words(text)), 'vi', may_ask=command is None)
    except HomeHubError as e:
        log.warning('%s', e)
        return Answer(heard, vi.NO_HOMEHUB, False, t1 - t0, time.monotonic() - t1, lang='vi')
    if a := asked_back(heard, res, t0, t1):
        return a
    reply = vi.reply(command, res.handled, res.response, res.failed)
    return Answer(heard, reply, bool(act) and res.handled, t1 - t0, time.monotonic() - t1, lang='vi')
