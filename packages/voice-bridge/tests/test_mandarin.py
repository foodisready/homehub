"""Mandarin commands: read by sound, passed to HomeHub, answered in Mandarin.

The home's Chinese nicknames are shared with Cantonese: 廚房燈 is "chu fang deng"
in Mandarin and "cyu fong dang" in Cantonese. No speech models are needed."""
from __future__ import annotations

import unittest

from homehub_voice import config as cfg
from homehub_voice import mandarin as zh
from homehub_voice import questions
from homehub_voice.homehub import CommandResult
from homehub_voice.pipeline import answer, wake_language

NAMES = ['Kitchen lights', '廚房燈', '客廳燈', '書房燈', '走廊燈', '卓希房燈', '卓軒房邊燈', '亞娘床頭燈', '車房門', '晚安']
SCENES = ['晚安']


def read(text):
    c = zh.parse(text, NAMES, SCENES)
    return (c.action, c.name, c.minutes) if c else None


class ReadingTest(unittest.TestCase):
    def test_verb_first(self):
        self.assertEqual(read('打开厨房灯'), ('on', '廚房燈', None))
        self.assertEqual(read('开客厅灯。'), ('on', '客廳燈', None))
        self.assertEqual(read('关掉书房灯'), ('off', '書房燈', None))
        self.assertEqual(read('关闭走廊灯'), ('off', '走廊燈', None))
        self.assertEqual(read('关客厅灯吧'), ('off', '客廳燈', None))
        self.assertEqual(read('請幫我打開廚房燈'), ('on', '廚房燈', None), 'traditional characters too')
        self.assertEqual(read('帮我开一下客厅灯'), ('on', '客廳燈', None))
        self.assertEqual(read('麻烦你关掉走廊灯'), ('off', '走廊燈', None))

    def test_verb_last(self):
        self.assertEqual(read('把客厅灯打开'), ('on', '客廳燈', None))
        self.assertEqual(read('把书房灯关掉吧'), ('off', '書房燈', None))
        self.assertEqual(read('把厨房灯关了'), ('off', '廚房燈', None))
        self.assertEqual(read('客厅灯关一下'), ('off', '客廳燈', None))
        self.assertEqual(read('请把走廊灯打开一下'), ('on', '走廊燈', None))

    def test_by_sound(self):
        # Another character with the same sound, and a southern "z" for "zh".
        self.assertEqual(read('打开出房灯'), ('on', '廚房燈', None))
        self.assertEqual(read('关掉做希房灯'), ('off', '卓希房燈', None))
        self.assertEqual(read('关掉亚娘床头灯'), ('off', '亞娘床頭燈', None))
        self.assertEqual(read('打开卓轩房边灯'), ('on', '卓軒房邊燈', None))

    def test_for_a_while(self):
        self.assertEqual(read('打开书房灯十分钟'), ('on', '書房燈', 10))
        self.assertEqual(read('开书房灯半小时'), ('on', '書房燈', 30))
        self.assertEqual(read('打开客厅灯一个小时'), ('on', '客廳燈', 60))
        self.assertEqual(read('打开客厅灯一个半小时'), ('on', '客廳燈', 90))
        self.assertEqual(read('打开书房灯，十分钟后关掉'), ('on', '書房燈', 10))
        self.assertIsNone(read('关掉书房灯十分钟'), "off for a while isn't something HomeHub does")

    def test_scene_and_name_alone(self):
        self.assertEqual(read('晚安'), ('scene', '晚安', None))
        self.assertEqual(read('厨房灯'), ('ask', '廚房燈', None))

    def test_not_a_command(self):
        for text in ('今天吃什么', '打开', '把它打开', '', 'turn on'):
            with self.subTest(text=text):
                self.assertIsNone(read(text))

    def test_verb_alone(self):
        self.assertEqual(zh.verb_alone('开'), 'on')
        self.assertEqual(zh.verb_alone('打开吧'), 'on')
        self.assertEqual(zh.verb_alone('关了'), 'off')
        self.assertEqual(zh.verb_alone('关掉'), 'off')
        self.assertIsNone(zh.verb_alone('开厨房灯'))

    def test_syllables(self):
        self.assertEqual(zh.syllables('把客厅灯打开'), ('ba', 'ke', 'ting', 'deng', 'da', 'kai'))
        self.assertEqual(zh.syllables('廚房燈'), zh.syllables('厨房灯'))
        self.assertEqual(zh.syllables('A燈'), ('a', 'deng'))


