"""HomeHub's "Did you mean…?" out loud: a command its rules missed comes back as "Turn on Porch light?",
the speaker listens again, and a yes or no answers it, in each language."""
import http.server
import json
import threading
import unittest

from homehub_voice import confirm
from homehub_voice.homehub import CommandResult, HomeHub
from homehub_voice.pipeline import answer

AUDIO = b'\0' * 32000


class KindTest(unittest.TestCase):
    def test_english(self):
        for t in ['Yes.', 'yeah', 'Yes please', 'OK.', 'Sure, thanks', "That's right", 'Go ahead.', 'Do it']:
            self.assertEqual(confirm.kind(t, 'en'), confirm.YES, t)
        for t in ['No.', 'Nope', 'Cancel', "Don't", 'Never mind', 'No thanks.']:
            self.assertEqual(confirm.kind(t, 'en'), confirm.NO, t)
        for t in ['Turn on the porch light.', 'What time is it?', 'Yes turn it on now please thanks']:
            self.assertIsNone(confirm.kind(t, 'en'), t)

    def test_cantonese(self):
        for t in ['係', '係呀', '系', '好', '好呀', '啱', '得', '冇錯', '唔該', '好呀，唔該', '是']:
            self.assertEqual(confirm.kind(t, 'yue'), confirm.YES, t)
        for t in ['唔係', '唔使', '唔好', '唔要', '錯', '取消', '唔係呀', '不是']:
            self.assertEqual(confirm.kind(t, 'yue'), confirm.NO, t)
        self.assertIsNone(confirm.kind('開廚房燈', 'yue'))

    def test_mandarin(self):
        for t in ['是', '是的', '好', '好的', '对', '对的', '可以', '嗯', '行', '没错']:
            self.assertEqual(confirm.kind(t, 'zh'), confirm.YES, t)
        for t in ['不', '不是', '不要', '不用', '别', '取消', '不对', '算了']:
            self.assertEqual(confirm.kind(t, 'zh'), confirm.NO, t)

    def test_vietnamese(self):
        for t in ['Có.', 'Vâng ạ', 'Dạ', 'Ừ', 'Đúng rồi', 'Được', 'Đồng ý', 'co', 'vang a']:
            self.assertEqual(confirm.kind(t, 'vi'), confirm.YES, t)
        for t in ['Không.', 'Không ạ', 'Thôi', 'Đừng', 'Không phải', 'khong']:
            self.assertEqual(confirm.kind(t, 'vi'), confirm.NO, t)
        # Without accents, "dung" could be đúng (yes) or đừng (don't): neither.
        self.assertIsNone(confirm.kind('dung', 'vi'))

    def test_loose_straight_after(self):
        self.assertEqual(confirm.loose_kind('Yes, turn it on', 'en'), confirm.YES)
        self.assertEqual(confirm.loose_kind('No, leave it', 'en'), confirm.NO)
        self.assertEqual(confirm.loose_kind('係呀開啦', 'yue'), confirm.YES)
        self.assertEqual(confirm.loose_kind('唔係嗰個', 'yue'), confirm.NO)
        self.assertEqual(confirm.loose_kind('Có, bật đi', 'vi'), confirm.YES)
        self.assertEqual(confirm.loose_kind('Không, cảm ơn', 'vi'), confirm.NO)
        self.assertIsNone(confirm.loose_kind('Turn off the desk lamp in the office', 'en'))
        self.assertIsNone(confirm.loose_kind('Tell me what time it is', 'en'))

    def test_a_length_of_time_after_the_answer_keeps_it_an_answer(self):
        # From the Pi's log, 2026-11-26: 系啦五十分钟 answered 係咪要開早餐燈仔？
        for text, lang in (('系啦五十分钟。', 'yue'), ('係啦，五十分鐘', 'yue'), ('好呀，個半鐘', 'yue'), ('是的，三十分钟', 'zh'),
                           ('Yes, for two hours.', 'en'), ('Yes please, 30 minutes', 'en'), ('Sure, half an hour.', 'en'),
                           ('Yes turn it on for an hour and a half', 'en'), ('Có, ba mươi phút', 'vi'), ('Vâng, một tiếng', 'vi')):
            self.assertEqual(confirm.loose_kind(text, lang), confirm.YES, text)
        self.assertEqual(confirm.loose_kind('唔係，五十分鐘', 'yue'), confirm.NO)
        self.assertEqual(confirm.loose_kind('No, for two hours', 'en'), confirm.NO)
        self.assertIsNone(confirm.loose_kind('Turn off the desk lamp in the office for ten minutes', 'en'))


