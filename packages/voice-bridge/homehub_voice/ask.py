"""Answers to a reminder that asks back: "食藥喇。食咗藥未呀？" → 食咗 / 未, and to a daily
check-in that asks at home before telling the family: "亞娘，你冇事吖嘛？" → 冇事 / 唔舒服.

HomeHub lists the questions waiting for an answer (`asking` in its config, each with its `kind`).
While one is, a short yes or no in any language answers it: straight after the question, on
speakers that listen without the wake word then, or later with the wake word. Like a call for
help, only a short sentence that is the answer counts.

A check-in's yes is "I'm OK" and its no is "I'm not OK". 冇 is "no" to a reminder (冇食) but
冇事 is "I'm fine", so each kind has its own words.
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

REMINDER, CHECKIN = 'reminder', 'checkin'

# "Are you OK?" — "I'm fine" / "I'm not well". A call for help (救命, help) is the SOS's, heard first.
CHECKIN_YUE_YES = {('mou', 'si'), ('ngo', 'mou', 'si'), ('mou', 'si', 'mou', 'si'), ('hou',), ('hou', 'hou'), ('ngo', 'hou', 'hou'),
                   ('gei', 'hou'), ('ngo', 'gei', 'hou'), ('mou', 'man', 'tai'), ('hai',), ('dak',), ('ou', 'kei'), ('mou', 'si', 'ou', 'kei'),
                   ('hei', 'zo', 'san'), ('ngo', 'hei', 'zo', 'san'), ('hou', 'ou', 'kei')}
CHECKIN_YUE_NO = {('m', 'syu', 'fuk'), ('ngo', 'm', 'syu', 'fuk'), ('jau', 'si'), ('ngo', 'jau', 'si'), ('m', 'hou'), ('m', 'dak'),
                  ('hou', 'm', 'syu', 'fuk'), ('ngo', 'hou', 'm', 'syu', 'fuk'), ('m', 'hai', 'gei', 'hou')}
CHECKIN_ZH_YES = {('mei', 'shi'), ('wo', 'mei', 'shi'), ('hao',), ('hen', 'hao'), ('wo', 'hen', 'hao'), ('ting', 'hao'), ('wo', 'ting', 'hao'),
                  ('mei', 'wen', 'ti'), ('shi',), ('dui',), ('hai', 'hao'), ('wo', 'hai', 'hao'), ('qi', 'chuang', 'le'), ('wo', 'qi', 'chuang', 'le')}
CHECKIN_ZH_NO = {('bu', 'shu', 'fu'), ('wo', 'bu', 'shu', 'fu'), ('you', 'shi'), ('wo', 'you', 'shi'), ('bu', 'hao'), ('bu', 'tai', 'hao'),
                 ('hen', 'bu', 'shu', 'fu')}
CHECKIN_VI_YES = {'khong sao', 'toi khong sao', 'khong sao dau', 'khoe', 'toi khoe', 'khoe lam', 'on', 'toi on', 'van on', 'vang', 'da',
                  'co', 'binh thuong', 'toi binh thuong', 'van khoe', 'toi van khoe', 'toi day', 'ok', 'toi ok'}
CHECKIN_VI_NO = {'khong khoe', 'toi khong khoe', 'met', 'toi met', 'met lam', 'khong on', 'toi khong on', 'toi bi om', 'bi om', 'om'}
CHECKIN_EN_YES = re.compile(r"^(?:yes|yeah|yep|ok|okay|fine|good|sure|all\s+good|i'?m\s+(?:ok|okay|fine|good|alright|all\s+right|here|up)|"
                            r"i\s+am\s+(?:ok|okay|fine|good|alright|all\s+right|here|up)|yes\s+i'?m\s+(?:ok|okay|fine))"
                            r"(?:\s+thanks?|\s+thank\s+you)?$")
CHECKIN_EN_NO = re.compile(r"^(?:no|i'?m\s+not\s+(?:ok|okay|fine|good|well|alright)|not\s+(?:ok|okay|good|well|really)|"
                           r"i\s+don'?t\s+feel\s+(?:well|good)|i\s+feel\s+(?:sick|bad|unwell)|i'?m\s+(?:sick|unwell|hurt))$")


def kind(text: str, lang: str, what: str = REMINDER) -> str | None:
    """YES, NO or None for an answer heard in `lang`, to a reminder's question or a check-in's."""
    if not text or not text.strip(' 。，.,!?！？'):
        return None
    if what == CHECKIN:
        return _checkin_kind(text, lang)
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


def _checkin_kind(text: str, lang: str) -> str | None:
    if lang in ('yue', 'zh'):
        if not yue.has_chinese(text):
            return None
        if lang == 'yue':
            s = _bare(yue.syllables(text), YUE_PARTICLES | {'gaa', 'ze', 'zek'})
            return YES if s in CHECKIN_YUE_YES else NO if s in CHECKIN_YUE_NO else None
        s = _bare(zh.syllables(text), ZH_PARTICLES)
        return YES if s in CHECKIN_ZH_YES else NO if s in CHECKIN_ZH_NO else None
    if lang == 'vi':
        words = vi.plain(' '.join(vi.words(text)))
        for tail in (' a', ' nhe', ' nha', ' ma', ' roi'):
            if words.endswith(tail) and words[:-len(tail)] in CHECKIN_VI_YES | CHECKIN_VI_NO:
                words = words[:-len(tail)]
        return YES if words in CHECKIN_VI_YES else NO if words in CHECKIN_VI_NO else None
    plain = re.sub(r'\s+', ' ', re.sub(r"[^a-z' ]+", ' ', text.lower().replace('’', "'"))).strip()
    return NO if CHECKIN_EN_NO.match(plain) else YES if CHECKIN_EN_YES.match(plain) else None


def _checkin_loose(text: str, lang: str) -> str | None:
    """Straight after "are you OK?": the 冇事 / không sao / "OK" that says fine usually survives a
    mishearing, as does the 唔舒服 / mệt / "not" that says otherwise. The no is looked for first:
    "not OK" has an OK in it."""
    if lang in ('yue', 'zh'):
        t = text.strip(' 。，.,!?！？')
        if not yue.has_chinese(t) or len(t) > 8:
            return None
        if any(w in t for w in ('唔舒服', '不舒服', '有事', '唔好', '不好', '唔得')):
            return NO
        return YES if any(w in t for w in ('冇事', '没事', '無事', '好好', '幾好', '很好', '冇問題', '没问题')) else None
    if lang == 'vi':
        ws = vi.plain(' '.join(vi.words(text)))
        if len(ws.split()) > 5:
            return None
        if any(w in ws for w in ('khong khoe', 'met', 'om', 'khong on')):
            return NO
        return YES if any(w in ws for w in ('khong sao', 'khoe', 'on', 'binh thuong')) else None
    ws = re.sub(r"[^a-z' ]+", ' ', text.lower().replace('’', "'")).split()
    if len(ws) > 6:
        return None
    if {'not', 'sick', 'unwell', 'hurt', "don't"} & set(ws):
        return NO
    return YES if {'ok', 'okay', 'fine', 'good', 'alright', 'yes', 'yeah'} & set(ws) else None


def loose_kind(text: str, lang: str, what: str = REMINDER) -> str | None:
    """Straight after the speaker asked, a looser reading: one-word answers are often misheard
    (食咗 as 你咗啦, 已經食咗 as 已经热咗), but the 咗 / rồi / "took" that says it's done usually
    survives, as does the 未 / chưa / "not" that says it isn't."""
    exact = kind(text, lang, what)
    if exact or not text:
        return exact
    if what == CHECKIN:
        return _checkin_loose(text, lang)
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
CHECKIN_REPLIES = {
    'yue': {YES: '好，多謝你。', NO: '我而家通知屋企人。'},
    'zh': {YES: '好的，谢谢你。', NO: '我现在通知家人。'},
    'vi': {YES: 'Được rồi, cảm ơn.', NO: 'Tôi báo cho gia đình ngay bây giờ.'},
    'en': {YES: 'Good, thank you.', NO: "I'm telling the family now."},
}


