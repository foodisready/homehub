"""Answers to a reminder that asks back ("食咗藥未呀？"), in each language."""
import unittest

from homehub_voice import ask
from homehub_voice.homehub import CommandResult
from homehub_voice.pipeline import answer


class KindTest(unittest.TestCase):
    def test_cantonese(self):
        for t in ['食咗', '食咗喇', '已經食咗', '食咗藥', '有', '係呀', '好', '搞掂']:
            self.assertEqual(ask.kind(t, 'yue'), ask.YES, t)
        for t in ['未', '未呀', '未食', '仲未', '冇', '唔記得咗']:
            self.assertEqual(ask.kind(t, 'yue'), ask.NO, t)

    def test_mandarin(self):
        for t in ['吃了', '吃过了', '已经吃了', '是', '好', '对']:
            self.assertEqual(ask.kind(t, 'zh'), ask.YES, t)
        for t in ['没有', '还没', '还没有', '没吃', '忘了', '没有啊']:
            self.assertEqual(ask.kind(t, 'zh'), ask.NO, t)

    def test_vietnamese(self):
        for t in ['Rồi', 'Uống rồi', 'Có', 'Vâng', 'Dạ rồi', 'Xong rồi']:
            self.assertEqual(ask.kind(t, 'vi'), ask.YES, t)
        for t in ['Chưa', 'Chưa uống', 'Không', 'Dạ chưa', 'Quên rồi']:
            self.assertEqual(ask.kind(t, 'vi'), ask.NO, t)

    def test_english(self):
        for t in ['Yes.', 'Yeah', 'Done', 'I have', 'I took it', "I've taken them", 'Yes I did']:
            self.assertEqual(ask.kind(t, 'en'), ask.YES, t)
        for t in ['No.', 'Not yet', "I haven't", 'I forgot', 'Later']:
            self.assertEqual(ask.kind(t, 'en'), ask.NO, t)

    def test_not_an_answer(self):
        for t, lang in [('開廚房燈', 'yue'), ('食咗飯未呀', 'yue'), ('Turn on the lamp', 'en'), ('yes turn on the light', 'en'), ('Bật đèn', 'vi')]:
            self.assertIsNone(ask.kind(t, lang), (t, lang))


class LooseTest(unittest.TestCase):
    def test_misheard_answers_straight_after_asking(self):
        # As the Pi's SenseVoice heard them.
        self.assertEqual(ask.loose_kind('你咗啦。', 'yue'), ask.YES)
        self.assertEqual(ask.loose_kind('已经热咗。', 'yue'), ask.YES)
        self.assertEqual(ask.loose_kind('仲咪。', 'yue'), None)
        self.assertEqual(ask.loose_kind('未食呀', 'yue'), ask.NO)
        self.assertEqual(ask.loose_kind('HỨA RỒI', 'vi'), ask.YES)
        self.assertEqual(ask.loose_kind('THIẾU CHƯA', 'vi'), ask.NO)
        self.assertEqual(ask.loose_kind('Yes, I took them already.', 'en'), ask.YES)
        self.assertEqual(ask.loose_kind("No, I haven't.", 'en'), ask.NO)

    def test_still_not_anything(self):
        self.assertIsNone(ask.loose_kind('開咗廚房燈未呀然後熄埋客廳燈', 'yue'))
        self.assertIsNone(ask.loose_kind('Turn on the office lamp', 'en'))
        self.assertIsNone(ask.loose_kind('', 'en'))


class Hub:
    names = ['Office Lamp', '廚房燈']

    def __init__(self, asking=None, accept=True):
        self.asking = asking if asking is not None else [{'id': 3, 'lang': 'yue'}]
        self.accept = accept
        self.answers, self.sent = [], []

    def answer_ask(self, ask_id, answer, kind='reminder'):
        self.answers.append((ask_id, answer) if kind == 'reminder' else (ask_id, answer, kind))
        return self.accept

    def sos(self, *a):
        return {'state': 'nothing'}

    def command(self, text, retry=False):
        self.sent.append(text)
        return CommandResult(True, 'Done.')


class Ears:
    def __init__(self, lang, text):
        self.lang, self.text, self.chinese = lang, text, ('yue',)

    def hear(self, audio):
        return self.lang, self.text

    def transcribe(self, audio):
        return self.text


class NoWhisper:
    def transcribe(self, audio, names):
        raise AssertionError('Whisper not needed')


AUDIO = b'\0' * 32000


class PipelineTest(unittest.TestCase):
    def test_answer_straight_after_the_reminder(self):
        hub = Hub()
        a = answer(AUDIO, True, NoWhisper(), hub, Ears('yue', '食咗喇'), asked='ask:3', prefer='yue')
        self.assertEqual(hub.answers, [(3, 'yes')])
        self.assertEqual((a.reply, a.handled, a.lang), ('好，記低咗。', True, 'yue'))
        self.assertEqual(hub.sent, [])

    def test_loose_only_straight_after(self):
        hub = Hub()
        a = answer(AUDIO, True, NoWhisper(), hub, Ears('yue', '你咗啦。'), asked='ask:3', prefer='yue')
        self.assertEqual(hub.answers, [(3, 'yes')])
        hub2 = Hub()
        answer(AUDIO, True, NoWhisper(), hub2, Ears('yue', '你咗啦。'))
        self.assertEqual(hub2.answers, [], 'later, with the wake word, it must be clear')

    def test_not_yet_later_with_the_wake_word(self):
        hub = Hub(asking=[{'id': 3, 'lang': 'yue'}, {'id': 4, 'lang': 'en'}])
        a = answer(AUDIO, True, NoWhisper(), hub, Ears('en', 'Not yet.'))
        self.assertEqual(hub.answers, [(4, 'no')], 'the English one')
        self.assertEqual(a.reply, "OK, I'll ask again in 10 minutes.")

    def test_nothing_asked_means_yes_is_just_yes(self):
        class Whisper:
            def transcribe(self, audio, names):
                return 'Yes.'
        hub = Hub(asking=[])
        answer(AUDIO, True, Whisper(), hub, Ears('en', 'Yes.'))
        self.assertEqual(hub.answers, [])
        self.assertIn('Yes.', hub.sent)

    def test_a_command_still_works_while_asking(self):
        hub = Hub()
        answer(AUDIO, True, NoWhisper(), hub, Ears('en', 'Turn on the office lamp.'))
        self.assertEqual(hub.answers, [])
        self.assertEqual(hub.sent, ['Turn on the office lamp.'])



