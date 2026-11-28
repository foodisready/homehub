"""Talk that wasn't meant for HomeHub, told from a command it misheard: from the household's real misses."""
from __future__ import annotations

import unittest

from homehub_voice.chatter import english_talk, looks_like_chatter
from homehub_voice.speakers import own_words

NAMES = ['Kitchen lights', 'Woman statue', 'Woman bedside lamp', 'hallway lamp', 'đèn bếp', 'đèn của bà', 'đèn bàn brenden',
         'đèn phòng làm việc', '卓希房燈', '着氣燈', '廚房燈', '亞娘床頭燈', '走廊燈', '書房燈']


class ChatterTest(unittest.TestCase):
    def test_talk_from_the_tv_or_the_room_stays_quiet(self):
        for text in ["I don't want to pay for your drink.", 'Good night, and goodbye.', 'Well, how does that come up?',
                     'Did I break something, man?', 'Let\'s take a picture and send it to wind. I did. Alright.',
                     '原兩你啲其實', '其咧有咁講冇冇見你哋', 'croun cution like fodyfi menes']:
            with self.subTest(text=text):
                self.assertTrue(looks_like_chatter(text, NAMES))

    def test_a_misheard_command_is_still_answered(self):
        for text in ['Sick.', 'Peace.',                                  # short: 熄 cut off, maybe
                     'Smart Kitchen lights.', 'I need to remove a woman.',  # a name in it
                     'Turn off, Turn on, Woman bedside lamp.',              # an on or off word
                     'đèn tép hai mươi phút', 'đèg bàn bàn bàn.', 'đền bà sự bình an từ chối',   # a lamp, in Vietnamese
                     'mở liền mười phút', 'tắt tiền văn phòng',
                     '熄啊亮等', '的下量牀頭等', '開寫住腦燈', '客廳牀房燈']:   # a verb, a name's sounds, or 燈
            with self.subTest(text=text):
                self.assertFalse(looks_like_chatter(text, NAMES))

    def test_on_or_off_in_tv_talk_isnt_a_command(self):
        # 2026-11-28: a Sephora ad woke 老友 and got "Sorry, I didn't understand that."
        for text in ["Should I come up? Sephora, there's fragrances on here.", 'Everything is on sale this weekend only.',
                     'Come on, we are going to be late for the show.']:
            with self.subTest(text=text):
                self.assertTrue(english_talk(text, '老友'))
        for text in ['Turn the master bedroom fan off now please.', 'kitchen on', 'office corner on please',
                     'Can you switch the garage thing off for me?', 'Put the porch one on for a bit.']:
            with self.subTest(text=text):
                self.assertFalse(english_talk(text, '老友'))

    def test_only_what_was_heard_counts_not_what_was_sent(self):
        self.assertFalse(looks_like_chatter('Turn on the kitchen → turn on Kitchen lights', NAMES))


