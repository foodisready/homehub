"""A call for help, said to a speaker: 救命, 帮我叫人, cứu tôi, help me. And "cancel" after one.

Only a short sentence that is the call for help counts, not one with it in the middle ("the film
where she shouts help me"), so a TV is less likely to set it off. Cantonese and Mandarin are
matched by sound, as SenseVoice writes them in more than one way (救命, 九命).

HomeHub tells the family; the speaker says, in the language it heard, that they've been told and
how to cancel, or who is coming once someone is on it.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass

from . import cantonese as yue
from . import mandarin as zh
from . import vietnamese as vi

RAISE, CANCEL = 'raise', 'cancel'

# ── Cantonese (by sound) ──
YUE_PARTICLES = {'aa', 'a', 'laa', 'la', 'lo', 'wo', 'ge', 'ne', 'o', 'e', 'aak'}
YUE_RAISE = {
    ('gau', 'meng'),                                # 救命
    ('bong', 'ngo', 'giu', 'jan'),                  # 幫我叫人
    ('faai', 'di', 'giu', 'jan'),                   # 快啲叫人
    ('giu', 'jan', 'lai', 'bong', 'sau'),           # 叫人嚟幫手
    ('giu', 'jan', 'lai', 'bong', 'ngo'),           # 叫人嚟幫我
    ('ngo', 'dit', 'can'), ('ngo', 'dit', 'zo'), ('ngo', 'dit', 'dou'),   # 我跌親 / 我跌咗 / 我跌倒
    ('ngo', 'dei', 'can'), ('ngo', 'dik', 'can'),   # 我跌親 as SenseVoice heard it: 我哋親, 我的親
    ('ngo', 'hou', 'm', 'syu', 'fuk'),              # 我好唔舒服
}
YUE_CANCEL = {('ceoi', 'siu'), ('m', 'sai'), ('mou', 'si'), ('ngo', 'mou', 'si'), ('m', 'sai', 'zo')}   # 取消 唔使 冇事 我冇事

# ── Mandarin (by sound) ──
ZH_PARTICLES = {'a', 'ya', 'le', 'la', 'ba', 'ne', 'ma'}
ZH_RAISE = {
    ('jiu', 'ming'), ('jiu', 'jiu', 'wo'),          # 救命 救救我
    ('bang', 'wo', 'jiao', 'ren'), ('kuai', 'jiao', 'ren'),   # 帮我叫人 快叫人
    ('wo', 'shuai', 'dao'), ('wo', 'die', 'dao'),   # 我摔倒(了) 我跌倒(了)
    ('wo', 'hen', 'bu', 'shu', 'fu'),               # 我很不舒服
}
ZH_CANCEL = {('qu', 'xiao'), ('mei', 'shi'), ('wo', 'mei', 'shi'), ('bu', 'yong')}   # 取消 没事 我没事 不用(了)

# ── Vietnamese (without marks) ──
VI_RAISE = {'cuu', 'cuu toi', 'cuu voi', 'cuu toi voi', 'cuu em', 'cuu con', 'giup toi', 'giup toi voi', 'giup voi',
            'goi nguoi giup', 'goi nguoi giup toi', 'toi bi nga', 'toi nga roi', 'toi bi nga roi', 'goi cap cuu'}
VI_CANCEL = {'huy', 'huy bo', 'khong sao', 'toi khong sao', 'khong can', 'khong sao dau'}

# ── English ──
EN_RAISE = re.compile(r"^(?:please\s+)?(?:help(?:\s+me)?(?:\s+help(?:\s+me)?)?|i\s+need\s+help|(?:call|get)\s+(?:for\s+)?help|"
                      r"i(?:'ve|\s+have)\s+fallen|i\s+fell(?:\s+down)?|emergency|sos)(?:\s+please)?$")
EN_CANCEL = re.compile(r"^(?:cancel(?:\s+(?:that|it|help))?|i'?m\s+(?:ok|okay|fine|alright|all\s+right)|i\s+am\s+(?:ok|okay|fine)|"
                       r"never\s*mind|false\s+alarm|no\s+need)$")


def _bare(s: tuple[str, ...], particles: set[str]) -> tuple[str, ...]:
    """Without particles at either end (救命呀 → 救命), and a phrase said twice once (救命救命)."""
    while s and s[-1] in particles:
        s = s[:-1]
    while s and s[0] in particles:
        s = s[1:]
    half = len(s) // 2
    if s and len(s) % 2 == 0 and s[:half] == s[half:]:
        s = s[:half]
    return s


def kind(text: str, lang: str) -> str | None:
    """RAISE, CANCEL or None, for a sentence heard in `lang` ('yue', 'zh', 'vi', 'en')."""
    if not text or not text.strip(' 。，.,!?！？'):
        return None
    if lang == 'yue':
        if not yue.has_chinese(text):
            return None
        s = _bare(yue.syllables(text), YUE_PARTICLES)
        return RAISE if s in YUE_RAISE else CANCEL if s in YUE_CANCEL else None
    if lang == 'zh':
        if not yue.has_chinese(text):
            return None
        s = _bare(zh.syllables(text), ZH_PARTICLES)
        return RAISE if s in ZH_RAISE else CANCEL if s in ZH_CANCEL else None
    if lang == 'vi':
        ws = vi.plain(' '.join(vi.words(text))).split()
        if ws and len(ws) % 2 == 0 and ws[:len(ws) // 2] == ws[len(ws) // 2:]:
            ws = ws[:len(ws) // 2]   # "cứu với cứu với"
        # The Vietnamese model often adds a word at either end ("cứu tội với nhau"), so a phrase of
        # two words or more still counts with one more around it.
        tries = [ws] + ([ws[1:], ws[:-1]] if len(ws) >= 3 else [])
        for t in tries:
            w = ' '.join(t)
            if w in VI_RAISE and (t is ws or len(t) >= 2):
                return RAISE
            if w in VI_CANCEL and (t is ws or len(t) >= 2):
                return CANCEL
        return None
    plain = re.sub(r"[^a-z' ]+", ' ', text.lower().replace('’', "'"))
    plain = re.sub(r'\s+', ' ', plain).strip()
    return RAISE if EN_RAISE.match(plain) else CANCEL if EN_CANCEL.match(plain) else None


def chinese_kind(text: str, langs: tuple[str, ...]) -> tuple[str, str] | None:
    """(kind, lang) for Cantonese or Mandarin, trying the languages that are on, in order."""
    for lang in langs:
        k = kind(text, lang)
        if k:
            return k, lang
    return None


REPLIES = {
    'yue': {
        'raised': '我已經話咗俾屋企人知。冇事嘅話，講「取消」。',
        'nobody': '我搵唔到人通知，請打電話求助。',
        'already': '屋企人已經知道，正在搵人嚟幫你。',
        'on_it': '{by}已經知道，就嚟幫你。',
        'cancelled': '好，已經取消，我話返俾屋企人知你冇事。',
        'no_homehub': 'HomeHub冇回應，請打電話求助。',
    },
    'zh': {
        'raised': '我已经通知家人了。没事的话，说“取消”。',
        'nobody': '我找不到人通知，请打电话求助。',
        'already': '家人已经知道了，正在找人来帮你。',
        'on_it': '{by}已经知道了，马上来帮你。',
        'cancelled': '好的，已经取消，我会告诉家人你没事。',
        'no_homehub': 'HomeHub没有回应，请打电话求助。',
    },
    'vi': {
        'raised': 'Tôi đã báo cho gia đình rồi. Nếu không sao, hãy nói “tôi không sao”.',
        'nobody': 'Tôi không báo được cho ai. Hãy gọi điện nhờ giúp đỡ.',
        'already': 'Gia đình đã biết rồi, đang tìm người đến giúp.',
        'on_it': '{by} đã biết rồi, đang đến giúp.',
        'cancelled': 'Được rồi, đã hủy. Tôi sẽ báo cho gia đình là bạn không sao.',
        'no_homehub': 'HomeHub không trả lời. Hãy gọi điện nhờ giúp đỡ.',
    },
    'en': {
        'raised': "I've told the family. If you're OK, say cancel.",
        'nobody': "I couldn't reach anyone. Please phone for help.",
        'already': 'The family knows, and someone is coming.',
        'on_it': '{by} knows, and help is on the way.',
        'cancelled': "OK, cancelled. I'll tell the family you're OK.",
        'no_homehub': "HomeHub isn't answering. Please phone for help.",
    },
}

# Answer.asked after a call for help: the speaker listens again, with no wake word, for "cancel".
ASKED = 'sos'


@dataclass
class SosResult:
    reply: str
    handled: bool
    # Listen again for "cancel", with no wake word.
    listen: bool
    homehub_s: float


def reply_for(state: str, lang: str, res: dict) -> str:
    words = REPLIES.get(lang, REPLIES['en'])
    if state == 'raised':
        return words['raised'] if res.get('reach', 1) else words['nobody']
    if state == 'already':
        return words['on_it'].format(by=res['ackedBy']) if res.get('ackedBy') else words['already']
    return words['cancelled']


def run(k: str, heard: str, lang: str, homehub, where: str) -> SosResult | None:
    """Tells HomeHub. None for a "cancel" with no call for help to cancel: it was meant for something else."""
    from .homehub import HomeHubError
    t = time.monotonic()
    try:
        res = homehub.sos(k, where, lang, heard)
    except HomeHubError:
        if k == CANCEL:
            return None
        # Said whatever the speaker's filters think: someone may need to hear it.
        return SosResult(REPLIES.get(lang, REPLIES['en'])['no_homehub'], True, False, time.monotonic() - t)
    state = str(res.get('state') or '')
    if state == 'nothing':
        return None
    return SosResult(reply_for(state, lang, res), True, state == 'raised', time.monotonic() - t)
