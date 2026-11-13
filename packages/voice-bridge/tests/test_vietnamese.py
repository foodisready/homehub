"""Vietnamese commands: read against the home's names, passed to HomeHub, answered in Vietnamese.

The texts below are what the Vietnamese speech model (sherpa-onnx Zipformer) really
wrote for the household's recordings, mistakes included, and what it wrote for
Cantonese and English recordings, which must not be taken for Vietnamese.
No speech models are needed."""
from __future__ import annotations

import unittest

from homehub_voice import config as cfg
from homehub_voice import vietnamese as vi
from homehub_voice.homehub import CommandResult, HomeHubError
from homehub_voice.pipeline import answer

# Each device's names, as HomeHub lists them: its English alias, then its nicknames.
GROUPS = [
    ['Kitchen lights', 'đèn bếp', 'đèn nhà bếp'],
    ['Living room lights', 'đèn phòng khách'],
    ['Bedroom lights', 'đèn phòng ngủ'],
    ['Master bedroom lights', 'đèn phòng ngủ lớn'],
    ['Hallway lights', 'đèn hành lang'],
    ['My office lamp', 'đèn phòng làm việc', 'đèn văn phòng'],
    ['Dining room lights', 'đèn phòng ăn', 'đèn bàn ăn'],
    ['Garage door', 'cửa ga-ra', 'ga-ra', 'cửa nhà xe', 'nhà xe'],
    ['Kitchen', '廚房燈'],
]
SCENES = ['Goodnight', 'chúc ngủ ngon']
NAMES = [n for g in GROUPS for n in g] + SCENES


def read(text):
    c = vi.parse(text, NAMES, SCENES, GROUPS)
    return (c.action, c.name) if c else None


# What the model wrote for each recording, and what it should do.
HEARD = [
    ('ĐÓNG CỬA NHÀ XE', ('off', 'cửa nhà xe')),
    ('MỞ CỬA GA RA', ('on', 'cửa ga-ra')),
    ('MỞ CỬA NHÀ XE', ('on', 'cửa nhà xe')),
    ('MỞ GA RA', ('on', 'ga-ra')),
    ('TẮT ĐÈN PHÒNG NGỦ', ('off', 'đèn phòng ngủ')),
    ('TẮT HẾT ĐÈN PHÒNG NGỦ', ('off', 'đèn phòng ngủ')),
    ('TẮT ĐÈN PHÒNG ĂN', ('off', 'đèn phòng ăn')),
    ('TẮT ĐÈN BÀN ĂN', ('off', 'đèn bàn ăn')),
    ('TẮT HẾT ĐÈN HÀNH LANG', ('off', 'đèn hành lang')),
    ('TẮT ĐÈN BẾP', ('off', 'đèn bếp')),
    ('TẮT ĐÈN NHÀ BẾP', ('off', 'đèn nhà bếp')),
    ('TẮT HẾT ĐÈN BẾP', ('off', 'đèn bếp')),
    ('TẮT ĐÈN PHONG CÁCH', ('off', 'đèn phòng khách')),      # "phòng khách" misheard
    ('TẮT HẾT ĐÈN PHÒNG KHÁCH', ('off', 'đèn phòng khách')),
    ('TẮT ĐÈN PHÒNG NGỦ LỚN', ('off', 'đèn phòng ngủ lớn')),
    ('TẮT ĐÈN PHÒNG LÀM VIỆC', ('off', 'đèn phòng làm việc')),
    ('TẮT ĐÈN VĂN PHÒNG', ('off', 'đèn văn phòng')),
    ('BẬT ĐÈN PHÒNG NGỦ', ('on', 'đèn phòng ngủ')),
    ('MỞ ĐÈN PHÒNG NGỦ', ('on', 'đèn phòng ngủ')),
    ('BẬT ĐÈN HÀNH LANG', ('on', 'đèn hành lang')),
    ('MỞ ĐÈN BẾP', ('on', 'đèn bếp')),
    ('BẬT ĐÈN NHÀ BẾP', ('on', 'đèn nhà bếp')),
    ('BẬT ĐÈN PHÒNG NGỦ LỚN', ('on', 'đèn phòng ngủ lớn')),
    ('MỞ ĐÈN PHÒNG LÀM VIỆC', ('on', 'đèn phòng làm việc')),
    ('BẬT ĐÈN VĂN PHÒNG', ('on', 'đèn văn phòng')),
    # From the Pi, 2026-11-12: "đèn" heard as "nền".
    ('MỞ NỀN NHÀ BẾP', ('on', 'đèn nhà bếp')),
    ('TẮT ĐÈN VÀ BẾP', ('off', 'đèn nhà bếp')),
    ('MỞ ĐÈN VÀ PEP', ('on', 'đèn nhà bếp')),      # b heard as p
]
# What it wrote for Cantonese and English recordings.
NOT_VIETNAMESE = ['QUAN CHE PHỦ', 'GIÓ CHEN', 'QUAN TRƯỚC KHI PHÓNG', 'XÍCH SAU KHI PHÓNG', 'XÍCH CHÁO LOẠN',
                  'QUAN CHỈ PHÓNG', 'DỊCH CHỈ PHÓNG', 'XÍCH PHÓNG', 'HOÀN', 'QUAN TRỌNG', 'MẠNH PHỎNG', 'SẼ CHỈ LỖ',
                  'KHOAN SẼ CHỊU TĂNG', 'XÍCH PHẢN', 'QUAN CUNG', 'SUY', 'THÔI CHO KHI PHÓNG', 'TRƯỚC SAU KHI PHÓNG',
                  'CHẢO LỘN', 'CHÁU LỎNG', 'CHỈ PHÓNG', 'TRIỆU PHÓNG', 'TRÍ ẨN PHÓNG', 'KHÔI', 'MẠNH PHÓNG',
                  'SUY TĂNG', 'THÔI SẼ CHỊU LỖ', 'BẢN CUNG', 'SẼ CHỈ ĐỘ TĂNG', 'KHOẢN CUNG', 'SIỖNG TĂNG',
                  'CON CHÁU LÓNG', 'TRAUN TESION LINK', 'TEN OFGON LINK', 'TRAUN ON LEING REM LIKE PHENT', 'WAT',
                  'FLOD CRAS', 'TEN ON TECHION LINK', 'TRAU D OPE LAM', 'OPEN TE', 'EBOK LIN', 'EDO SÀI GÒN']