class Hub:
    """HomeHub with Claude chosen: commands it doesn't know come back as a question."""
    names = ['Porch light', 'Desk lamp', '廚房燈']
    scenes: list = []
    groups: list = []
    asking: list = []
    can_ask = True

    def __init__(self, gone=False):
        self.sent, self.answers, self.heard, self.gone = [], [], [], gone

    def command(self, text, retry=False, lang=None, ask=False):
        self.sent.append((text, retry, lang, ask))
        if text.lower().startswith(('turn ', 'run ')):
            return CommandResult(True, 'Done.')
        if ask and not retry:
            q = {'en': 'Turn on Porch light?', 'yue': '係咪要開Porch light？', 'zh': '要打开Porch light吗？', 'vi': 'Bật Porch light?'}[lang or 'en']
            return CommandResult(False, q, [], None, q, lang or 'en', 'c1')
        return CommandResult(False, "Sorry, I didn't understand.")

    def answer_confirm(self, confirm_id, k, heard=''):
        self.answers.append((confirm_id, k))
        self.heard.append(heard)
        if self.gone:
            return None
        return {'handled': k == 'yes', 'response': 'Turned on Porch light.' if k == 'yes' else 'OK, I left everything as it was.', 'lang': 'en'}

    def answer_ask(self, *a):
        raise AssertionError('not a reminder')

    def sos(self, *a):
        return {'state': 'nothing'}


class Whisper:
    def __init__(self, text):
        self.text = text

    def transcribe(self, audio, names):
        return self.text


class Ears:
    def __init__(self, lang, text, chinese=('yue',)):
        self.lang, self.text, self.chinese = lang, text, chinese

    def hear(self, audio):
        return self.lang, self.text

    def transcribe(self, audio, lang=None):
        return self.text


class ViEars:
    def __init__(self, text):
        self.text = text

    def transcribe(self, audio):
        return self.text


class PipelineTest(unittest.TestCase):
    def test_english_miss_is_asked_and_yes_answers_it(self):
        hub = Hub()
        a = answer(AUDIO, True, Whisper('Make the front brighter.'), hub)
        self.assertEqual((a.reply, a.handled, a.asked, a.lang), ('Turn on Porch light?', False, 'confirm:c1', 'en'))
        self.assertEqual(hub.sent[-1], ('Make the front brighter.', False, 'en', True))
        b = answer(AUDIO, True, Whisper('Yes.'), hub, asked=a.asked, prefer=a.lang)
        self.assertEqual(hub.answers, [('c1', 'yes')])
        self.assertEqual((b.reply, b.handled, b.asked), ('Turned on Porch light.', True, None))

    def test_the_words_of_the_yes_go_to_homehub(self):
        # HomeHub reads how long from them.
        hub = Hub()
        answer(AUDIO, True, Whisper('Yes, for two hours.'), hub, asked='confirm:c1', prefer='en')
        self.assertEqual((hub.answers, hub.heard), ([('c1', 'yes')], ['Yes, for two hours.']))

    def test_no(self):
        hub = Hub()
        b = answer(AUDIO, True, Whisper('No thanks.'), hub, asked='confirm:c1', prefer='en')
        self.assertEqual(hub.answers, [('c1', 'no')])
        self.assertEqual(b.reply, 'OK, I left everything as it was.')

    def test_a_new_command_instead_drops_the_question(self):
        hub = Hub()
        b = answer(AUDIO, True, Whisper('Turn off the desk lamp.'), hub, asked='confirm:c1', prefer='en')
        self.assertEqual(hub.answers, [])
        self.assertEqual(b.reply, 'Done.')

    def test_yes_without_a_question_is_just_words(self):
        hub = Hub()
        answer(AUDIO, True, Whisper('Yes.'), hub)
        self.assertEqual(hub.answers, [])

    def test_question_gone(self):
        hub = Hub(gone=True)
        b = answer(AUDIO, True, Whisper('Yes.'), hub, asked='confirm:c1', prefer='en')
        self.assertEqual(b.reply, confirm.GONE['en'])
        self.assertFalse(b.handled)

    def test_first_try_heard_again_isnt_asked(self):
        # With Cantonese on, English is tried with SenseVoice's words first (a retry): no question then.
        hub = Hub()
        a = answer(AUDIO, True, Whisper('Make the front brighter.'), hub, Ears('en', 'Make the front brighter.'))
        self.assertEqual([s[1:] for s in hub.sent], [(True, 'en', True), (False, 'en', True)])
        self.assertEqual(a.asked, 'confirm:c1')

    def test_cantonese_miss_and_yes(self):
        hub = Hub()
        a = answer(AUDIO, True, Whisper(''), hub, Ears('yue', '個門口燈開大啲'))
        self.assertEqual((a.reply, a.lang, a.asked), ('係咪要開Porch light？', 'yue', 'confirm:c1'))
        self.assertEqual(hub.sent[-1][2:], ('yue', True))
        b = answer(AUDIO, True, Whisper(''), hub, Ears('yue', '係呀'), asked=a.asked, prefer='yue')
        self.assertEqual(hub.answers, [('c1', 'yes')])
        self.assertTrue(b.handled)

    def test_cantonese_name_alone_asks_its_own_question(self):
        # 廚房燈 alone: the bridge asks "on or off?" itself, so HomeHub isn't asked to.
        hub = Hub()
        a = answer(AUDIO, True, Whisper(''), hub, Ears('yue', '廚房燈'))
        self.assertEqual(a.asked, '廚房燈')
        self.assertFalse(any(s[3] for s in hub.sent))

    def test_vietnamese_miss_and_no(self):
        hub = Hub()
        a = answer(AUDIO, True, Whisper(''), hub, vi_ears=ViEars('làm sáng phía trước'), prefer='vi')
        self.assertEqual((a.reply, a.lang, a.asked), ('Bật Porch light?', 'vi', 'confirm:c1'))
        b = answer(AUDIO, True, Whisper(''), hub, vi_ears=ViEars('Không.'), asked=a.asked, prefer='vi')
        self.assertEqual(hub.answers, [('c1', 'no')])
        self.assertEqual(b.reply, 'OK, I left everything as it was.')

    def test_the_wake_word_goes_with_a_miss(self):
        # From the Pi, 2026-11-21: "冇有熄啊亮灯" after 老友, its end heard as 冇有. HomeHub's Claude is told
        # the wake word, so it can leave it out.
        class Woken(Hub):
            def command(self, text, retry=False, lang=None, ask=False, wake=None):
                self.wakes.append(wake)
                return super().command(text, retry, lang, ask)
        hub = Woken()
        hub.wakes = []
        answer(AUDIO, True, Whisper(''), hub, Ears('yue', '冇有熄啊亮灯。'), wake='老友')
        self.assertIn('老友', hub.wakes)
        # Listening again with no wake word, none is sent.
        hub.wakes.clear()
        answer(AUDIO, True, Whisper(''), hub, Ears('yue', '冇有熄啊亮灯。'))
        self.assertEqual(set(hub.wakes), {None})

    def test_talk_in_the_room_claude_cant_place_stays_quiet(self):
        class Nothing(Hub):
            def command(self, text, retry=False, lang=None, ask=False):
                self.sent.append((text, retry, lang, ask))
                return CommandResult(False, "Sorry, I didn't understand.")
        hub = Nothing()
        a = answer(AUDIO, True, Whisper("I don't want to pay for your drink tonight."), hub)
        self.assertTrue(hub.sent[-1][3], 'Claude is asked')
        self.assertTrue(a.chatter, 'nothing to ask about: the speaker stays quiet')

    def test_a_bridge_against_a_homehub_that_cant_ask(self):
        class Old(Hub):
            can_ask = False

            def command(self, text, retry=False):
                self.sent.append((text, retry, None, False))
                return CommandResult(False, "Sorry, I didn't understand.")
        hub = Old()
        a = answer(AUDIO, True, Whisper('Make the front brighter.'), hub)
        self.assertIsNone(a.asked)


