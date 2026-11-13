"""Reading a Vietnamese command.

A command is a verb, then a name: "bật đèn bếp", "tắt hết đèn phòng khách",
"mở cửa ga-ra". The name is compared with the home's names with the accents
taken off and by how its letters line up, because speech recognition sometimes
gets an accent or a letter wrong ("phong cách" for "phòng khách", "ga" for
"ga-ra"). The verb is read with its accents, since they are what tell "bật"
(on) from "bắt", which several models wrote for "tắt" (off). A verb that's
close to both isn't guessed: HomeHub asks "Bật hay tắt …?".

A light can be turned on for a while: "bật đèn bếp mười phút", "bật đèn bếp
trong nửa tiếng", "bật đèn bếp một tiếng rồi tắt".

The result is passed to HomeHub as "turn on <name>" or "run <name>", where the
name is exactly as HomeHub knows it, so HomeHub's own rules (protected devices,
groups, cameras) still decide what happens.
"""
from __future__ import annotations

import difflib
import re
import unicodedata
from dataclasses import dataclass

# The verbs, with their accents. "mở" and "đóng" are also how a garage door is opened and closed.
ON_VERBS = {'bật': 'bật', 'mở': 'mở'}
OFF_VERBS = {'tắt': 'tắt', 'đóng': 'đóng'}
# Heard for "bật" or "tắt" but with the wrong accent or letter: could be either, so ask.
UNSURE_VERBS = {'bắt', 'bất', 'bặt', 'bạt', 'bát', 'tất', 'tặt', 'tạt', 'tát', 'tác'}
# The same verb with an accent misheard, where only one verb sounds like it ("mỡ" for "mở"). A final
# c for t, with the tone right, is only ever the one verb: a tablet across the room gave "bậc đèn".
NEAR_VERBS = {'mỡ': 'mở', 'mơ': 'mở', 'mổ': 'mở', 'mỏ': 'mở', 'đông': 'đóng', 'đồng': 'đóng', 'đong': 'đóng',
              'bậc': 'bật', 'tắc': 'tắt'}
# Before the verb: "làm ơn", "hãy", "giúp tôi".
POLITE = [('làm', 'ơn'), ('xin',), ('hãy',), ('giúp', 'tôi'), ('giúp', 'em'), ('giúp', 'con'), ('giúp',)]
# Between the verb and the name: "tắt hết đèn", "bật giúp đèn", "bật cho tôi đèn".
AFTER_VERB = [('hết',), ('giúp', 'tôi'), ('giúp', 'em'), ('giúp',), ('giùm',), ('cho', 'tôi'), ('cho', 'em'),
              ('cho', 'con'), ('lên',), ('cái',)]
# Said after the name, and not part of it: "bật đèn bếp đi", "tắt đèn bếp giùm nhé".
TRAILING = {'đi', 'nhé', 'nha', 'nhá', 'với', 'giùm', 'giúp', 'ạ', 'lên', 'luôn', 'hộ', 'dùm', 'tôi', 'em', 'con'}
# Words in front of a name that people say or leave out: "đèn bếp" and "bếp", "cửa ga-ra" and "ga-ra".
NAME_PREFIXES = ('den ', 'cai ', 'cua ')

# How alike a heard name and a real one must be, from 0 to 1, and how far ahead of the next-best device.
MATCH = 0.78
MARGIN = 0.1
# For a name said alone (a scene, or a device whose verb was lost), which needs to be clearer.
ALONE_MATCH = 0.88
# A word more or less: "phòng ngủ" and "phòng ngủ lớn" are two rooms.
WORD_GAP = -0.5
PREFIX_LEFT_OUT = 0.99


@dataclass(frozen=True)
class Command:
    """What was said: switch a name on or off, run a scene, or ask on or off."""
    action: str        # 'on', 'off', 'scene', 'ask' (a name alone: on or off?), or 'which' (a verb and "đèn" alone: which light?)
    name: str          # as HomeHub knows it; for 'which', the word said ("đèn", "cửa")
    score: float
    minutes: int | None = None   # with 'on': turn it off again after this long
    verb: str = ''               # the verb as said, for the reply: "mở" for a door, "bật" for a light

    @property
    def homehub_text(self) -> str:
        if self.action == 'scene':
            return f'run {self.name}'
        if self.action == 'on' and self.minutes:
            return f'turn on {self.name} for {self.minutes} minutes'
        return f'turn {self.action} {self.name}'