class ReadingTest(unittest.TestCase):
    def test_the_households_recordings(self):
        for text, want in HEARD:
            with self.subTest(text):
                self.assertEqual(read(text), want)
                self.assertTrue(vi.is_vietnamese(text, NAMES, SCENES, GROUPS))

    def test_cantonese_and_english_are_not_vietnamese(self):
        for text in NOT_VIETNAMESE:
            with self.subTest(text):
                self.assertFalse(vi.is_vietnamese(text, NAMES, SCENES, GROUPS))

    def test_bat_could_be_on_or_off_so_it_asks(self):
        # Several models wrote "bắt" for the household's "tắt đèn bếp".
        self.assertEqual(read('BẮT ĐÈN BẾP'), ('ask', 'đèn bếp'))
        self.assertTrue(vi.is_vietnamese('BẮT ĐÈN BẾP', NAMES, SCENES, GROUPS))

    def test_a_final_c_for_t_is_still_the_verb(self):
        # From a tablet across the room, 2026-11-13: "bật đèn nhà bếp" heard as "BẬC ĐÈN NHÀ BẾP".
        self.assertEqual(read('BẬC ĐÈN NHÀ BẾP'), ('on', 'đèn nhà bếp'))
        self.assertEqual(read('TẮC ĐÈN BẾP'), ('off', 'đèn bếp'))
        self.assertEqual(vi.verb_alone('BẬC'), 'on')

    def test_a_word_more_or_less_is_another_room(self):
        names = ['đèn phòng ngủ lớn', 'đèn bếp']
        self.assertIsNone(vi.parse('tắt đèn phòng ngủ', names, [], [[n] for n in names]))

    def test_an_unknown_name_is_not_a_known_one(self):
        # Letter by letter, "sân thượng" (rooftop) came out close to "văn phòng".
        self.assertIsNone(read('bật đèn sân thượng'))
        self.assertIsNone(read('tắt đèn phòng tắm'))

    def test_a_name_cut_short_is_not_guessed(self):
        self.assertIsNone(read('ĐÓNG CỬA GA'))
        self.assertIsNone(read('ĐÓNG GA'))
        # But it's still Vietnamese, so the answer is too.
        self.assertTrue(vi.is_vietnamese('ĐÓNG GA', NAMES, SCENES, GROUPS))
        self.assertTrue(vi.is_vietnamese('MỞ GA', NAMES, SCENES, GROUPS))

    def test_light_said_or_left_out(self):
        self.assertEqual(vi.parse('bật bếp', ['đèn bếp'], [], [['đèn bếp']]).name, 'đèn bếp')
        self.assertEqual(vi.parse('bật đèn bếp', ['bếp'], [], [['bếp']]).name, 'bếp')

    def test_without_accents(self):
        self.assertEqual(read('bat den bep'), None)        # "bat" could be bật or bắt: not without accents
        self.assertEqual(vi.parse('bật đèn bếp', ['den bep'], [], [['den bep']]).name, 'den bep')

    def test_polite_words(self):
        self.assertEqual(read('làm ơn bật đèn bếp đi'), ('on', 'đèn bếp'))
        self.assertEqual(read('bật giúp tôi đèn hành lang nhé'), ('on', 'đèn hành lang'))
        self.assertEqual(read('tắt đèn phòng khách giùm'), ('off', 'đèn phòng khách'))

    def test_two_nicknames_of_one_device_are_not_a_close_call(self):
        # "đèn bếp" and "đèn nhà bếp" are both the kitchen lights.
        self.assertEqual(read('bật đèn nhà bếp'), ('on', 'đèn nhà bếp'))

    def test_chinese_names_are_left_to_cantonese(self):
        self.assertNotIn('廚房燈', vi.candidates(NAMES))

    def test_scene_and_name_alone(self):
        self.assertEqual(read('chúc ngủ ngon'), ('scene', 'chúc ngủ ngon'))
        self.assertEqual(read('đèn hành lang'), ('ask', 'đèn hành lang'))
        self.assertIsNone(read('phòng'))

    def test_verb_alone(self):
        self.assertEqual(vi.verb_alone('bật'), 'on')
        self.assertEqual(vi.verb_alone('TẮT ĐI'), 'off')
        self.assertIsNone(vi.verb_alone('bắt'))
        self.assertIsNone(vi.verb_alone('bật đèn bếp'))