class Stub(http.server.BaseHTTPRequestHandler):
    seen: list = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        Stub.seen.append((self.path, body))
        if self.path.endswith('/command'):
            out = {'handled': False, 'response': 'Turn on Porch light?', 'say': 'Turn on Porch light?', 'lang': 'en',
                   'confirmId': 'a/b', 'actions': []}
            code = 200
        elif self.path.endswith('/confirm/a%2Fb'):
            out, code = {'handled': True, 'response': 'Turned on Porch light.', 'lang': 'en'}, 200
        else:
            out, code = {'error': 'Not asking'}, 404
        data = json.dumps(out).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_address[1]}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_ask_and_answer(self):
        h = HomeHub(self.url, 'k')
        h.names = ['Porch light']
        res = h.command('make the front brighter', lang='en', ask=True)
        self.assertEqual(Stub.seen[-1], ('/internal/voice/command', {'text': 'make the front brighter', 'questions': True, 'ask': True, 'lang': 'en'}))
        self.assertEqual((res.say, res.say_lang, res.confirm_id), ('Turn on Porch light?', 'en', 'a/b'))
        self.assertEqual(h.answer_confirm('a/b', 'yes')['response'], 'Turned on Porch light.')
        self.assertEqual(Stub.seen[-1][1], {'answer': 'yes'})
        self.assertIsNone(h.answer_confirm('gone', 'yes'))

    def test_retry_never_asks(self):
        h = HomeHub(self.url, 'k')
        h.names = ['Porch light']
        h.command('make the front brighter', retry=True, lang='en', ask=True)
        self.assertEqual(Stub.seen[-1][1], {'text': 'make the front brighter', 'questions': True, 'retry': True, 'lang': 'en'})

    def test_a_question_goes_with_what_was_heard(self):
        h = HomeHub(self.url, 'k')
        h.command("what's the weather today", lang='yue', heard='紐約天氣點')
        self.assertEqual(Stub.seen[-1][1], {'text': "what's the weather today", 'questions': True, 'lang': 'yue', 'heard': '紐約天氣點'})


if __name__ == '__main__':
    unittest.main()