def words(text: str) -> list[str]:
    """Lower-case words, accents kept, punctuation dropped; "ga-ra" is two words."""
    text = unicodedata.normalize('NFC', text.lower()).replace('-', ' ')
    return re.sub(r'[^\w\s]', ' ', text).split()


def plain(text: str) -> str:
    """Without accents, so "phòng khách" and "phong khach" compare alike."""
    text = ' '.join(words(text)).replace('đ', 'd')
    return ''.join(c for c in unicodedata.normalize('NFD', text) if unicodedata.category(c) != 'Mn')


def has_vietnamese(text: str) -> bool:
    """Letters only Vietnamese uses among the home's languages: an accented Latin letter or đ."""
    return any(c.isalpha() and not c.isascii() and not ('㐀' <= c <= '鿿') for c in text)


def is_chinese(text: str) -> bool:
    return any('㐀' <= c <= '鿿' for c in text)


# ── How long ─────────────────────────────────────────────────────

UNITS = {'một': 1, 'mốt': 1, 'hai': 2, 'ba': 3, 'bốn': 4, 'tư': 4, 'năm': 5, 'lăm': 5, 'sáu': 6, 'bảy': 7,
         'bẩy': 7, 'tám': 8, 'chín': 9}
SAY_UNITS = ['', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín']
# Before the duration, and after it: "trong mười phút", "mười phút rồi tắt", "mười phút sau tắt".
BEFORE_DURATION = {'trong', 'khoảng', 'chừng'}
AFTER_DURATION = {'rồi', 'thì', 'sau', 'đó', 'tắt', 'nữa', 'thôi'}


def _number(ws: list[str], i: int) -> tuple[int | None, int]:
    """A number said from word i ("mười lăm", "hai mươi", "25"), and the index after it."""
    if i < len(ws) and ws[i].isdigit():
        return int(ws[i]), i + 1
    if i < len(ws) and ws[i] == 'mười':
        if i + 1 < len(ws) and ws[i + 1] in UNITS and ws[i + 1] not in ('mốt', 'tư'):
            return 10 + UNITS[ws[i + 1]], i + 2
        return 10, i + 1
    if i < len(ws) and ws[i] in UNITS and ws[i] not in ('mốt', 'lăm'):
        n = UNITS[ws[i]]
        if i + 1 < len(ws) and ws[i + 1] == 'mươi':
            if i + 2 < len(ws) and ws[i + 2] in UNITS:
                return n * 10 + UNITS[ws[i + 2]], i + 3
            return n * 10, i + 2
        return n, i + 1
    return None, i


def take_duration(ws: list[str]) -> tuple[list[str], int | None]:
    """The words without their duration, and the duration in minutes (None if there isn't one)."""
    for start in range(len(ws)):
        if ws[start] == 'nửa' and start + 1 < len(ws) and ws[start + 1] in ('tiếng', 'giờ'):
            minutes, end = 30, start + 2
        else:
            n, end = _number(ws, start)
            if not n or end >= len(ws) or ws[end] not in ('phút', 'tiếng', 'giờ'):
                continue
            minutes = n if ws[end] == 'phút' else n * 60
            end += 1
            if minutes >= 60 and end < len(ws) and ws[end] == 'rưỡi':
                minutes, end = minutes + 30, end + 1
        while start and ws[start - 1] in BEFORE_DURATION:
            start -= 1
        while end < len(ws) and ws[end] in AFTER_DURATION:
            end += 1
        return ws[:start] + ws[end:], minutes
    return ws, None


def say_number(n: int) -> str:
    if n < 10:
        return SAY_UNITS[n]
    if n < 20:
        return 'mười' + ('' if n == 10 else ' lăm' if n == 15 else f' {SAY_UNITS[n - 10]}')
    if n < 100:
        tens, units = divmod(n, 10)
        last = '' if not units else ' mốt' if units == 1 else ' lăm' if units == 5 else f' {SAY_UNITS[units]}'
        return f'{SAY_UNITS[tens]} mươi{last}'
    return str(n)


def say_minutes(minutes: int) -> str:
    """A duration as said in Vietnamese: "mười phút", "nửa tiếng", "một tiếng rưỡi"."""
    if minutes == 30:
        return 'nửa tiếng'
    hours, rest = divmod(minutes, 60)
    if not hours:
        return f'{say_number(minutes)} phút'
    if rest == 30:
        return f'{say_number(hours)} tiếng rưỡi'
    return f'{say_number(hours)} tiếng' + (f' {say_number(rest)} phút' if rest else '')


# ── Names ────────────────────────────────────────────────────────

def _strip(ws: list[str], options: list[tuple[str, ...]]) -> tuple[list[str], bool]:
    for opt in options:
        if tuple(ws[:len(opt)]) == opt:
            return ws[len(opt):], True
    return ws, False


# A Vietnamese syllable's opening consonants, longest first. The rest is its rhyme: "khach" is kh + ach.
INITIALS = ('ngh', 'ng', 'nh', 'ch', 'gh', 'gi', 'kh', 'ph', 'th', 'tr', 'qu',
            'b', 'c', 'd', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'x')


# Opening consonants that sound alike, or are said alike in the South: "pep" for "bếp", "dô" for "vô".
CLOSE_INITIALS = [{'b', 'p'}, {'d', 'gi', 'r', 'v'}, {'s', 'x'}, {'ch', 'tr'}, {'c', 'k', 'q', 'qu'}, {'n', 'l'}, {'g', 'gh'}, {'ng', 'ngh'}]


def _split(word: str) -> tuple[str, str]:
    for i in INITIALS:
        if word.startswith(i) and len(word) > len(i):
            return i, word[len(i):]
    return '', word


def _word(a: str, b: str) -> float:
    """How alike two syllables sound, accents already off, from 0 to 1. Speech recognition gets
    the opening consonant wrong ("cach" for "khach") or the ending ("lan" for "lang"), seldom both."""
    if a == b:
        return 1.0
    (ia, ra), (ib, rb) = _split(a), _split(b)
    if ra == rb:
        return 0.9 if any(ia in g and ib in g for g in CLOSE_INITIALS) else 0.75
    if ia == ib and (ra.startswith(rb) or rb.startswith(ra)) and abs(len(ra) - len(rb)) == 1:
        return 0.7
    return 0.6 * difflib.SequenceMatcher(None, a, b).ratio() ** 2


def _aligned(heard: list[str], name: list[str]) -> float:
    """The words lined up in order, each pair scored, a word more or less costing WORD_GAP; from 0 to 1."""
    n, m = len(heard), len(name)
    best = [[WORD_GAP * (i + j) for j in range(m + 1)] for i in range(n + 1)]
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            best[i][j] = max(best[i - 1][j - 1] + _word(heard[i - 1], name[j - 1]),
                             best[i - 1][j] + WORD_GAP, best[i][j - 1] + WORD_GAP)
    return max(0.0, best[n][m] / max(n, m))


def _sounds_like_den(word: str) -> bool:
    """"đèn", or a word speech recognition writes for it from far away: "nền", "liền"."""
    initial, rhyme = _split(plain(word))
    return rhyme == 'en' or (rhyme == 'ien' and initial in ('d', 'l', 'n'))


def _core(s: str) -> str:
    """The name without a leading "đèn", "cửa" or "cái", which every light or door shares. A first
    word that rhymes with "đèn" counts as it: speech recognition wrote "nền nhà bếp" for "đèn nhà bếp"."""
    first, _, rest = s.partition(' ')
    if rest and (first + ' ' in NAME_PREFIXES or _split(first)[1] == 'en'):
        return rest
    return s


def similarity(heard: str, name: str) -> float:
    """How alike a heard name and a real one are, word by word, from 0 to 1, accents ignored.
    "đèn bếp" is "bếp"; "phòng ngủ" is not "phòng ngủ lớn"."""
    h, n = plain(heard), plain(name)
    if not h or not n:
        return 0.0
    if h == n:
        return 1.0
    # Compared without "đèn": it says nothing about which light, and would make any two lights look alike.
    score = _aligned(_core(h).split(), _core(n).split())
    return score * PREFIX_LEFT_OUT if score == 1.0 else score


def best_name(heard: str, names: list[str], groups: list[list[str]] | None) -> tuple[str | None, float, float]:
    """The closest name, its score, and the score of the closest name of another device.
    groups: the names of each device (its alias and nicknames), so two nicknames of the same
    light don't count as a close call."""
    scored = sorted(((similarity(heard, n), n) for n in names), reverse=True)
    if not scored:
        return None, 0.0, 0.0
    top_score, top = scored[0]
    same = {top}
    for g in groups or []:
        if top in g:
            same.update(g)
    same_plain = {plain(n) for n in same}
    runner = next((sc for sc, n in scored[1:] if n not in same and plain(n) not in same_plain), 0.0)
    return top, top_score, runner


def candidates(names: list[str]) -> list[str]:
    """The names a Vietnamese command can use: every name not written in Chinese characters."""
    return [n for n in names if not is_chinese(n)]


def read_verb(ws: list[str]) -> tuple[str | None, str, list[str]]:
    """'on', 'off', 'unsure' or None; the verb as said; and the words after it."""
    ws, _ = _strip(ws, POLITE)
    if not ws:
        return None, '', ws
    first = ws[0]
    for verbs, action in ((ON_VERBS, 'on'), (OFF_VERBS, 'off')):
        if first in verbs:
            return action, verbs[first], ws[1:]
    if first in NEAR_VERBS:
        verb = NEAR_VERBS[first]
        return ('on' if verb in ON_VERBS else 'off'), verb, ws[1:]
    if first in UNSURE_VERBS:
        return 'unsure', '', ws[1:]
    return None, '', ws


def _tidy_name(ws: list[str]) -> list[str]:
    ws, _ = _strip(ws, AFTER_VERB)
    while ws and ws[-1] in TRAILING:
        ws = ws[:-1]
    return ws


def verb_alone(text: str) -> str | None:
    """'on' or 'off' for "bật" or "tắt" said on its own (with "đi" or "nhé" after it), else None."""
    ws = words(text)
    while ws and ws[-1] in TRAILING:
        ws = ws[:-1]
    action, _, rest = read_verb(ws)
    rest, _ = _strip(rest, AFTER_VERB)
    return action if action in ('on', 'off') and not rest else None


def parse(text: str, names: list[str], scenes: list[str] | None = None,
          groups: list[list[str]] | None = None) -> Command | None:
    """Reads a Vietnamese command against the home's names. None when it isn't one, or is unclear."""
    usable = candidates(names)
    ws, minutes = take_duration(words(text))
    action, verb, rest = read_verb(ws)
    rest = _tidy_name(rest)
    if action in ('on', 'off') and len(rest) == 1 and (plain(rest[0]) == 'cua' or _sounds_like_den(rest[0])):
        # "Bật đèn" with the name lost, often cut off or said too quietly: ask which.
        kind = 'cửa' if plain(rest[0]) == 'cua' else 'đèn'
        return Command('which', kind, 1.0, minutes if action == 'on' else None, verb or ('bật' if action == 'on' else 'tắt'))
    if action and rest:
        name, score, runner = best_name(' '.join(rest), usable, groups)
        if name and score >= MATCH and score - runner >= MARGIN:
            if action == 'unsure':
                return Command('ask', name, round(score, 2))
            if minutes and action == 'off':
                return None   # "off for ten minutes" isn't something HomeHub does: don't guess
            return Command(action, name, round(score, 2), minutes if action == 'on' else None, verb)
        return None
    whole = ' '.join(_tidy_name(ws))
    scene_names = [n for n in (scenes or []) if not is_chinese(n)]
    name, score, runner = best_name(whole, scene_names, None)
    if name and score >= ALONE_MATCH and score - runner >= MARGIN:
        return Command('scene', name, round(score, 2))
    # A device's name alone: its "bật" or "tắt" was lost, often cut off after the wake word.
    devices = [n for n in usable if n not in scene_names]
    name, score, runner = best_name(whole, devices, groups)
    if name and score >= ALONE_MATCH and score - runner >= MARGIN and has_vietnamese(name):
        return Command('ask', name, round(score, 2))
    return None


# The follow-up after "Bật đèn nào?": what the speaker remembers until the answer comes.
WHICH_PREFIX = 'vi-which:'


def which_asked(command: Command) -> str:
    action = 'on' if command.verb in ON_VERBS else 'off'
    return f'{WHICH_PREFIX}{action}:{command.verb}:{command.minutes or 0}:{plain(" ".join(words(command.name or "đèn")))}'


def answer_which(asked: str, text: str, names: list[str], groups: list[list[str]] | None) -> Command | None:
    """The name said after "Bật đèn nào?" ("nhà bếp", "đèn nhà bepping"), as the command first asked for."""
    try:
        action, verb, minutes, kind = asked[len(WHICH_PREFIX):].split(':', 3)
    except ValueError:
        return None
    # The whole command again ("bật đèn nhà bếp"): read as it is.
    again = parse(text, names, [], groups)
    if again is not None and again.action in ('on', 'off'):
        return again
    # The name, perhaps with how long again: "nhà bếp ba mươi phút".
    ws, said_minutes = take_duration(words(text))
    if said_minutes and action == 'on':
        minutes = str(said_minutes)
    _, _, rest = read_verb(ws)
    rest = _tidy_name(rest)
    if not rest:
        return None
    heard = ' '.join(rest)
    if kind and not plain(heard).startswith(kind):
        heard = f'{kind} {heard}'   # "nhà bếp" answering "đèn nào?" is "đèn nhà bếp"
    name, score, runner = best_name(heard, candidates(names), groups)
    if name and score >= MATCH and score - runner >= MARGIN:
        return Command(action, name, round(score, 2), int(minutes) or None, verb)
    return None


def is_vietnamese(text: str, names: list[str], scenes: list[str] | None = None,
                  groups: list[list[str]] | None = None, asked: str | None = None) -> bool:
    """Whether the Vietnamese model's words are a Vietnamese command. Given English or Cantonese,
    it writes Vietnamese-looking nonsense ("QUAN TRỌNG", "TEN ON"), which never starts with a verb
    and a name, so this decides the language as well as the words."""
    if not has_vietnamese(text):
        return False
    if asked and verb_alone(text):
        return True
    ws, _ = take_duration(words(text))
    action, _, rest = read_verb(ws)
    if action in ('on', 'off') and _tidy_name(rest):
        # A Vietnamese verb (each has its accent) and something after it: Vietnamese even when the name
        # isn't known ("đóng ga"), so it's answered in Vietnamese and listed as missed.
        return True
    return parse(text, names, scenes, groups) is not None


# ── Replies ─────────────────────────────────────────────────────

NOT_UNDERSTOOD = 'Xin lỗi, tôi không hiểu.'
NO_HOMEHUB = 'Hiện không kết nối được với HomeHub.'


def reply(command: Command | None, handled: bool, response: str, failed: list[str]) -> str:
    """A short Vietnamese reply from HomeHub's answer. HomeHub's own wording is English."""
    if command is not None and command.action == 'ask':
        return f'Bật hay tắt {command.name}?'
    if command is not None and command.action == 'which':
        return f'{command.verb.capitalize()} {command.name} nào?'
    if command is None or not handled:
        return NOT_UNDERSTOOD
    if "can't pause cameras" in response:
        return 'Vì an toàn, tôi không thể tạm dừng camera như vậy.'
    if 'is protected' in response or 'are protected' in response:
        return f'{command.name} được bảo vệ, tôi không thay đổi.' if not failed else 'Có thiết bị được bảo vệ, tôi không thay đổi.'
    if failed or "couldn't reach" in response:
        return f'Không kết nối được với {command.name}.'
    if response.startswith('Which one'):
        return f'Có nhiều thiết bị cùng tên {command.name}, vui lòng đổi tên.'
    if command.action == 'scene':
        return f'Xong, {command.name}.'
    verb = command.verb or ('bật' if command.action == 'on' else 'tắt')
    if command.action == 'on' and command.minutes:
        return f'Đã {verb} {command.name}, {say_minutes(command.minutes)} nữa sẽ tắt.'
    return f'Đã {verb} {command.name}.'