class ReplyTest(unittest.TestCase):
    def test_replies_are_simplified(self):
        on = zh.Command('on', '廚房燈', 1.0)
        self.assertEqual(zh.reply(on, True, 'Turned on 廚房燈.', []), '已打开厨房灯。')
        self.assertEqual(zh.reply(zh.Command('off', '客廳燈', 1.0), True, '', []), '已关掉客厅灯。')
        self.assertEqual(zh.reply(zh.Command('on', '書房燈', 1.0, 90), True, '', []), '已打开书房灯，一个半小时后关掉。')
        self.assertEqual(zh.reply(zh.Command('ask', '廚房燈', 1.0), False, '', []), '你要打开还是关掉厨房灯？')
        self.assertEqual(zh.reply(zh.Command('scene', '晚安', 1.0), True, '', []), '好的，晚安。')
        self.assertEqual(zh.reply(None, False, '', []), zh.NOT_UNDERSTOOD)
        self.assertEqual(zh.reply(on, True, "I couldn't reach 廚房燈.", ['廚房燈']), '连不上厨房灯。')
        self.assertEqual(zh.reply(zh.Command('off', '車房門', 1.0), True, '車房門 is protected.', []), '车房门受保护，我不会动它。')

    def test_numbers_and_minutes(self):
        self.assertEqual([zh.number(n) for n in (0, 2, 12, 20, 45, 105, 110, -3)],
                         ['零', '二', '十二', '二十', '四十五', '一百零五', '一百一十', '零下三'])
        self.assertEqual([zh.say_minutes(m) for m in (10, 30, 60, 90, 120, 75)],
                         ['十分钟', '半小时', '一个小时', '一个半小时', '两个小时', '一个小时十五分钟'])


class QuestionTest(unittest.TestCase):
    def test_kinds(self):
        self.assertEqual(questions.zh_kind('现在几点了？'), 'time')
        self.assertEqual(questions.zh_kind('今天几号？'), 'date')
        self.assertEqual(questions.zh_kind('今天星期几'), 'date')
        self.assertEqual(questions.zh_kind('今天天气怎么样'), 'today')
        self.assertEqual(questions.zh_kind('明天天气怎么样'), 'tomorrow')
        self.assertEqual(questions.zh_kind('明天会下雨吗'), 'rain-tomorrow')
        self.assertIsNone(questions.zh_kind('打开厨房灯'))
        self.assertIsNone(questions.zh_kind('what time is it'))

    def test_replies(self):
        self.assertEqual(questions.zh_reply('time', {'hour': 15, 'minute': 10}), '现在是下午三点十分。')
        self.assertEqual(questions.zh_reply('time', {'hour': 14, 'minute': 0}), '现在是下午两点整。')
        self.assertEqual(questions.zh_reply('time', {'hour': 9, 'minute': 5}), '现在是早上九点零五分。')
        self.assertEqual(questions.zh_reply('date', {'month': 11, 'day': 14, 'weekday': 6}), '今天是十一月十四号，星期六。')
        today = {'now': {'temperature': 18, 'code': 3}, 'today': {'high': 21, 'low': 12, 'rain': 40, 'code': 61},
                 'tomorrow': {'high': 19, 'low': 10, 'rain': 70, 'code': 63}}
        self.assertEqual(questions.zh_reply('today', today), '现在十八度，多云。今天最高二十一度，最低十二度。下雨概率百分之四十。')
        self.assertEqual(questions.zh_reply('rain-tomorrow', today), '会，明天很可能下雨，概率百分之七十。')
        self.assertEqual(questions.zh_reply('today', {'error': True, 'code': 'NOT_LOCATED'}), 'HomeHub还不知道你家在哪里，请在设置里选择位置。')


class Ears:
    """SenseVoice with Mandarin on, and Cantonese too if `chinese` says: `quick` from the first pass,
    `again[lang]` when set to that language."""
    def __init__(self, lang, quick, again=None, chinese=('zh',)):
        self.lang, self.quick, self.again, self.chinese = lang, quick, again or {}, chinese
        self.passes: list[str] = []

    def hear(self, audio):
        return self.lang, self.quick

    def transcribe(self, audio, lang=None):
        lang = lang or self.chinese[0]
        self.passes.append(lang)
        return self.again.get(lang, self.quick)


class Listener:
    def transcribe(self, audio, names):
        return ''


class HomeHub:
    names = NAMES
    scenes = SCENES

    def __init__(self, info=None):
        self.sent: list[str] = []
        self.info = info

    def command(self, text, retry=False):
        self.sent.append(text)
        if text.startswith(('turn ', 'run ')):
            return CommandResult(True, 'Done.')
        if self.info is not None:
            return CommandResult(True, '', info=self.info)
        return CommandResult(False, "Sorry, I didn't understand that.")


