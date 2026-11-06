"""Reading a Cantonese command by how it sounds.

Speech recognition often writes a Cantonese word with another character that
sounds the same: 民房 for 文房 (both "man fong"), 识 for 熄 ("sik"). So the
command is compared with the home's Cantonese names by their Jyutping
pronunciation, tones ignored, rather than by their characters.

A command is a verb, then a name: 開廚房燈, 熄卓希房燈. Only the first word is
read as the verb, so a name that starts with a verb's sound (卓 sounds like 着)
is still a name. A scene is its name alone: 晚安.

The result is passed to HomeHub as "turn on <name>" or "run <name>", where the
name is exactly as HomeHub knows it, so HomeHub's own rules (protected devices,
groups, cameras) still decide what happens.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache

import ToJyutping

# Verbs, by sound. Each may be said alone or after 幫我 / 唔該 ("please").
ON_VERBS = [('daa', 'hoi'), ('hoi',), ('zoek',)]                        # 打開, 開, 着
OFF_VERBS = [('gwaan', 'bai'), ('gwaan',), ('sik',), ('saan',), ('so',)]   # 關閉, 關, 熄, 閂, 鎖
POLITE = [('bong', 'ngo'), ('m', 'goi')]                                # 幫我, 唔該
# Said after the name ("開廚房燈啦"), and not part of it.
TRAILING = {'aa', 'laa', 'lo', 'le', 'ge', 'zo', 'saai', 'faan'}           # 呀 啦 囉 咧 嘅 咗 晒 返

# Letters speech recognition sometimes writes for a sound ("k" for 希), as Cantonese speakers say them.
LETTERS = {'a': 'ei', 'b': 'bi', 'c': 'si', 'd': 'di', 'e': 'ji', 'g': 'zi', 'j': 'zei', 'k': 'kei', 'o': 'ou',
           'p': 'pi', 'q': 'kiu', 't': 'ti', 'u': 'ju', 'v': 'wi', 'y': 'waai', 'z': 'zi'}

INITIALS = ('gw', 'kw', 'ng', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'z', 'c', 's', 'j', 'w')
# Initials speech recognition mixes up: 卓 "coek" and 着 "zoek", 住 "zyu" and 字 "zi".
CLOSE_INITIALS = [set('zcsj'), {'g', 'gw'}, {'k', 'kw', 'h'}, {'n', 'l'}, {'ng', ''}, {'b', 'p'}, {'d', 't'}]

# How sure a name match must be, from 0 to 1, and how far ahead of the next-best name.
MATCH = 0.72
MARGIN = 0.08
SCENE_MATCH = 0.85


@dataclass(frozen=True)
class Command:
    """What was said: switch a name on or off, or run a scene."""
    action: str        # 'on', 'off', 'scene', or 'ask': a device's name alone, so ask on or off
    name: str          # as HomeHub knows it
    score: float

    @property
    def homehub_text(self) -> str:
        return f'run {self.name}' if self.action == 'scene' else f'turn {self.action} {self.name}'


def has_chinese(text: str) -> bool:
    return any('㐀' <= c <= '鿿' for c in text)


@lru_cache(maxsize=2048)
def syllables(text: str) -> tuple[str, ...]:
    """Jyutping syllables without tones; simplified or traditional characters both work."""
    out: list[str] = []
    for ch, jp in ToJyutping.get_jyutping_list(text):
        if jp:
            out += [re.sub(r'\d', '', s) for s in jp.split()]
        elif ch.isascii() and ch.isalpha():
            out += [LETTERS.get(c, c) for c in ch.lower()]
    return tuple(out)


def split(s: str) -> tuple[str, str]:
    for i in INITIALS:
        if s.startswith(i) and len(s) > len(i):
            return i, s[len(i):]
    return '', s


def similar(a: str, b: str) -> float:
    """How alike two syllables sound, from 0 to 1."""
    if a == b:
        return 1.0
    (ia, fa), (ib, fb) = split(a), split(b)
    close = ia == ib or any(ia in g and ib in g for g in CLOSE_INITIALS)
    if fa == fb:
        return 0.75 if close else 0.5
    if ia == ib and fa.rstrip('ptkmn') == fb.rstrip('ptkmn').rstrip('g'):
        return 0.8   # only the final consonant differs: 文 "man" and 民 "man"/"mang"
    if ia == ib:
        return 0.45
    if close and fa[:1] == fb[:1]:
        return 0.35
    return 0.0


def match(heard: tuple[str, ...], name: tuple[str, ...]) -> float:
    """How well the heard syllables sound like the name, aligned in order, from 0 to 1."""
    if not heard or not name:
        return 0.0
    n, m = len(heard), len(name)
    gap = -0.6
    # best[i][j]: best total for the first i heard and first j name syllables.
    best = [[gap * (i + j) for j in range(m + 1)] for i in range(n + 1)]
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            best[i][j] = max(best[i - 1][j - 1] + similar(heard[i - 1], name[j - 1]),
                             best[i - 1][j] + gap, best[i][j - 1] + gap)
    return max(0.0, best[n][m] / max(n, m))


def _strip_start(s: tuple[str, ...], options: list[tuple[str, ...]]) -> tuple[tuple[str, ...], bool]:
    for words in options:
        if s[:len(words)] == words:
            return s[len(words):], True
    return s, False


def read_verb(s: tuple[str, ...]) -> tuple[str | None, tuple[str, ...]]:
    s, _ = _strip_start(s, POLITE)
    rest, on = _strip_start(s, ON_VERBS)
    if on:
        return 'on', rest
    rest, off = _strip_start(s, OFF_VERBS)
    if off:
        return 'off', rest
    # A one-word verb heard as a near sound (即 "zik" for 熄 "sik"), when it can only be one of them.
    if len(s) > 1:
        close = {action for action, verbs in (('on', ON_VERBS), ('off', OFF_VERBS))
                 for v in verbs if len(v) == 1 and similar(s[0], v[0]) >= 0.75}
        if len(close) == 1:
            return close.pop(), s[1:]
    return None, s


def best_name(heard: tuple[str, ...], names: list[str]) -> tuple[str | None, float, float]:
    """The closest name, its score, and the score of the closest that sounds different."""
    scored = sorted(((match(heard, syllables(n)), n) for n in names), reverse=True)
    if not scored:
        return None, 0.0, 0.0
    top_score, top = scored[0]
    runner = next((sc for sc, n in scored[1:] if syllables(n) != syllables(top)), 0.0)
    return top, top_score, runner


def parse(text: str, names: list[str], scenes: list[str] | None = None) -> Command | None:
    """Reads a Cantonese command against the home's Cantonese names. None when unsure."""
    cantonese = [n for n in names if has_chinese(n)]
    s = syllables(text)
    while s and s[-1] in TRAILING:
        s = s[:-1]
    action, rest = read_verb(s)
    if action and rest:
        name, score, runner = best_name(rest, cantonese)
        if name and score >= MATCH and score - runner >= MARGIN:
            return Command(action, name, round(score, 2))
        # Not a verb after all, but the start of a name heard alone: 卓希房燈 starts like 着.
    scene_names = [n for n in (scenes or []) if has_chinese(n)]
    name, score, runner = best_name(s, scene_names)
    if name and score >= SCENE_MATCH and score - runner >= MARGIN:
        return Command('scene', name, round(score, 2))
    # A device's name alone: its 開 or 熄 was lost, often cut off after the wake word.
    devices = [n for n in cantonese if n not in scene_names]
    name, score, runner = best_name(s, devices)
    if name and score >= SCENE_MATCH and score - runner >= MARGIN:
        return Command('ask', name, round(score, 2))
    return None