class DurationTest(unittest.TestCase):
    def test_durations(self):
        cases = {
            'bật đèn bếp mười phút': 10,
            'bật đèn bếp 20 phút': 20,
            'bật đèn bếp trong mười lăm phút': 15,
            'bật đèn bếp hai mươi lăm phút': 25,
            'bật đèn bếp nửa tiếng': 30,
            'bật đèn bếp một tiếng rồi tắt': 60,
            'bật đèn bếp một tiếng rưỡi': 90,
            'bật đèn bếp hai giờ': 120,
        }
        for text, minutes in cases.items():
            with self.subTest(text):
                c = vi.parse(text, NAMES, SCENES, GROUPS)
                self.assertEqual((c.action, c.name, c.minutes), ('on', 'đèn bếp', minutes))
                self.assertEqual(c.homehub_text, f'turn on đèn bếp for {minutes} minutes')

    def test_off_for_a_while_is_not_guessed(self):
        self.assertIsNone(read('tắt đèn bếp mười phút'))

    def test_say_minutes(self):
        self.assertEqual(vi.say_minutes(10), 'mười phút')
        self.assertEqual(vi.say_minutes(15), 'mười lăm phút')
        self.assertEqual(vi.say_minutes(21), 'hai mươi mốt phút')
        self.assertEqual(vi.say_minutes(30), 'nửa tiếng')
        self.assertEqual(vi.say_minutes(90), 'một tiếng rưỡi')
        self.assertEqual(vi.say_minutes(130), 'hai tiếng mười phút')


class ReplyTest(unittest.TestCase):
    def test_replies(self):
        on = vi.Command('on', 'đèn bếp', 1.0, verb='bật')
        self.assertEqual(vi.reply(on, True, 'Turned on Kitchen lights.', []), 'Đã bật đèn bếp.')
        door = vi.Command('on', 'cửa ga-ra', 1.0, verb='mở')
        self.assertEqual(vi.reply(door, True, 'Turned on Garage door.', []), 'Đã mở cửa ga-ra.')
        timed = vi.Command('on', 'đèn bếp', 1.0, 10, 'bật')
        self.assertEqual(vi.reply(timed, True, '', []), 'Đã bật đèn bếp, mười phút nữa sẽ tắt.')
        self.assertEqual(vi.reply(vi.Command('ask', 'đèn bếp', 1.0), False, '', []), 'Bật hay tắt đèn bếp?')
        self.assertEqual(vi.reply(None, False, '', []), vi.NOT_UNDERSTOOD)
        self.assertEqual(vi.reply(on, True, "Kitchen lights is protected.", []), 'đèn bếp được bảo vệ, tôi không thay đổi.')
        self.assertEqual(vi.reply(on, True, "I couldn't reach Kitchen lights.", ['Kitchen lights']), 'Không kết nối được với đèn bếp.')


