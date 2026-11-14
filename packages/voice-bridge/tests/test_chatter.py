"""Talk that wasn't meant for HomeHub, told from a command it misheard: from the household's real misses."""
from __future__ import annotations

import unittest

from homehub_voice.chatter import looks_like_chatter
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

    def test_only_what_was_heard_counts_not_what_was_sent(self):
        self.assertFalse(looks_like_chatter('Turn on the kitchen → turn on Kitchen lights', NAMES))


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
