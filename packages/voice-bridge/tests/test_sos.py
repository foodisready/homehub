"""Calls for help said to a speaker, in each language, and "cancel" after one."""
import unittest

from homehub_voice import sos
from homehub_voice.homehub import CommandResult, HomeHub, HomeHubError
from homehub_voice.pipeline import answer


class KindTest(unittest.TestCase):
    def test_cantonese(self):
        for t in ['救命', '救命呀！', '救命啊', '救命救命', '九命呀', '幫我叫人', '快啲叫人呀', '叫人嚟幫手', '我跌親', '我哋親', '我跌咗呀', '我好唔舒服']:
            self.assertEqual(sos.kind(t, 'yue'), sos.RAISE, t)
        for t in ['取消', '唔使', '唔使喇', '冇事', '我冇事呀']:
            self.assertEqual(sos.kind(t, 'yue'), sos.CANCEL, t)

    def test_mandarin(self):
        for t in ['救命', '救命啊！', '救救我', '帮我叫人', '快叫人', '我摔倒了', '我跌倒了', '我很不舒服']:
            self.assertEqual(sos.kind(t, 'zh'), sos.RAISE, t)
        for t in ['取消', '没事', '我没事', '不用了']:
            self.assertEqual(sos.kind(t, 'zh'), sos.CANCEL, t)

    def test_vietnamese(self):
        for t in ['Cứu tôi', 'cứu với!', 'Cứu với cứu với', 'Giúp tôi với', 'Gọi người giúp', 'Tôi bị ngã', 'Tôi ngã rồi', 'Gọi cấp cứu', 'CỨU TỘI VỚI NHAU', 'à cứu tôi với']:
            self.assertEqual(sos.kind(t, 'vi'), sos.RAISE, t)
        for t in ['Hủy', 'hủy bỏ', 'Không sao', 'Tôi không sao', 'Không cần']:
            self.assertEqual(sos.kind(t, 'vi'), sos.CANCEL, t)

    def test_english(self):
        for t in ['Help!', 'Help me.', 'Help, help!', 'Please help me', 'I need help', 'Call for help', 'Get help',
                  "I've fallen.", 'I have fallen', 'I fell down', 'Emergency!', 'SOS']:
            self.assertEqual(sos.kind(t, 'en'), sos.RAISE, t)
        for t in ['Cancel.', 'Cancel that', "I'm OK", 'I’m okay.', "I'm fine", 'Never mind', 'False alarm']:
            self.assertEqual(sos.kind(t, 'en'), sos.CANCEL, t)

    def test_not_a_call_for_help(self):
        # A TV or a conversation with the words in it, and the home's ordinary commands.
        for t, lang in [('the film where she shouts help me', 'en'), ('can you help me with the lights', 'en'),
                        ('turn on the kitchen light', 'en'), ('cancel the timer for the oven', 'en'), ('', 'en'),
                        ('佢喺度叫救命', 'yue'), ('開廚房燈', 'yue'), ('救命恩人', 'yue'), ('冇事做', 'yue'),
                        ('打开厨房灯', 'zh'), ('救命恩人', 'zh'), ('Bật đèn bếp', 'vi'), ('Cứu hộ giao thông', 'vi'), ('đi cứu người', 'vi'), ('không sao đâu mà anh ơi', 'vi'),
                        ('help me', 'yue'), ('救命', 'vi')]:
            self.assertIsNone(sos.kind(t, lang), (t, lang))

    def test_chinese_tries_the_languages_on(self):
        self.assertEqual(sos.chinese_kind('救命', ('yue', 'zh')), (sos.RAISE, 'yue'))
        self.assertEqual(sos.chinese_kind('我摔倒了', ('yue', 'zh')), (sos.RAISE, 'zh'))
        self.assertIsNone(sos.chinese_kind('我摔倒了', ('yue',)))


class Hub:
    names = ['Office Lamp', '廚房燈', 'đèn bếp']

    def __init__(self, state='raised', acked_by=None, reach=2, fail=False):
        self.state, self.acked_by, self.reach, self.fail = state, acked_by, reach, fail
        self.calls, self.sent = [], []

    def sos(self, action, where, lang, heard):
        if self.fail:
            raise HomeHubError('down')
        self.calls.append((action, where, lang, heard))
        if action == 'cancel':
            return {'state': 'cancelled' if self.state != 'nothing' else 'nothing'}
        return {'state': self.state, 'ackedBy': self.acked_by, 'reach': self.reach}

    def command(self, text, retry=False):
        self.sent.append(text)
        return CommandResult(False, "Sorry, I didn't understand.")


class Ears:
    def __init__(self, lang, text, chinese=('yue',)):
        self.lang, self.text, self.chinese = lang, text, chinese

    def hear(self, audio):
        return self.lang, self.text

    def transcribe(self, audio):
        return self.text


class NoWhisper:
    def transcribe(self, audio, names):
        raise AssertionError('Whisper not needed')


AUDIO = b'\0' * 32000