class PipelineTest(unittest.TestCase):
    def test_mandarin_alone(self):
        h, ears = HomeHub(), Ears('zh', '打开厨房灯。')
        a = answer(b'x', True, Listener(), h, ears)
        self.assertEqual(h.sent, ['turn on 廚房燈'])
        self.assertEqual((a.reply, a.lang, a.handled, a.passes), ('已打开厨房灯。', 'zh', True, 1))

    def test_mandarin_alone_heard_again_set_to_mandarin(self):
        h, ears = HomeHub(), Ears('zh', '打开出。', {'zh': '打开厨房灯。'})
        a = answer(b'x', True, Listener(), h, ears)
        self.assertEqual(h.sent, ['turn on 廚房燈'])
        self.assertEqual((ears.passes, a.lang, a.passes), (['zh'], 'zh', 2))

    def test_a_miss_is_listed_in_its_words(self):
        h = HomeHub()
        a = answer(b'x', True, Listener(), h, Ears('zh', '今天吃什么？'))
        self.assertEqual(h.sent, ['今天吃什么'])
        self.assertEqual((a.reply, a.lang, a.handled), (zh.NOT_UNDERSTOOD, 'zh', False))

    def test_a_question_asked_in_mandarin(self):
        h = HomeHub(info={'hour': 15, 'minute': 10})
        a = answer(b'x', True, Listener(), h, Ears('zh', '现在几点？'))
        self.assertEqual(h.sent, ['what time is it'])
        self.assertEqual((a.reply, a.lang), ('现在是下午三点十分。', 'zh'))

    def test_answering_on_or_off(self):
        h = HomeHub()
        first = answer(b'x', True, Listener(), h, Ears('zh', '厨房灯。'))
        self.assertEqual((first.reply, first.asked), ('你要打开还是关掉厨房灯？', '廚房燈'))
        a = answer(b'x', True, Listener(), h, Ears('zh', '开。'), asked='廚房燈', prefer='zh')
        self.assertEqual(h.sent[-1], 'turn on 廚房燈')
        self.assertEqual(a.lang, 'zh')

    # ── Cantonese and Mandarin both on ──

    def test_both_on_a_clear_mandarin_command_is_mandarin(self):
        h, ears = HomeHub(), Ears('zh', '把客厅灯打开', chinese=('yue', 'zh'))
        a = answer(b'x', True, Listener(), h, ears)
        self.assertEqual(h.sent, ['turn on 客廳燈'])
        self.assertEqual(a.lang, 'zh')

    def test_both_on_cantonese_labelled_mandarin_is_cantonese(self):
        # SenseVoice often labels a short Cantonese command 'zh'.
        h, ears = HomeHub(), Ears('zh', '熄客廳燈。', chinese=('yue', 'zh'))
        a = answer(b'x', True, Listener(), h, ears)
        self.assertEqual(h.sent, ['turn off 客廳燈'])
        self.assertEqual((a.lang, a.reply), ('yue', '熄咗客廳燈。'))

    def test_both_on_said_alike_in_both_the_label_decides(self):
        # 打开 is said in Cantonese too: 打开厨房灯 reads as well in both.
        h = HomeHub()
        a = answer(b'x', True, Listener(), h, Ears('zh', '打开厨房灯。', chinese=('yue', 'zh')))
        self.assertEqual((h.sent, a.lang, a.label), (['turn on 廚房燈'], 'zh', 'zh'))
        a = answer(b'x', True, Listener(), h, Ears('yue', '打开厨房灯。', chinese=('yue', 'zh')))
        self.assertEqual((a.lang, a.label), ('yue', 'yue'))

    def test_both_on_unsure_reads_the_labelled_language_first_then_the_other(self):
        for label, first in (('zh', 'zh'), ('yue', 'yue')):
            with self.subTest(label=label):
                h = HomeHub()
                ears = Ears(label, '把客厅。', {'yue': '把客厅。', 'zh': '把客厅灯关掉吧。'}, chinese=('yue', 'zh'))
                a = answer(b'x', True, Listener(), h, ears)
                self.assertEqual(h.sent, ['turn off 客廳燈'], 'and a miss in the first language is never listed')
                self.assertEqual(a.lang, 'zh')
                self.assertIn('zh', ears.passes)

    def test_both_on_a_miss_is_answered_in_the_labelled_language_and_is_unsure(self):
        for label in ('yue', 'zh'):
            with self.subTest(label=label):
                h = HomeHub()
                a = answer(b'x', True, Listener(), h, Ears(label, '今日食乜嘢', chinese=('yue', 'zh')))
                self.assertEqual(len(h.sent), 1, 'listed once')
                self.assertEqual((a.lang, a.handled, a.unsure), (label, False, True))

    def test_one_language_a_miss_is_sure(self):
        a = answer(b'x', True, Listener(), HomeHub(), Ears('zh', '今天吃什么'))
        self.assertFalse(a.unsure)

    def test_both_on_a_hint_decides(self):
        h, ears = HomeHub(), Ears('yue', '开厨房灯。', chinese=('yue', 'zh'))
        a = answer(b'x', True, Listener(), h, ears, prefer='zh')
        self.assertEqual(a.lang, 'zh')
        a = answer(b'x', True, Listener(), h, Ears('zh', '開廚房燈。', chinese=('yue', 'zh')), prefer='yue')
        self.assertEqual(a.lang, 'yue')


class SettingsTest(unittest.TestCase):
    def test_languages(self):
        conf = cfg.load({'HOMEHUB_URL': 'http://x', 'HOMEHUB_INTERNAL_KEY': 'k', 'LANGUAGES': 'en zh'})
        self.assertTrue(conf.mandarin)
        self.assertFalse(conf.cantonese)
        self.assertEqual(conf.mandarin_voice.name, 'zh_CN-huayan-medium.onnx')

    def test_wake_word(self):
        self.assertEqual(wake_language('你好小智', ['en', 'zh']), 'zh')
        self.assertIsNone(wake_language('你好小智', ['en', 'yue', 'zh']))


if __name__ == '__main__':
    unittest.main()