# ── Through the pipeline, with fakes for the models and HomeHub ──

class FakeHomeHub:
    def __init__(self, handled=True, response='Done.', fail=False):
        self.names, self.scenes, self.groups = NAMES, SCENES, GROUPS
        self.sent: list[str] = []
        self.handled, self.response, self.fail = handled, response, fail

    def command(self, text, retry=False):
        if self.fail:
            raise HomeHubError('down')
        self.sent.append(text)
        return CommandResult(self.handled, self.response)


class FakeVietnamese:
    def __init__(self, text):
        self.text = text

    def transcribe(self, audio):
        return self.text


class FakeCantonese:
    def __init__(self, lang='yue', text=''):
        self.lang, self.text, self.calls = lang, text, 0

    def hear(self, audio):
        self.calls += 1
        return self.lang, self.text

    def transcribe(self, audio):
        return self.text


class FakeWhisper:
    def __init__(self, text=''):
        self.text, self.calls = text, 0

    def transcribe(self, audio, names):
        self.calls += 1
        return self.text


class PipelineTest(unittest.TestCase):
    def test_vietnamese_goes_to_homehub_and_is_answered_in_vietnamese(self):
        hub, whisper = FakeHomeHub(), FakeWhisper()
        # SenseVoice calls most Vietnamese Cantonese: the Vietnamese model decides first.
        yue = FakeCantonese('yue', '得靓凤雾。')
        a = answer(b'\0' * 32000, True, whisper, hub, yue, vi_ears=FakeVietnamese('TẮT ĐÈN PHÒNG NGỦ'))
        self.assertEqual(hub.sent, ['turn off đèn phòng ngủ'])
        self.assertEqual((a.lang, a.reply, a.handled), ('vi', 'Đã tắt đèn phòng ngủ.', True))
        self.assertEqual((whisper.calls, yue.calls), (0, 0))

    def test_english_still_goes_to_whisper(self):
        hub, whisper = FakeHomeHub(), FakeWhisper('Turn on the kitchen lights.')
        a = answer(b'\0' * 32000, True, whisper, hub, None, vi_ears=FakeVietnamese('TRAUN TESION LINK'))
        self.assertEqual(hub.sent, ['Turn on the kitchen lights.'])
        self.assertEqual(a.lang, 'en')

    def test_cantonese_still_goes_to_cantonese(self):
        hub = FakeHomeHub()
        a = answer(b'\0' * 32000, True, FakeWhisper(), hub, FakeCantonese('yue', '开厨房灯。'),
                   vi_ears=FakeVietnamese('CHỈ PHÓNG'))
        self.assertEqual(a.lang, 'yue')
        self.assertEqual(hub.sent, ['turn on 廚房燈'])

    def test_unsure_verb_asks_then_bat_alone_answers(self):
        hub = FakeHomeHub()
        a = answer(b'\0' * 32000, True, FakeWhisper(), hub, None, vi_ears=FakeVietnamese('BẮT ĐÈN BẾP'))
        self.assertEqual((a.reply, a.asked, hub.sent), ('Bật hay tắt đèn bếp?', 'đèn bếp', []))
        b = answer(b'\0' * 32000, True, FakeWhisper(), hub, None, asked='đèn bếp', vi_ears=FakeVietnamese('TẮT'))
        self.assertEqual((b.reply, hub.sent), ('Đã tắt đèn bếp.', ['turn off đèn bếp']))

    def test_a_lost_name_asks_which_light_then_hears_it(self):
        # From the Pi, 2026-11-12: "Bật đèn nhà bếp" heard as "BẬT ĐÈN".
        hub = FakeHomeHub()
        a = answer(b'\0' * 32000, True, FakeWhisper(), hub, None, vi_ears=FakeVietnamese('BẬT ĐÈN'))
        self.assertEqual((a.lang, a.reply, hub.sent), ('vi', 'Bật đèn nào?', []))
        self.assertTrue(a.asked.startswith(vi.WHICH_PREFIX))
        b = answer(b'\0' * 32000, True, FakeWhisper(), hub, None, asked=a.asked, vi_ears=FakeVietnamese('NHÀ BẾP'))
        self.assertEqual((b.reply, hub.sent), ('Đã bật đèn nhà bếp.', ['turn on đèn nhà bếp']))
        # Or the whole command again.
        c = answer(b'\0' * 32000, True, FakeWhisper(), hub, None, asked=a.asked, vi_ears=FakeVietnamese('TẮT ĐÈN BẾP'))
        self.assertEqual(c.reply, 'Đã tắt đèn bếp.')

    def test_which_light_with_how_long(self):
        # From the Pi, 2026-11-13: "mở đèn nhà bếp ba mươi phút", the name lost, then said with the time again.
        hub = FakeHomeHub()
        a = answer(b'\0' * 32000, True, FakeWhisper(), hub, None, vi_ears=FakeVietnamese('MỞ ĐÈN BA MƯƠI PHÚT'))
        self.assertEqual(a.reply, 'Mở đèn nào?')
        b = answer(b'\0' * 32000, True, FakeWhisper(), hub, None, asked=a.asked, vi_ears=FakeVietnamese('NHÀ BẾP BA MƯƠI PHÚT'))
        self.assertEqual(hub.sent, ['turn on đèn nhà bếp for 30 minutes'])
        self.assertEqual(b.reply, 'Đã mở đèn nhà bếp, nửa tiếng nữa sẽ tắt.')
        # The name alone keeps the time said first.
        hub.sent.clear()
        c = answer(b'\0' * 32000, True, FakeWhisper(), hub, None, asked=a.asked, vi_ears=FakeVietnamese('NHÀ BẾP'))
        self.assertEqual(hub.sent, ['turn on đèn nhà bếp for 30 minutes'])

    def test_light_heard_as_lien_asks_which(self):
        # From the tablet, 2026-11-13: "mở đèn văn phòng mười phút" heard as "MỞ LIỀN MƯỜI PHÚT".
        hub = FakeHomeHub()
        a = answer(b'\0' * 32000, True, FakeWhisper(), hub, None, vi_ears=FakeVietnamese('MỞ LIỀN MƯỜI PHÚT'))
        self.assertEqual((a.reply, hub.sent), ('Mở đèn nào?', []))
        b = answer(b'\0' * 32000, True, FakeWhisper(), hub, None, asked=a.asked, vi_ears=FakeVietnamese('VĂN PHÒNG'))
        self.assertEqual(hub.sent, ['turn on đèn văn phòng for 10 minutes'])
        # Only words that sound like "đèn": "mở tiền" is not a light.
        self.assertIsNone(vi.parse('MỞ TIỀN', NAMES, SCENES, GROUPS))

    def test_woken_in_vietnamese_is_answered_in_vietnamese(self):
        # From the tablet, 2026-11-13: woken with "Xin chào", the words unclear, and answered in Cantonese.
        hub = FakeHomeHub(handled=False)
        yue = FakeCantonese('yue', '梅福。')
        a = answer(b'\0' * 32000, True, FakeWhisper(), hub, yue, vi_ears=FakeVietnamese('MỞ ĐÈN DÂN PHỤC'), prefer='vi')
        self.assertEqual((a.lang, a.reply), ('vi', vi.NOT_UNDERSTOOD))
        b = answer(b'\0' * 32000, True, FakeWhisper(), hub, yue, vi_ears=FakeVietnamese('DÂN PHỤC'), prefer='vi')
        self.assertEqual(b.lang, 'vi')
        # Without the Vietnamese wake word, it's Cantonese's to answer, as before.
        c = answer(b'\0' * 32000, True, FakeWhisper(), hub, yue, vi_ears=FakeVietnamese('DÂN PHỤC'))
        self.assertEqual(c.lang, 'yue')
        # English after "Xin chào" still works, when SenseVoice is sure it's English.
        hub = FakeHomeHub()
        d = answer(b'\0' * 32000, True, FakeWhisper(), hub, FakeCantonese('en', 'Turn on the kitchen lights.'),
                   vi_ears=FakeVietnamese('TÂN ƠN ĐỜ KÍT CHEN'), prefer='vi')
        self.assertEqual((d.lang, hub.sent), ('en', ['Turn on the kitchen lights.']))
        # Nothing heard at all is not answered in Vietnamese for the sake of it.
        e = answer(b'\0' * 32000, True, FakeWhisper(''), FakeHomeHub(), None, vi_ears=FakeVietnamese(''), prefer='vi')
        self.assertEqual(e.lang, 'en')

    def test_english_after_xin_chao_is_still_english(self):
        # From the tablet, 2026-11-13: "Xin chào" is said before English too, and the Vietnamese model
        # writes English as letters with no Vietnamese accents. Whisper still gets its turn.
        class Hub(FakeHomeHub):
            def command(self, text, retry=False):
                self.sent.append(text)
                return CommandResult(text.startswith('Turn on kitchen'), 'Done.')
        hub = Hub()
        whisper = FakeWhisper('Turn on kitchen lights for 15 minutes.')
        a = answer(b'\0' * 32000, True, whisper, hub, FakeCantonese('en', 'Croun cution like fodyfi menes.'),
                   vi_ears=FakeVietnamese('CROUN CUTION LIKE FODYFI MENES'), prefer='vi')
        self.assertEqual((a.lang, whisper.calls), ('en', 1))
        self.assertIn('Turn on kitchen lights for 15 minutes.', hub.sent)

    def test_answer_to_a_vietnamese_question_stays_vietnamese(self):
        # "Bật hay tắt đèn nhà bếp?", then "bật" taken for Cantonese "千就".
        hub = FakeHomeHub()
        yue = FakeCantonese('yue', '千就。')
        a = answer(b'\0' * 32000, True, FakeWhisper(), hub, yue, asked='đèn nhà bếp', vi_ears=FakeVietnamese('BẬC'), prefer='vi')
        self.assertEqual((a.reply, hub.sent), ('Đã bật đèn nhà bếp.', ['turn on đèn nhà bếp']))
        # A Cantonese question's answer isn't read as Vietnamese.
        hub = FakeHomeHub()
        b = answer(b'\0' * 32000, True, FakeWhisper(), hub, FakeCantonese('yue', '開。'), asked='廚房燈',
                   vi_ears=FakeVietnamese('KHAI'), prefer='yue')
        self.assertEqual((b.lang, hub.sent), ('yue', ['turn on 廚房燈']))

    def test_full_command_with_how_long(self):
        self.assertEqual(vi.parse('MỞ ĐÈN VÀ PEP BA MƯƠI PHÚT', NAMES, SCENES, GROUPS).homehub_text, 'turn on đèn nhà bếp for 30 minutes')

    def test_which_door(self):
        hub = FakeHomeHub()
        a = answer(b'\0' * 32000, True, FakeWhisper(), hub, None, vi_ears=FakeVietnamese('ĐÓNG CỬA'))
        self.assertEqual(a.reply, 'Đóng cửa nào?')
        b = answer(b'\0' * 32000, True, FakeWhisper(), hub, None, asked=a.asked, vi_ears=FakeVietnamese('NHÀ XE'))
        self.assertEqual((b.reply, hub.sent), ('Đã đóng cửa nhà xe.', ['turn off cửa nhà xe']))

    def test_an_unclear_answer_to_which_is_not_guessed(self):
        hub = FakeHomeHub(handled=False)
        a = answer(b'\0' * 32000, True, FakeWhisper(), hub, None, vi_ears=FakeVietnamese('BẬT ĐÈN'))
        b = answer(b'\0' * 32000, True, FakeWhisper('what'), hub, None, asked=a.asked, vi_ears=FakeVietnamese('PHÒNG'))
        self.assertNotIn('turn on', ' '.join(hub.sent))
        self.assertIsNone(b.asked)

    def test_unknown_name_is_listed_as_missed(self):
        hub = FakeHomeHub(handled=False)
        a = answer(b'\0' * 32000, True, FakeWhisper(), hub, None, vi_ears=FakeVietnamese('BẬT ĐÈN SÂN THƯỢNG'))
        self.assertEqual((a.lang, a.reply, hub.sent), ('vi', vi.NOT_UNDERSTOOD, ['bật đèn sân thượng']))

    def test_homehub_down(self):
        a = answer(b'\0' * 32000, True, FakeWhisper(), FakeHomeHub(fail=True), None, vi_ears=FakeVietnamese('BẬT ĐÈN BẾP'))
        self.assertEqual((a.lang, a.reply), ('vi', vi.NO_HOMEHUB))


class ConfigTest(unittest.TestCase):
    def test_vietnamese_language(self):
        env = {'HOMEHUB_URL': 'http://h:3000', 'HOMEHUB_INTERNAL_KEY': 'k', 'LANGUAGES': 'en vi', 'MODELS_DIR': '/m'}
        c = cfg.load(env)
        self.assertTrue(c.vietnamese)
        self.assertFalse(c.cantonese)
        self.assertEqual(str(c.vietnamese_dir), '/m/vietnamese')


if __name__ == '__main__':
    unittest.main()
