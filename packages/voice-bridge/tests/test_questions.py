"""The time, the date and the weather asked in Vietnamese or Cantonese, answered in the same language."""
from __future__ import annotations

import unittest

from homehub_voice import questions as q
from homehub_voice.homehub import CommandResult
from homehub_voice.pipeline import answer

CLOCK = {'asked': 'time', 'hour': 15, 'minute': 45, 'weekday': 5, 'day': 13, 'month': 11, 'year': 2026, 'timezone': 'America/Los_Angeles'}
WEATHER = {
    'unit': 'F',
    'now': {'temperature': 62, 'feelsLike': 60, 'code': 2},
    'today': {'date': '2026-11-13', 'high': 68, 'low': 51, 'rain': 10, 'code': 2},
    'tomorrow': {'date': '2026-11-14', 'high': 59, 'low': 48, 'rain': 70, 'code': 63},
}


class KindTest(unittest.TestCase):
    def test_vietnamese(self):
        for text, kind in [('Mấy giờ rồi?', 'time'), ('Bây giờ là mấy giờ', 'time'), ('Hôm nay thứ mấy?', 'date'),
                           ('Hôm nay ngày bao nhiêu', 'date'), ('Thời tiết hôm nay thế nào?', 'today'),
                           ('Bây giờ bao nhiêu độ', 'today'), ('Ngày mai thời tiết ra sao', 'tomorrow'),
                           ('Hôm nay có mưa không?', 'rain-today'), ('Ngày mai trời có mưa không', 'rain-tomorrow')]:
            self.assertEqual(q.vi_kind(text), kind, text)

    def test_vietnamese_commands_and_english_are_not_questions(self):
        for text in ['bật đèn bếp', 'tắt đèn phòng khách', 'đi mua đồ', 'what time is it', 'QUAN TRỌNG']:
            self.assertIsNone(q.vi_kind(text), text)

    def test_cantonese(self):
        for text, kind in [('而家幾點？', 'time'), ('几点了', 'time'), ('今日幾號？', 'date'), ('今日星期幾', 'date'),
                           ('今日天氣點呀？', 'today'), ('而家幾度？', 'today'), ('聽日天氣點', 'tomorrow'),
                           ('今日會唔會落雨？', 'rain-today'), ('聽日落唔落雨', 'rain-tomorrow')]:
            self.assertEqual(q.yue_kind(text), kind, text)

    def test_cantonese_commands_are_not_questions(self):
        for text in ['開廚房燈', '熄文房燈', '晚安', '']:
            self.assertIsNone(q.yue_kind(text), text)


class ReplyTest(unittest.TestCase):
    def test_vietnamese_time_and_date(self):
        self.assertEqual(q.vi_reply('time', CLOCK), 'Bây giờ là ba giờ bốn mươi lăm phút chiều.')
        self.assertEqual(q.vi_reply('time', {**CLOCK, 'hour': 9, 'minute': 0}), 'Bây giờ là chín giờ sáng.')
        self.assertEqual(q.vi_reply('date', CLOCK), 'Hôm nay là thứ sáu, ngày mười ba tháng mười một.')
        self.assertEqual(q.vi_reply('date', {**CLOCK, 'day': 5, 'weekday': 0}), 'Hôm nay là Chủ nhật, ngày mùng năm tháng mười một.')

    def test_vietnamese_weather(self):
        self.assertEqual(q.vi_reply('today', WEATHER),
                         'Bây giờ trời sáu mươi hai độ F, có mây rải rác. Hôm nay cao nhất sáu mươi tám, thấp nhất năm mươi mốt độ.')
        self.assertEqual(q.vi_reply('tomorrow', WEATHER),
                         'Ngày mai có mưa, cao nhất năm mươi chín, thấp nhất bốn mươi tám độ F. Khả năng mưa bảy mươi phần trăm.')
        self.assertEqual(q.vi_reply('rain-tomorrow', WEATHER), 'Có, ngày mai nhiều khả năng mưa, bảy mươi phần trăm.')
        self.assertEqual(q.vi_reply('rain-today', WEATHER), 'Hôm nay ít khả năng mưa, mười phần trăm.')
        self.assertIn('Cài đặt', q.vi_reply('today', {'error': 'x', 'code': 'NOT_LOCATED'}))

    def test_cantonese(self):
        self.assertEqual(q.yue_reply('time', CLOCK), '而家係下晝三點四十五分。')
        self.assertEqual(q.yue_reply('time', {**CLOCK, 'hour': 14, 'minute': 5}), '而家係下晝兩點零五分。')
        self.assertEqual(q.yue_reply('time', {**CLOCK, 'hour': 8, 'minute': 30}), '而家係朝早八點半。')
        self.assertEqual(q.yue_reply('date', CLOCK), '今日係十一月十三號，星期五。')
        self.assertEqual(q.yue_reply('today', WEATHER), '而家華氏六十二度，間中有雲。今日最高六十八度，最低五十一度。')
        self.assertEqual(q.yue_reply('tomorrow', WEATHER), '聽日有雨，最高華氏五十九度，最低四十八度。落雨機會百分之七十。')
        self.assertEqual(q.yue_reply('rain-today', {**WEATHER, 'now': {'temperature': 50, 'feelsLike': 48, 'code': 61}}), '係，而家落緊雨。')

    def test_numbers(self):
        self.assertEqual([q.yue_number(n) for n in (0, 2, 10, 12, 45, 100, 105, 112, -3)],
                         ['零', '二', '十', '十二', '四十五', '一百', '一百零五', '一百一十二', '零下三'])

    def test_an_older_homehub_without_numbers(self):
        self.assertEqual(q.vi_reply('time', None), 'Xin lỗi, tôi không hiểu.')


class PipelineTest(unittest.TestCase):
    class Hub:
        names = ['đèn bếp', '廚房燈']

        def __init__(self):
            self.sent = []

        def command(self, text, retry=False):
            self.sent.append(text)
            info = CLOCK if 'time' in text else WEATHER if 'weather' in text or 'rain' in text else None
            return CommandResult(info is not None, 'English reply', [], info)

    class Ears:
        def __init__(self, lang, text):
            self.lang, self.text = lang, text

        def hear(self, audio):
            return self.lang, self.text

        def transcribe(self, audio):
            return self.text

    class NoWhisper:
        def transcribe(self, audio, names):
            raise AssertionError('Whisper not needed')

    def test_vietnamese(self):
        hub = self.Hub()
        a = answer(b'\0' * 32000, True, self.NoWhisper(), hub, self.Ears('yue', '嗯'), vi_ears=self.Ears('', 'Mấy giờ rồi'))
        self.assertEqual((a.lang, a.reply, a.handled, hub.sent), ('vi', 'Bây giờ là ba giờ bốn mươi lăm phút chiều.', True, ['what time is it']))

    def test_cantonese(self):
        hub = self.Hub()
        a = answer(b'\0' * 32000, True, self.NoWhisper(), hub, self.Ears('yue', '聽日天氣點呀？'), vi_ears=self.Ears('', 'TING DẬT'))
        self.assertEqual((a.lang, a.handled, a.passes, hub.sent), ('yue', True, 1, ["what's the weather tomorrow"]))
        self.assertTrue(a.reply.startswith('聽日有雨'))