@lru_cache(maxsize=1)
def _to_traditional():
    import opencc
    return opencc.OpenCC('s2hk').convert


def traditional(text: str) -> str:
    """Hong Kong characters, without punctuation or spaces: how HomeHub lists a command it missed."""
    return re.sub(r'[\s.,!?。，！？、]', '', _to_traditional()(text))


# ── Replies ─────────────────────────────────────────────────────

NOT_UNDERSTOOD = '唔好意思，我聽唔明。'
NOTHING_HEARD = '唔好意思，我聽唔到。'
NO_HOMEHUB = '而家連唔到HomeHub。'


def reply(command: Command | None, handled: bool, response: str, failed: list[str]) -> str:
    """A short Cantonese reply from HomeHub's answer. HomeHub's own wording is English."""
    if command is not None and command.action == 'ask':
        return f'你想開定熄{command.name}？'
    if command is None or not handled:
        return NOT_UNDERSTOOD
    if "can't pause cameras" in response:
        return '為咗安全，我唔可以咁樣暫停鏡頭。'
    if 'is protected' in response or 'are protected' in response:
        return f'{command.name}受保護，我唔會郁佢。' if not failed else '有啲設備受保護，我冇郁佢哋。'
    if failed or "couldn't reach" in response:
        return f'連唔到{command.name}。'
    if response.startswith('Which one'):
        return f'有幾個都叫{command.name}，請改個名。'
    if command.action == 'scene':
        return f'搞掂，{command.name}。'
    return f'開咗{command.name}。' if command.action == 'on' else f'熄咗{command.name}。'
