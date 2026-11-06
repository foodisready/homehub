"""Cantonese commands: read by sound, passed to HomeHub, answered in Cantonese.

The texts below are what SenseVoice really wrote for the household's recordings,
mistakes included. No speech models are needed."""
from __future__ import annotations

import unittest

from homehub_voice import cantonese as yue
from homehub_voice import config as cfg
from homehub_voice.homehub import CommandResult, HomeHubError
from homehub_voice.pipeline import answer

# The home's names, as HomeHub lists them: English aliases plus Cantonese nicknames.
NAMES = ['Kitchen lights', 'My office lamp', '廚房燈', '寫字樓燈', '書房燈', '文房燈', '辦公室燈', '走廊燈', '卓希房燈', '車房門', '晚安']


def read(text):
    c = yue.parse(text, NAMES, NAMES)
    return (c.action, c.name) if c else None


class ReadingTest(unittest.TestCase):
    def test_exact(self):
        self.assertEqual(read('開廚房燈'), ('on', '廚房燈'))
        self.assertEqual(read('熄寫字樓燈。'), ('off', '寫字樓燈'))
        self.assertEqual(read('鎖車房門'), ('off', '車房門'))
        self.assertEqual(read('唔該開走廊燈啦'), ('on', '走廊燈'))

    def test_simplified_characters(self):
        self.assertEqual(read('关厨房灯。'), ('off', '廚房燈'))

    def test_sound_alike_characters(self):
        self.assertEqual(read('开民房灯。'), ('on', '文房燈'))        # 民 sounds like 文
        self.assertEqual(read('识写住路灯。'), ('off', '寫字樓燈'))    # 识 sounds like 熄, 写住路 like 寫字樓
        self.assertEqual(read('着私房灯。'), ('on', '書房燈'))
        self.assertEqual(read('即厨房灯。'), ('off', '廚房燈'))        # 即 "zik" for 熄 "sik"

    def test_a_name_that_starts_like_a_verb(self):
        # 卓 sounds like 着 ("on"), but only the first word is the verb.
        self.assertEqual(read('关着 k房灯。'), ('off', '卓希房燈'))
        self.assertEqual(read('着卓机房等。'), ('on', '卓希房燈'))
        self.assertEqual(read('熄卓希房燈'), ('off', '卓希房燈'))

    def test_a_scene_by_its_name(self):
        self.assertEqual(read('晚安'), ('scene', '晚安'))

    def test_unsure_is_none_never_a_guess(self):
        self.assertIsNone(read('開主人房燈'), 'no such light: not the nearest other one')
        self.assertIsNone(read('換卷黄灯。'))
        # HomeHub lists device and scene names together, so a name alone is tried as a scene;
        # HomeHub finds no scene by that name and switches nothing.
        self.assertEqual(read('廚房燈'), ('scene', '廚房燈'))
        self.assertIsNone(read('開'))
        self.assertIsNone(yue.parse('開廚房燈', ['Kitchen lights']), 'no Cantonese names: nothing to match')

    def test_what_homehub_is_sent(self):
        self.assertEqual(yue.parse('開廚房燈', NAMES).homehub_text, 'turn on 廚房燈')
        self.assertEqual(yue.parse('晚安', [], ['晚安']).homehub_text, 'run 晚安')


class ReplyTest(unittest.TestCase):
    on = yue.Command('on', '廚房燈', 1.0)

    def test_done(self):
        self.assertEqual(yue.reply(self.on, True, 'Turned on Kitchen lights.', []), '開咗廚房燈。')
        self.assertEqual(yue.reply(yue.Command('off', '走廊燈', 1), True, 'x', []), '熄咗走廊燈。')
        self.assertEqual(yue.reply(yue.Command('scene', '晚安', 1), True, 'Ran 晚安.', []), '搞掂，晚安。')

    def test_trouble(self):
        self.assertEqual(yue.reply(self.on, True, "I couldn't reach Kitchen lights.", ['Kitchen lights']), '連唔到廚房燈。')
        self.assertIn('受保護', yue.reply(yue.Command('off', '車房門', 1), True, 'Garage Left is protected, so Chat won\'t switch it.', []))
        self.assertIn('安全', yue.reply(yue.Command('off', '鏡頭', 1), True, "For safety, I can't pause cameras that way.", []))
        self.assertEqual(yue.reply(None, False, '', []), yue.NOT_UNDERSTOOD)


