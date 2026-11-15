"""Answers to a reminder that asks back: "食藥喇。食咗藥未呀？" → 食咗 / 未.

HomeHub lists the questions waiting for an answer (`asking` in its config). While one is, a short
yes or no in any language answers it: straight after the reminder, on speakers that listen without
the wake word then, or later with the wake word. Like a call for help, only a short sentence that
is the answer counts.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass

from . import cantonese as yue
from . import mandarin as zh
from . import vietnamese as vi
from .sos import YUE_PARTICLES, ZH_PARTICLES, _bare

YES, NO = 'yes', 'no'
# Answer.asked straight after a reminder that asks: 'ask:<id>'.
PREFIX = 'ask:'

YUE_YES = {('sik', 'zo'), ('ji', 'ging', 'sik', 'zo'), ('sik', 'zo', 'joek'), ('sik', 'gwo'), ('jam', 'zo'), ('zou', 'zo'),
           ('gaau', 'dim'), ('jau',), ('hai',), ('hou',), ('ngo', 'sik', 'zo'), ('sik', 'zo', 'laa')}
YUE_NO = {('mei',), ('mei', 'sik'), ('zung', 'mei'), ('zung', 'mei', 'sik'), ('mei', 'zou'), ('mou',), ('m', 'gei', 'dak', 'zo'), ('mei', 'jam')}
ZH_YES = {('chi', 'le'), ('chi', 'guo', 'le'), ('yi', 'jing', 'chi', 'le'), ('chi', 'le', 'yao'), ('zuo', 'le'), ('shi',), ('hao',), ('dui',), ('chi', 'guo')}
ZH_NO = {('mei', 'you'), ('hai', 'mei'), ('mei', 'chi'), ('hai', 'mei', 'you'), ('hai', 'mei', 'chi'), ('mei',), ('wang', 'le')}
VI_YES = {'roi', 'uong roi', 'co', 'vang', 'da', 'da roi', 'u', 'xong roi', 'lam roi', 'uong thuoc roi', 'co roi', 'toi uong roi', 'vang roi'}
VI_NO = {'chua', 'chua uong', 'khong', 'chua a', 'da chua', 'chua lam', 'toi chua uong', 'quen roi'}
EN_YES = re.compile(r"^(?:yes|yeah|yep|yup|sure|done|already|taken|i\s+have|i\s+did|i\s+took\s+(?:it|them)|i'?ve\s+(?:taken|done)\s+(?:it|them)|"
                    r"yes\s+i\s+(?:have|did))(?:\s+thanks?|\s+thank\s+you)?$")
EN_NO = re.compile(r"^(?:no|nope|not\s+yet|no\s+not\s+yet|i\s+haven'?t|i\s+forgot|later|no\s+i\s+haven'?t)$")


def kind(text: str, lang: str) -> str | None:
    """YES, NO or None for an answer heard in `lang`."""
    if not text or not text.strip(' 。，.,!?！？'):
        return None
    if lang in ('yue', 'zh'):
        if not yue.has_chinese(text):
            return None
        if lang == 'yue':
            s = _bare(yue.syllables(text), YUE_PARTICLES)
            return YES if s in YUE_YES else NO if s in YUE_NO else None
        # 了 stays: 吃了 is the answer, not 吃.
        s = _bare(zh.syllables(text), ZH_PARTICLES - {'le'})
        return YES if s in ZH_YES else NO if s in ZH_NO else None
    if lang == 'vi':
        words = vi.plain(' '.join(vi.words(text)))
        return YES if words in VI_YES else NO if words in VI_NO else None
    plain = re.sub(r'\s+', ' ', re.sub(r"[^a-z' ]+", ' ', text.lower().replace('’', "'"))).strip()
    return YES if EN_YES.match(plain) else NO if EN_NO.match(plain) else None


def loose_kind(text: str, lang: str) -> str | None:
    """Straight after the speaker asked, a looser reading: one-word answers are often misheard
    (食咗 as 你咗啦, 已經食咗 as 已经热咗), but the 咗 / rồi / "took" that says it's done usually
    survives, as does the 未 / chưa / "not" that says it isn't."""
    exact = kind(text, lang)
    if exact or not text:
        return exact
    if lang in ('yue', 'zh'):
        if not yue.has_chinese(text) or len(text.strip(' 。，.,!?！？')) > 6:
            return None
        s = yue.syllables(text) if lang == 'yue' else zh.syllables(text)
        no = {'mei', 'mou', 'm'} if lang == 'yue' else {'mei', 'hai', 'bu'}
        yes = {'zo'} if lang == 'yue' else {'le', 'guo'}
        if any(x in no for x in s):
            return NO
        return YES if any(x in yes for x in s) else None
    if lang == 'vi':
        ws = vi.plain(' '.join(vi.words(text))).split()
        if len(ws) > 4:
            return None
        return NO if 'chua' in ws else YES if 'roi' in ws else None
    ws = re.sub(r"[^a-z' ]+", ' ', text.lower().replace('’', "'")).split()
    if len(ws) > 5:
        return None
    if {'not', 'no', "haven't", 'nope'} & set(ws):
        return NO
    return YES if {'yes', 'yeah', 'took', 'taken', 'did'} & set(ws) else None


REPLIES = {
    'yue': {YES: '好，記低咗。', NO: '好，我十分鐘之後再問你。'},
    'zh': {YES: '好的，记下了。', NO: '好的，我十分钟后再问你。'},
    'vi': {YES: 'Được rồi, tôi ghi lại rồi.', NO: 'Được rồi, mười phút nữa tôi hỏi lại.'},
    'en': {YES: 'OK, noted.', NO: "OK, I'll ask again in 10 minutes."},
}


@dataclass
class AskResult:
    reply: str
    homehub_s: float


def waiting(homehub, asked: str | None) -> list[tuple[int, str]]:
    """(id, language) of the questions an answer now would answer: the one just asked first."""
    out: list[tuple[int, str]] = []
    if asked and asked.startswith(PREFIX):
        try:
            out.append((int(asked[len(PREFIX):]), ''))
        except ValueError:
            pass
    for a in getattr(homehub, 'asking', None) or []:
        if isinstance(a, dict) and isinstance(a.get('id'), int) and a['id'] not in [i for i, _ in out]:
            out.append((a['id'], str(a.get('lang') or '')))
    return out


def run(k: str, lang: str, homehub, open_asks: list[tuple[int, str]]) -> AskResult | None:
    """Gives the answer to the question waiting in this language (or the first). None if HomeHub says none is."""
    from .homehub import HomeHubError
    pick = next((i for i, l in open_asks if l in ('', lang)), open_asks[0][0])
    t = time.monotonic()
    try:
        if not homehub.answer_ask(pick, k):
            return None
    except HomeHubError:
        return None
    return AskResult(REPLIES.get(lang, REPLIES['en'])[k], time.monotonic() - t)
