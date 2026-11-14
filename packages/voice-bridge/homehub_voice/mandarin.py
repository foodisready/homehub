"""Reading a Mandarin command by how it sounds.

The same way as Cantonese (see cantonese.py), with Pinyin in place of Jyutping:
speech recognition writes a word with another character that sounds the same,
so a command is compared with the home's Chinese names by their sound, tones
ignored. A Chinese nickname such as 廚房燈 works in both languages, in simplified
or traditional characters.

A command is a verb, then a name: 打开厨房灯, 关掉客厅灯. Mandarin also puts the
verb last: 把客厅灯打开, 客厅灯关了. A scene is its name alone. A light can be
turned on for a while: 打开书房灯十分钟, 开书房灯半小时.

Replies are in simplified characters.
"""
from __future__ import annotations

import re
from functools import lru_cache

from pypinyin import Style, lazy_pinyin

from . import cantonese as yue
from .cantonese import Command, has_chinese

# Verbs, by sound, longest first.
ON_VERBS = [('da', 'kai'), ('kai', 'qi'), ('kai',)]                                      # 打开, 开启, 开
OFF_VERBS = [('guan', 'diao'), ('guan', 'bi'), ('guan', 'shang'), ('xi', 'mie'), ('guan',)]   # 关掉, 关闭, 关上, 熄灭, 关
POLITE = [('qing', 'bang', 'wo'), ('ma', 'fan', 'ni'), ('bang', 'wo'), ('gei', 'wo'), ('ma', 'fan'), ('qing',)]  # 请帮我 麻烦你 帮我 给我 麻烦 请
# 把客厅灯打开: the name comes before the verb.
LEAD = [('ba',), ('jiang',)]                                                             # 把, 将
# Said after the verb or at the end, and not part of the name: 打开一下, 关了吧.
TRAILING = [('yi', 'xia'), ('ba',), ('a',), ('ya',), ('la',), ('ne',), ('le',), ('ma',)]   # 一下 吧 啊 呀 啦 呢 了 嘛

INITIALS = ('zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w')
# Initials often said or heard alike, as in southern accents: 卓 "zhuo" and "zuo", 牛 "niu" and "liu".
CLOSE_INITIALS = [{'zh', 'z'}, {'ch', 'c'}, {'sh', 's'}, {'n', 'l'}, {'f', 'h'}, {'r', 'l'}, {'j', 'q', 'x'},
                  {'b', 'p'}, {'d', 't'}, {'g', 'k'}, {'y', ''}, {'w', ''}]

MATCH = yue.MATCH
MARGIN = yue.MARGIN
SCENE_MATCH = yue.SCENE_MATCH


def _letters(text: str) -> list[str]:
    """Letters speech recognition writes among the characters, one syllable each; anything else dropped."""
    return [c for c in text.lower() if c.isascii() and c.isalpha()]


@lru_cache(maxsize=2048)
def syllables(text: str) -> tuple[str, ...]:
    """Pinyin syllables without tones; simplified or traditional characters both work."""
    out: list[str] = []
    for s in lazy_pinyin(text, style=Style.NORMAL, errors=_letters, v_to_u=False):
        s = s.strip().lower()
        if s and s.isascii() and s.isalpha():
            out.append(s)
    return tuple(out)


def split(s: str) -> tuple[str, str]:
    for i in INITIALS:
        if s.startswith(i) and len(s) > len(i):
            return i, s[len(i):]
    return '', s


def similar(a: str, b: str) -> float:
    """How alike two Pinyin syllables sound, from 0 to 1."""
    if a == b:
        return 1.0
    (ia, fa), (ib, fb) = split(a), split(b)
    close = ia == ib or any(ia in g and ib in g for g in CLOSE_INITIALS)
    if fa == fb:
        return 0.75 if close else 0.5
    if ia == ib and fa.rstrip('g') == fb.rstrip('g'):
        return 0.8   # only -n and -ng differ: 林 "lin" and 灵 "ling"
    if ia == ib:
        return 0.45
    if close and fa[:1] == fb[:1]:
        return 0.35
    return 0.0


def best_name(heard: tuple[str, ...], names: list[str]) -> tuple[str | None, float, float]:
    return yue.best_name(heard, names, syllables, similar)


def _strip_start(s: tuple[str, ...], options: list[tuple[str, ...]]) -> tuple[tuple[str, ...], bool]:
    for words in options:
        if s[:len(words)] == words:
            return s[len(words):], True
    return s, False


def _strip_end(s: tuple[str, ...], options: list[tuple[str, ...]]) -> tuple[tuple[str, ...], bool]:
    for words in options:
        if len(s) > len(words) and s[-len(words):] == words:
            return s[:-len(words)], True
    return s, False


def _trim(s: tuple[str, ...]) -> tuple[str, ...]:
    """Without 一下, 吧, 了 and the like at the end."""
    stripped = True
    while stripped and s:
        s, stripped = _strip_end(s, TRAILING)
    return s