class EnglishTalkTest(unittest.TestCase):
    # From the voice log, 2026-11-18: 老友 woke to English TV nine times in twelve minutes.
    TV = ['Thank you very much. Thank you.', 'But check because I need to actually put it. Very good.',
          'Better day outside. Healthy. Mm-hmm. Wow.', 'Good night. Thank you.', "It's pretty tight."]

    def test_english_tv_after_a_chinese_or_vietnamese_wake_word_stays_quiet(self):
        for wake in ('老友', '喂老友', 'Xin Chào', 'xin chao'):
            for text in self.TV:
                with self.subTest(wake=wake, text=text):
                    self.assertTrue(english_talk(text, wake))

    def test_on_the_second_try_after_a_miss_in_another_language(self):
        self.assertTrue(english_talk('Yeah, good night then.', '', 'yue'))
        self.assertTrue(english_talk('Yeah, good night then.', '', 'vi'))
        self.assertFalse(english_talk('Yeah, good night then.', '', 'en'))
        self.assertFalse(english_talk('Yeah, good night then.', '', None))

    def test_after_an_english_wake_word_it_is_left_to_the_usual_checks(self):
        for wake in ('Hey Woman', 'Okay Nabu', ''):
            with self.subTest(wake=wake):
                self.assertFalse(english_talk('Better day outside. Healthy. Mm-hmm. Wow.', wake))

    def test_a_command_or_a_short_miss_is_still_answered(self):
        for text in ['Turn on the kitchen lights.', 'switch the hallway lamp off please', 'the office corner lamp',
                     'Sick.', 'Hoi chu',                       # short: 熄 or 開 cut off, maybe
                     'bat den bep di', 'tat den phong khach nhe',  # Vietnamese without its accents
                     '開廚房燈', 'Bật đèn bếp', '']:
            with self.subTest(text=text):
                self.assertFalse(english_talk(text, '老友'))

    def test_on_or_off_in_tv_talk_isnt_a_command(self):
        # 2026-11-28: a Sephora ad woke 老友 and got "Sorry, I didn't understand that."
        for text in ["Should I come up? Sephora, there's fragrances on here.", 'Everything is on sale this weekend only.',
                     'Come on, we are going to be late for the show.']:
            with self.subTest(text=text):
                self.assertTrue(english_talk(text, '老友'))
        for text in ['Turn the master bedroom fan off now please.', 'kitchen on', 'office corner on please',
                     'Can you switch the garage thing off for me?', 'Put the porch one on for a bit.']:
            with self.subTest(text=text):
                self.assertFalse(english_talk(text, '老友'))

    def test_only_what_was_heard_counts_not_what_was_sent(self):
        self.assertTrue(english_talk('Thank you very much. → nothing', '老友'))


class OwnWordsTest(unittest.TestCase):
    def test_its_own_reply_heard_back(self):
        self.assertTrue(own_words('唔好意思我聽唔明', '唔好意思，我聽唔明。'))
        self.assertTrue(own_words('唔好意思我听唔明', '唔好意思，我聽唔明。'), 'simplified characters too')
        self.assertTrue(own_words("Sorry I didn't understand", "Sorry, I didn't understand that."))

    def test_a_new_command_isnt_an_echo(self):
        self.assertFalse(own_words('turn on the kitchen lights', "Sorry, I didn't understand that."))
        self.assertFalse(own_words('on', 'Office lamp is on.'), 'too short to tell')
        self.assertFalse(own_words('熄廚房燈', '唔好意思，我聽唔明。'))


if __name__ == '__main__':
    unittest.main()


class SaysANameTest(unittest.TestCase):
    """A few words heard over a noisy room with one of the home's names in them: someone speaking to the speaker."""
    NAMES = ['Little breakfast lamp', '早餐燈仔', '早餐區細燈', 'Little foyer lamp', 'Kitchen ceiling lights', 'Living room lamp',
             'đèn phòng khách', 'Porch light']

    def test_part_of_a_name_was_said(self):
        from homehub_voice.chatter import says_a_name
        # From the Pi's log, 2026-11-26: eight seconds over a noisy kitchen, so it stayed quiet.
        self.assertTrue(says_a_name('Have fun for your little lamb for 2 hours.', self.NAMES))
        self.assertTrue(says_a_name('早餐灯仔分钟。', self.NAMES))
        self.assertTrue(says_a_name('Tắt đèn phòng khách đi', self.NAMES))
        self.assertTrue(says_a_name('the porch late please', self.NAMES))

    def test_only_words_every_name_has_is_not(self):
        from homehub_voice.chatter import says_a_name
        for talk in ('Turn it on for two hours, the lamp', '開燈仔', "I don't want to pay for your drink.", 'room for the lights', ''):
            self.assertFalse(says_a_name(talk, self.NAMES), talk)
        self.assertFalse(says_a_name('Have fun for your little lamb', []), 'no names known')

    def test_long_talk_is_still_the_room(self):
        from homehub_voice.chatter import says_a_name
        tv = 'and the little one was out in the garden for hours while we sat on the porch talking about nothing'
        self.assertFalse(says_a_name(tv, self.NAMES))
        self.assertFalse(says_a_name('我哋今日去咗街市買咗好多嘢返嚟食早餐好開心', self.NAMES))