class FakeEars:
    def __init__(self, lang, text):
        self.lang, self.text = lang, text

    def language(self, audio):
        return self.lang

    def transcribe(self, audio):
        return self.text


class FakeListener:
    def transcribe(self, audio, names):
        return 'Turn on the kitchen lights.'


class FakeHomeHub:
    names = NAMES

    def __init__(self, response='Turned on Kitchen lights.', handled=True, fail=False):
        self.response, self.handled, self.fail = response, handled, fail
        self.sent: list[str] = []

    def command(self, text):
        if self.fail:
            raise HomeHubError('down')
        self.sent.append(text)
        return CommandResult(self.handled, self.response)


class PipelineTest(unittest.TestCase):
    def test_cantonese_goes_to_homehub_as_a_command(self):
        h = FakeHomeHub()
        a = answer(b'x', True, FakeListener(), h, FakeEars('yue', '开厨房灯。'))
        self.assertEqual(h.sent, ['turn on 廚房燈'])
        self.assertEqual((a.reply, a.lang, a.handled), ('開咗廚房燈。', 'yue', True))
        self.assertIn('开厨房灯', a.heard)

    def test_chinese_label_counts_as_cantonese(self):
        h = FakeHomeHub()
        self.assertEqual(answer(b'x', True, FakeListener(), h, FakeEars('zh', '着厨房灯。')).lang, 'yue')

    def test_english_still_goes_to_whisper(self):
        h = FakeHomeHub()
        a = answer(b'x', True, FakeListener(), h, FakeEars('en', 'Turn on the kitchen lights.'))
        self.assertEqual(h.sent, ['Turn on the kitchen lights.'])
        self.assertEqual(a.lang, 'en')

    def test_unread_cantonese_is_still_logged_by_homehub(self):
        h = FakeHomeHub(response="Sorry, I didn't understand that.", handled=False)
        a = answer(b'x', True, FakeListener(), h, FakeEars('yue', '開主人房燈'))
        self.assertEqual(h.sent, ['開主人房燈'])
        self.assertEqual((a.reply, a.handled), (yue.NOT_UNDERSTOOD, False))

    def test_unread_cantonese_is_sent_in_traditional_characters(self):
        h = FakeHomeHub(response="Sorry, I didn't understand that.", handled=False)
        answer(b'x', True, FakeListener(), h, FakeEars('yue', '开主人房灯。'))
        self.assertEqual(h.sent, ['開主人房燈'])

    def test_homehub_down(self):
        a = answer(b'x', True, FakeListener(), FakeHomeHub(fail=True), FakeEars('yue', '開廚房燈'))
        self.assertEqual((a.reply, a.lang), (yue.NO_HOMEHUB, 'yue'))


class ConfigTest(unittest.TestCase):
    base = {'HOMEHUB_URL': 'http://h:3000', 'HOMEHUB_INTERNAL_KEY': 'k'}

    def test_off_by_default(self):
        self.assertFalse(cfg.load(self.base).cantonese)

    def test_on(self):
        c = cfg.load({**self.base, 'LANGUAGES': 'en, yue'})
        self.assertTrue(c.cantonese)
        self.assertEqual(c.sensevoice_dir.name, 'sensevoice')

    def test_unknown_language(self):
        with self.assertRaisesRegex(cfg.ConfigError, 'vi'):
            cfg.load({**self.base, 'LANGUAGES': 'en vi'})


if __name__ == '__main__':
    unittest.main()