@dataclass
class AskResult:
    reply: str
    homehub_s: float


def waiting(homehub, asked: str | None, what: str = REMINDER) -> list[tuple[int, str]]:
    """(id, language) of the questions of this kind an answer now would answer."""
    out: list[tuple[int, str]] = []
    for a in getattr(homehub, 'asking', None) or []:
        if (isinstance(a, dict) and isinstance(a.get('id'), int) and (a.get('kind') or REMINDER) == what
                and a['id'] not in [i for i, _ in out]):
            out.append((a['id'], str(a.get('lang') or '')))
    return out


def kinds_waiting(homehub) -> list[str]:
    """The kinds of question waiting, a check-in's first: "好" to both is the check-in's answer."""
    have = {(a.get('kind') or REMINDER) for a in getattr(homehub, 'asking', None) or [] if isinstance(a, dict)}
    return [w for w in (CHECKIN, REMINDER) if w in have]


def any_kind(text: str, lang: str, homehub) -> str | None:
    """YES or NO if this answers any question waiting."""
    return next((k for w in kinds_waiting(homehub) if (k := kind(text, lang, w))), None)


def run(k: str, lang: str, homehub, open_asks: list[tuple[int, str]], what: str = REMINDER) -> AskResult | None:
    """Gives the answer to the question waiting in this language (or the first). None if HomeHub says none is."""
    from .homehub import HomeHubError
    pick = next((i for i, l in open_asks if l in ('', lang)), open_asks[0][0])
    t = time.monotonic()
    try:
        if not (homehub.answer_ask(pick, k, what) if what != REMINDER else homehub.answer_ask(pick, k)):
            return None
    except HomeHubError:
        return None
    replies = CHECKIN_REPLIES if what == CHECKIN else REPLIES
    return AskResult(replies.get(lang, replies['en'])[k], time.monotonic() - t)