def read_verb(s: tuple[str, ...]) -> tuple[str | None, tuple[str, ...]]:
    """'on' or 'off' and the rest, for a verb first (打开客厅灯) or last (把客厅灯打开)."""
    s, _ = _strip_start(s, POLITE)
    for action, verbs in (('on', ON_VERBS), ('off', OFF_VERBS)):
        rest, found = _strip_start(s, verbs)
        if found:
            rest, _ = _strip_start(rest, [('yi', 'xia')])   # 打开一下客厅灯
            return action, rest
    lead, led = _strip_start(s, LEAD)
    for action, verbs in (('on', ON_VERBS), ('off', OFF_VERBS)):
        rest, found = _strip_end(_trim(lead), verbs)
        if found and rest:
            return action, rest
    if led:
        return None, lead
    return None, s


def verb_alone(text: str) -> str | None:
    """'on' or 'off' for 开 or 关 said on its own (with 吧 or 了 after it), else None."""
    s, _ = _strip_start(_trim(syllables(text)), POLITE)
    for action, verbs in (('on', ON_VERBS), ('off', OFF_VERBS)):
        if any(s == v for v in verbs):
            return action
    return None


def parse(text: str, names: list[str], scenes: list[str] | None = None) -> Command | None:
    """Reads a Mandarin command against the home's Chinese names. None when unsure."""
    chinese = [n for n in names if has_chinese(n)]
    text, minutes = yue.take_duration(text)
    s = _trim(syllables(text))
    # The whole command heard twice.
    half = len(s) // 2
    if half and len(s) % 2 == 0 and s[:half] == s[half:]:
        s = s[:half]
    action, rest = read_verb(s)
    if action and rest:
        name, score, runner = best_name(_trim(rest), chinese)
        if name and score >= MATCH and score - runner >= MARGIN:
            if minutes and action == 'off':
                return None   # "off for ten minutes" isn't something HomeHub does: don't guess
            return Command(action, name, round(score, 2), minutes if action == 'on' else None)
    s = rest if action is None else s   # without 把
    scene_names = [n for n in (scenes or []) if has_chinese(n)]
    name, score, runner = best_name(s, scene_names)
    if name and score >= SCENE_MATCH and score - runner >= MARGIN:
        return Command('scene', name, round(score, 2))
    # A device's name alone: its verb was lost, often cut off after the wake word.
    devices = [n for n in chinese if n not in scene_names]
    name, score, runner = best_name(s, devices)
    if name and score >= SCENE_MATCH and score - runner >= MARGIN:
        return Command('ask', name, round(score, 2))
    return None


@lru_cache(maxsize=1)
def _to_simplified():
    import opencc
    return opencc.OpenCC('t2s').convert


def simplified(text: str) -> str:
    """Simplified characters: how replies are written, whatever script a nickname is in."""
    return _to_simplified()(text)


def plain(text: str) -> str:
    """Without punctuation or spaces: how HomeHub lists a command it missed."""
    return re.sub(r'[\s.,!?。，！？、]', '', text)


# ── Replies ─────────────────────────────────────────────────────

NOT_UNDERSTOOD = '抱歉，我没听懂。'
NOTHING_HEARD = '抱歉，我没听到。'
NO_HOMEHUB = '现在连不上HomeHub。'

_DIGITS = '零一二三四五六七八九'


def number(n: int) -> str:
    """A number as written to be read in Mandarin: 二, 十二, 四十五, 一百零五, 零下三."""
    if n < 0:
        return '零下' + number(-n)
    if n < 10:
        return _DIGITS[n]
    if n < 100:
        tens, units = divmod(n, 10)
        return ('' if tens == 1 else _DIGITS[tens]) + '十' + (_DIGITS[units] if units else '')
    if n < 1000:
        hundreds, rest = divmod(n, 100)
        tail = '' if not rest else ('零' + _DIGITS[rest] if rest < 10 else ('一' if rest < 20 else '') + number(rest))
        return _DIGITS[hundreds] + '百' + tail
    return str(n)


def say_minutes(minutes: int) -> str:
    """A duration as said in Mandarin: 十分钟, 半小时, 一个半小时, 两个小时."""
    def count(n: int) -> str:
        return '两' if n == 2 else number(n)
    if minutes == 30:
        return '半小时'
    hours, rest = divmod(minutes, 60)
    if not hours:
        return f'{number(minutes)}分钟'
    if rest == 30:
        return f'{count(hours)}个半小时'
    return f'{count(hours)}个小时' + (f'{number(rest)}分钟' if rest else '')


def reply(command: Command | None, handled: bool, response: str, failed: list[str]) -> str:
    """A short Mandarin reply from HomeHub's answer. HomeHub's own wording is English."""
    name = simplified(command.name) if command is not None else ''
    if command is not None and command.action == 'ask':
        return f'你要打开还是关掉{name}？'
    if command is None or not handled:
        return NOT_UNDERSTOOD
    if "can't pause cameras" in response:
        return '为了安全，我不能这样暂停摄像头。'
    if 'is protected' in response or 'are protected' in response:
        return f'{name}受保护，我不会动它。' if not failed else '有些设备受保护，我没有动它们。'
    if failed or "couldn't reach" in response:
        return f'连不上{name}。'
    if response.startswith('Which one'):
        return f'有几个设备都叫{name}，请改个名字。'
    if command.action == 'scene':
        return f'好的，{name}。'
    if command.action == 'on' and command.minutes:
        return f'已打开{name}，{say_minutes(command.minutes)}后关掉。'
    return f'已打开{name}。' if command.action == 'on' else f'已关掉{name}。'