class CheckinKindTest(unittest.TestCase):
    """"亞娘，你冇事吖嘛？": I'm fine, or I'm not."""

    def test_fine(self):
        for t, lang in [('冇事', 'yue'), ('我冇事呀', 'yue'), ('冇事冇事', 'yue'), ('好好', 'yue'), ('幾好', 'yue'), ('冇問題', 'yue'),
                        ('我起咗身喇', 'yue'), ('没事', 'zh'), ('我很好', 'zh'), ('还好', 'zh'), ('Không sao.', 'vi'), ('Tôi khỏe.', 'vi'),
                        ('Dạ', 'vi'), ('Không sao ạ', 'vi'), ("I'm OK.", 'en'), ("I'm fine, thanks.", 'en'), ('Yes.', 'en'), ('Okay.', 'en')]:
            self.assertEqual(ask.kind(t, lang, ask.CHECKIN), ask.YES, t)

    def test_not_fine(self):
        for t, lang in [('唔舒服', 'yue'), ('我好唔舒服', 'yue'), ('我有事', 'yue'), ('不舒服', 'zh'), ('Tôi mệt.', 'vi'), ('Không khỏe', 'vi'),
                        ("I'm not OK.", 'en'), ("I don't feel well.", 'en'), ('No.', 'en')]:
            self.assertEqual(ask.kind(t, lang, ask.CHECKIN), ask.NO, t)

    def test_fine_to_a_checkin_is_not_done_to_a_reminder(self):
        self.assertEqual(ask.kind('冇事', 'yue', ask.CHECKIN), ask.YES)
        self.assertIsNone(ask.kind('冇事', 'yue'), "冇事 isn't an answer to 食咗藥未呀")
        self.assertEqual(ask.kind('Không sao', 'vi', ask.CHECKIN), ask.YES)
        self.assertIsNone(ask.kind('Không sao', 'vi'))

    def test_loose_straight_after(self):
        self.assertEqual(ask.loose_kind('佢冇事喎', 'yue', ask.CHECKIN), ask.YES)
        self.assertEqual(ask.loose_kind('有啲唔舒服', 'yue', ask.CHECKIN), ask.NO)
        self.assertEqual(ask.loose_kind("I'm not okay really", 'en', ask.CHECKIN), ask.NO, '"not OK" has an OK in it')
        self.assertEqual(ask.loose_kind("yeah I'm doing okay", 'en', ask.CHECKIN), ask.YES)
        self.assertIsNone(ask.loose_kind('今日天氣好好，我哋出去行吓街啦', 'yue', ask.CHECKIN), 'a long sentence is talk, not an answer')
        self.assertIsNone(ask.loose_kind('the weather is fine and the kids are good at school today', 'en', ask.CHECKIN))


class CheckinPipelineTest(unittest.TestCase):
    def test_fine_straight_after_the_question(self):
        hub = Hub(asking=[{'id': 9, 'lang': 'yue', 'kind': 'checkin'}])
        a = answer(AUDIO, True, NoWhisper(), hub, Ears('yue', '我冇事呀'), asked='ask:9', prefer='yue')
        self.assertEqual(hub.answers, [(9, 'yes', 'checkin')])
        self.assertEqual((a.reply, a.handled), ('好，多謝你。', True))
        self.assertEqual(hub.sent, [])

    def test_not_fine_later_with_the_wake_word(self):
        hub = Hub(asking=[{'id': 9, 'lang': 'yue', 'kind': 'checkin'}])
        a = answer(AUDIO, True, NoWhisper(), hub, Ears('yue', '唔舒服'))
        self.assertEqual(hub.answers, [(9, 'no', 'checkin')])
        self.assertEqual(a.reply, '我而家通知屋企人。')

    def test_a_checkin_before_a_reminder(self):
        hub = Hub(asking=[{'id': 3, 'lang': 'yue'}, {'id': 9, 'lang': 'yue', 'kind': 'checkin'}])
        answer(AUDIO, True, NoWhisper(), hub, Ears('yue', '好'))
        self.assertEqual(hub.answers, [(9, 'yes', 'checkin')], '好 answers the check-in')
        hub = Hub(asking=[{'id': 3, 'lang': 'yue'}, {'id': 9, 'lang': 'yue', 'kind': 'checkin'}])
        answer(AUDIO, True, NoWhisper(), hub, Ears('yue', '食咗喇'))
        self.assertEqual(hub.answers, [(3, 'yes')], "食咗 is the reminder's")

    def test_no_checkin_waiting(self):
        hub = Hub(asking=[{'id': 3, 'lang': 'yue'}])
        answer(AUDIO, True, NoWhisper(), hub, Ears('yue', '冇事'))
        self.assertEqual(hub.answers, [], "冇事 doesn't answer a reminder")


if __name__ == '__main__':
    unittest.main()