class PipelineTest(unittest.TestCase):
    def test_cantonese_call_for_help_then_cancel(self):
        hub = Hub()
        a = answer(AUDIO, True, NoWhisper(), hub, Ears('yue', '救命呀！'), where='Kitchen speaker')
        self.assertEqual(hub.calls, [('raise', 'Kitchen speaker', 'yue', '救命呀！')])
        self.assertEqual((a.reply, a.handled, a.lang, a.asked), ('我已經話咗俾屋企人知。冇事嘅話，講「取消」。', True, 'yue', sos.ASKED))
        # It listens again with no wake word: "取消" cancels.
        b = answer(AUDIO, True, NoWhisper(), hub, Ears('yue', '取消'), asked=a.asked, prefer='yue', where='Kitchen speaker')
        self.assertEqual(hub.calls[-1][0], 'cancel')
        self.assertEqual((b.reply, b.handled, b.asked), ('好，已經取消，我話返俾屋企人知你冇事。', True, None))
        self.assertEqual(hub.sent, [], 'never sent as a command')

    def test_vietnamese(self):
        hub = Hub()
        a = answer(AUDIO, True, NoWhisper(), hub, Ears('yue', '九'), vi_ears=Ears('', 'Cứu tôi với'), where='Bedroom')
        self.assertEqual(hub.calls, [('raise', 'Bedroom', 'vi', 'Cứu tôi với')])
        self.assertEqual(a.reply, 'Tôi đã báo cho gia đình rồi. Nếu không sao, hãy nói “tôi không sao”.')

    def test_mandarin_with_both_on(self):
        hub = Hub()
        a = answer(AUDIO, True, NoWhisper(), hub, Ears('zh', '我摔倒了', chinese=('yue', 'zh')))
        self.assertEqual((hub.calls[0][2], a.lang), ('zh', 'zh'))
        self.assertTrue(a.reply.startswith('我已经通知家人了'))

    def test_english(self):
        hub = Hub()
        a = answer(AUDIO, True, NoWhisper(), hub, Ears('en', 'Help me!'))
        self.assertEqual((hub.calls[0][0], a.reply), ('raise', "I've told the family. If you're OK, say cancel."))

    def test_someone_is_already_on_it(self):
        a = answer(AUDIO, True, NoWhisper(), Hub(state='already', acked_by='David'), Ears('yue', '救命'))
        self.assertEqual(a.reply, 'David已經知道，就嚟幫你。')
        self.assertIsNone(a.asked)
        b = answer(AUDIO, True, NoWhisper(), Hub(state='already'), Ears('en', 'help'))
        self.assertEqual(b.reply, 'The family knows, and someone is coming.')

    def test_nobody_to_tell_says_to_phone(self):
        a = answer(AUDIO, True, NoWhisper(), Hub(reach=0), Ears('yue', '救命'))
        self.assertEqual(a.reply, '我搵唔到人通知，請打電話求助。')

    def test_homehub_down_still_answers(self):
        a = answer(AUDIO, True, NoWhisper(), Hub(fail=True), Ears('en', 'Help!'))
        self.assertEqual((a.reply, a.handled), ("HomeHub isn't answering. Please phone for help.", True))

    def test_cancel_with_nothing_to_cancel_is_heard_as_usual(self):
        class Whisper:
            def transcribe(self, audio, names):
                return 'Cancel.'
        hub = Hub(state='nothing')
        a = answer(AUDIO, True, Whisper(), hub, Ears('en', 'Cancel.'))
        self.assertEqual(hub.calls[0][0], 'cancel')
        self.assertIn('Cancel.', hub.sent, 'goes on to HomeHub as a command')
        self.assertFalse(a.handled)



class AddressTest(unittest.TestCase):
    """v0.1.86 to v0.2.7 sent calls for help to /internal/voice/family/sos, which HomeHub doesn't
    answer: every one failed. HomeHub's address is /internal/voice/sos."""

    def test_a_call_for_help_goes_to_homehubs_address(self):
        import io, json, urllib.request
        sent = []

        def fake_urlopen(req, timeout=None):
            sent.append((req.full_url, json.loads(req.data)))
            return io.BytesIO(b'{"state": "raised"}')

        real = urllib.request.urlopen
        urllib.request.urlopen = fake_urlopen
        try:
            res = HomeHub('http://localhost:3000', 'k').sos('raise', 'Kitchen', 'en', 'I need help')
        finally:
            urllib.request.urlopen = real
        self.assertEqual(res, {'state': 'raised'})
        self.assertEqual(sent[0][0], 'http://localhost:3000/internal/voice/sos')
        self.assertEqual(sent[0][1]['action'], 'raise')

    def test_a_failed_call_for_help_is_logged(self):
        class Down:
            def sos(self, *a):
                raise HomeHubError('HomeHub answered 404')
        with self.assertLogs('homehub-voice', 'ERROR') as logs:
            r = sos.run(sos.RAISE, 'I need help', 'en', Down(), 'Kitchen')
        self.assertIn("HomeHub didn't take it: HomeHub answered 404", logs.output[0])
        self.assertTrue(r.handled)


if __name__ == '__main__':
    unittest.main()
