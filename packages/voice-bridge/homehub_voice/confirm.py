"""Answers to HomeHub's "Did you mean…?": "Turn on Porch light?" → "yes" / "no".

With Claude chosen in Settings → AI, a command HomeHub's rules don't understand can come back as a
question instead of "Sorry, I didn't understand". The speaker asks it, listens again without the wake
word, and a short yes or no in any language answers it. Nothing is switched until the yes.

Straight after the question, the answer is read loosely ("yes, turn it on", 好呀唔該), since the
speaker only listens for it for a few seconds. Anything else is taken as a new command, and the
question is dropped.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass

from . import cantonese as yue
from . import mandarin as zh
from . import vietnamese as vi
from .sos import YUE_PARTICLES, ZH_PARTICLES

YES, NO = 'yes', 'no'
# Answer.asked after HomeHub asks: 'confirm:<id>'.
PREFIX = 'confirm:'

YUE_YES = {('hai',), ('hou',), ('ngaam',), ('dak',), ('mou', 'co'), ('m', 'goi'), ('hou', 'm', 'goi'), ('hai', 'm', 'goi'),
           ('hai', 'hou'), ('hou', 'hai'), ('ngaam', 'ngaam')}
YUE_NO = {('m', 'hai'), ('m', 'sai'), ('m', 'hou'), ('m', 'jiu'), ('m', 'ngaam'), ('co',), ('ceoi', 'siu'),
          ('m', 'sai', 'm', 'goi'), ('m', 'jiu', 'm', 'goi')}
ZH_YES = {('shi',), ('shi', 'de'), ('hao',), ('hao', 'de'), ('dui',), ('dui', 'de'), ('ke', 'yi'), ('n',), ('xing',), ('mei', 'cuo'),
          ('hao', 'xie', 'xie')}
ZH_NO = {('bu',), ('bu', 'shi'), ('bu', 'yao'), ('bu', 'yong'), ('bie',), ('qu', 'xiao'), ('bu', 'dui'), ('suan',)}
# With accents: đúng (yes, right) and đừng (don't) are both "dung" without them.
VI_YES = {'có', 'vâng', 'dạ', 'ừ', 'ừm', 'đúng', 'đúng rồi', 'phải', 'phải rồi', 'được', 'ok', 'oke', 'có ạ', 'vâng ạ', 'dạ vâng',
          'dạ phải', 'đồng ý', 'được rồi', 'có đi', 'ừ đúng rồi'}
VI_NO = {'không', 'không ạ', 'thôi', 'sai', 'hủy', 'không phải', 'đừng', 'sai rồi', 'thôi khỏi', 'khỏi', 'dạ không', 'không cần'}
# Without accents, when the recogniser dropped them; only the words that stay clear.
VI_PLAIN_YES = {'co', 'vang', 'co a', 'vang a', 'dong y', 'duoc', 'phai', 'phai roi', 'dung roi'}
VI_PLAIN_NO = {'khong', 'khong a', 'thoi', 'khong phai', 'huy'}
EN_YES = re.compile(r"^(?:yes|yeah|yep|yup|ya|sure|ok|okay|please|correct|right|that'?s\s+right|do\s+it|go\s+ahead|yes\s+please)"
                    r"(?:\s+(?:please|thanks?|thank\s+you))?$")
EN_NO = re.compile(r"^(?:no|nope|nah|cancel|don'?t|stop|wrong|never\s*mind|no\s+thanks?|no\s+thank\s+you|not\s+that)$")


def _en(text: str) -> str:
    return re.sub(r'\s+', ' ', re.sub(r"[^a-z' ]+", ' ', text.lower().replace('’', "'"))).strip()


def _words(s: tuple[str, ...], particles: set[str]) -> tuple[str, ...]:
    """Without particles anywhere (好呀，唔該 → 好 唔該), since none of the answers needs one."""
    return tuple(x for x in s if x not in particles)


def kind(text: str, lang: str) -> str | None:
    """YES, NO or None for an answer heard in `lang`. Chinese characters are read as Cantonese or
    Mandarin whichever language was asked, since SenseVoice can label a short 係 either way."""
    if not text or not text.strip(' 。，.,!?！？'):
        return None
    if yue.has_chinese(text):
        if lang == 'zh':
            s = _words(zh.syllables(text), ZH_PARTICLES)
            return YES if s in ZH_YES else NO if s in ZH_NO else None
        s = _words(yue.syllables(text), YUE_PARTICLES)
        if s in YUE_YES:
            return YES
        if s in YUE_NO:
            return NO
        # Mandarin words said to a Cantonese question: 是 / 不是.
        s = _words(zh.syllables(text), ZH_PARTICLES)
        return YES if s in ZH_YES else NO if s in ZH_NO else None
    if vi.has_vietnamese(text) or lang == 'vi':
        words = ' '.join(vi.words(text))
        if words in VI_YES:
            return YES
        if words in VI_NO:
            return NO
        plain = vi.plain(text)
        if plain in VI_PLAIN_YES:
            return YES
        if plain in VI_PLAIN_NO:
            return NO
    plain = _en(text)
    return YES if EN_YES.match(plain) else NO if EN_NO.match(plain) else None


def loose_kind(text: str, lang: str) -> str | None:
    """Straight after the question: a short answer that starts with yes or no ("yes, turn it on",
    "không, cảm ơn", 好呀唔該). A longer sentence is a new command."""
    exact = kind(text, lang)
    if exact or not text:
        return exact
    if yue.has_chinese(text):
        bare = text.strip(' 。，.,!?！？')
        if len(bare) > 6:
            return None
        # 唔 / 不 first: 唔係 and 不是 start with what 係 and 是 would.
        if bare.startswith(('唔', '不', '別', '别')):
            return NO
        return YES if bare.startswith(('係', '系', '好', '啱', '是', '对', '對')) else None
    if vi.has_vietnamese(text) or lang == 'vi':
        ws = vi.words(text)
        if not ws or len(ws) > 4:
            return None
        if ws[0] in ('không', 'đừng', 'thôi') or vi.plain(ws[0]) == 'khong':
            return NO
        return YES if ws[0] in ('có', 'vâng', 'dạ', 'ừ', 'đúng', 'được') else None
    ws = _en(text).split()
    if not ws or len(ws) > 5:
        return None
    if ws[0] in ('no', 'nope', 'nah', "don't", 'dont', 'cancel'):
        return NO
    return YES if ws[0] in ('yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay') else None


# When HomeHub says the question is no longer waiting (over two minutes, or answered on another speaker).
GONE = {
    'yue': '嗰個問題已經過咗時，請再講一次。',
    'zh': '那个问题已经过时了，请再说一次。',
    'vi': 'Câu hỏi đó đã hết hạn, vui lòng nói lại.',
    'en': 'That question has timed out. Please say it again.',
}


@dataclass
class ConfirmResult:
    reply: str
    handled: bool
    lang: str
    homehub_s: float


def run(k: str, confirm_id: str, lang: str, homehub) -> ConfirmResult | None:
    """Sends the answer. HomeHub says what to say, in the question's language. None if HomeHub can't be reached."""
    from .homehub import HomeHubError
    t = time.monotonic()
    try:
        res = homehub.answer_confirm(confirm_id, k)
    except HomeHubError:
        return None
    if res is None:
        return ConfirmResult(GONE.get(lang, GONE['en']), False, lang, time.monotonic() - t)
    said_lang = str(res.get('lang') or lang)
    return ConfirmResult(str(res.get('response') or ''), bool(res.get('handled')), said_lang, time.monotonic() - t)
