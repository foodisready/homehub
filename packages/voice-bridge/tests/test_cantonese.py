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
SCENES = ['晚安']


def read(text):
    c = yue.parse(text, NAMES, SCENES)
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
        # A light's name alone isn't a scene: it's asked about, and nothing is switched.
        self.assertEqual(read('廚房燈'), ('ask', '廚房燈'))
        self.assertEqual(read('卓希房燈啦'), ('ask', '卓希房燈'))
        self.assertIsNone(read('房房燈'), 'too unsure to ask about')
        # 卓希房燈 alone, as SenseVoice wrote it: 卓 sounds like 着 ("on"), but what follows isn't a name.
        self.assertEqual(read('着起房燈'), ('ask', '卓希房燈'))
        self.assertEqual(read('卓 k房灯。'), ('ask', '卓希房燈'))
        self.assertIsNone(read('熄着氣燈'), 'a syllable missing: too far to guess')
        self.assertIsNone(read('開'))
        self.assertIsNone(yue.parse('開廚房燈', ['Kitchen lights']), 'no Cantonese names: nothing to match')

    def test_what_homehub_is_sent(self):
        self.assertEqual(yue.parse('開廚房燈', NAMES).homehub_text, 'turn on 廚房燈')
        self.assertEqual(yue.parse('晚安', [], ['晚安']).homehub_text, 'run 晚安')


class DurationTest(unittest.TestCase):
    """開文房燈十分鐘: on, then off again after a while, as "turn on ... for 10 minutes"."""

    def timed(self, text):
        c = yue.parse(text, NAMES, SCENES)
        return (c.action, c.name, c.minutes) if c else None

    def test_minutes(self):
        self.assertEqual(self.timed('開文房燈十分鐘'), ('on', '文房燈', 10))
        self.assertEqual(self.timed('开文房灯十分钟。'), ('on', '文房燈', 10), 'simplified characters')
        self.assertEqual(self.timed('開文房燈十五分鐘啦'), ('on', '文房燈', 15))
        self.assertEqual(self.timed('開文房燈二十五分鐘'), ('on', '文房燈', 25))
        self.assertEqual(self.timed('開文房燈廿分鐘'), ('on', '文房燈', 20), '廿 is twenty')
        self.assertEqual(self.timed('開文房燈10分鐘'), ('on', '文房燈', 10), 'digits')
        self.assertEqual(self.timed('开民房灯 10 分中'), None, 'a space inside the duration is too loose to trust')
        self.assertEqual(self.timed('开民房灯10分中'), ('on', '文房燈', 10), '分中 sounds like 分鐘, 民 like 文')
        self.assertEqual(self.timed('開文房燈三個字'), ('on', '文房燈', 15), 'a 字 is five minutes')

    def test_hours(self):
        self.assertEqual(self.timed('開文房燈半個鐘'), ('on', '文房燈', 30))
        self.assertEqual(self.timed('開文房燈一個鐘'), ('on', '文房燈', 60))
        self.assertEqual(self.timed('開文房燈個半鐘'), ('on', '文房燈', 90))
        self.assertEqual(self.timed('開文房燈一個半鐘'), ('on', '文房燈', 90))
        self.assertEqual(self.timed('開文房燈兩個鐘頭'), ('on', '文房燈', 120))
        self.assertEqual(self.timed('开文房灯两个小时'), ('on', '文房燈', 120))

    def test_word_orders(self):
        self.assertEqual(self.timed('開文房燈，十分鐘後熄'), ('on', '文房燈', 10))
        self.assertEqual(self.timed('開文房燈十分鐘之後關燈'), ('on', '文房燈', 10))
        self.assertEqual(self.timed('開文房燈開十分鐘'), ('on', '文房燈', 10))
        self.assertEqual(self.timed('開十分鐘文房燈'), ('on', '文房燈', 10))
        self.assertEqual(self.timed('唔該開走廊燈半個鐘啦'), ('on', '走廊燈', 30))

    def test_not_a_duration(self):
        self.assertEqual(self.timed('開寫字樓燈'), ('on', '寫字樓燈', None), '字 in a name is not five minutes')
        self.assertEqual(self.timed('開文房燈'), ('on', '文房燈', None))
        self.assertIsNone(self.timed('熄文房燈十分鐘'), 'off for a while is not something HomeHub does: no guess')

    def test_what_homehub_is_sent(self):
        self.assertEqual(yue.parse('開文房燈十分鐘', NAMES).homehub_text, 'turn on 文房燈 for 10 minutes')
        self.assertEqual(yue.parse('開文房燈個半鐘', NAMES).homehub_text, 'turn on 文房燈 for 90 minutes')

    def test_the_reply_says_when_it_goes_off(self):
        on = lambda m: yue.Command('on', '文房燈', 1.0, m)
        self.assertEqual(yue.reply(on(10), True, 'x', []), '開咗文房燈，十分鐘後熄。')
        self.assertEqual(yue.reply(on(2), True, 'x', []), '開咗文房燈，兩分鐘後熄。')
        self.assertEqual(yue.reply(on(25), True, 'x', []), '開咗文房燈，二十五分鐘後熄。')
        self.assertEqual(yue.reply(on(30), True, 'x', []), '開咗文房燈，半個鐘後熄。')
        self.assertEqual(yue.reply(on(60), True, 'x', []), '開咗文房燈，一個鐘後熄。')
        self.assertEqual(yue.reply(on(90), True, 'x', []), '開咗文房燈，一個半鐘後熄。')
        self.assertEqual(yue.reply(on(120), True, 'x', []), '開咗文房燈，兩個鐘後熄。')
        self.assertEqual(yue.reply(on(75), True, 'x', []), '開咗文房燈，一個鐘十五分鐘後熄。')


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


class VolumeTest(unittest.TestCase):
    def test_a_quiet_reply_is_raised_to_full_volume(self):
        import numpy as np
        from homehub_voice.speech import PEAK, louder
        out = louder(np.array([0.1, -0.35, 0.2], dtype=np.float32))
        self.assertAlmostEqual(float(np.max(np.abs(out))), PEAK, places=5)

    def test_silence_stays_silent(self):
        import numpy as np
        from homehub_voice.speech import louder
        self.assertEqual(float(np.max(np.abs(louder(np.zeros(5, dtype=np.float32))))), 0.0)
        self.assertLess(float(np.max(np.abs(louder(np.array([0.001], dtype=np.float32))))), 0.02)
        self.assertEqual(louder(np.array([], dtype=np.float32)).size, 0)


class FakeEars:
    def __init__(self, lang, text):
        self.lang, self.text = lang, text

    def hear(self, audio):
        return self.lang, self.text

    def transcribe(self, audio):
        return self.text


class FakeListener:
    def __init__(self):
        self.ran = 0

    def transcribe(self, audio, names):
        self.ran += 1
        return 'Turn on the kitchen lights.'


class FakeHomeHub:
    names = NAMES
    scenes = SCENES

    def __init__(self, response='Turned on Kitchen lights.', handled=True, fail=False):
        self.response, self.handled, self.fail = response, handled, fail
        self.sent: list[str] = []
        self.retries: list[bool] = []

    def command(self, text, retry=False):
        if self.fail:
            raise HomeHubError('down')
        self.sent.append(text)
        self.retries.append(retry)
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

    def test_english_heard_by_sensevoice_skips_whisper(self):
        h, l = FakeHomeHub(), FakeListener()
        a = answer(b'x', True, l, h, FakeEars('en', 'Turn on the kitchen light.'))
        self.assertEqual(h.sent, ['Turn on the kitchen light.'])
        self.assertEqual((a.lang, a.handled, l.ran), ('en', True, 0))

    def test_english_not_understood_is_heard_again_by_whisper(self):
        class Learns(FakeHomeHub):
            def command(self, text, retry=False):
                self.handled = text == 'Turn on the kitchen lights.'
                return super().command(text, retry)
        h, l = Learns(), FakeListener()
        a = answer(b'x', True, l, h, FakeEars('en', 'Turn on the zebra.'))
        self.assertEqual(h.sent, ['Turn on the zebra.', 'Turn on the kitchen lights.'])
        self.assertEqual(h.retries, [True, False], 'only the last try is recorded as a miss')
        self.assertEqual((a.heard, a.handled, l.ran), ('Turn on the kitchen lights.', True, 1))

    def test_english_missed_twice_is_recorded_once(self):
        h = FakeHomeHub(response="Sorry, I didn't understand that.", handled=False)
        a = answer(b'x', True, FakeListener(), h, FakeEars('en', 'Turn on the zebra.'))
        self.assertEqual(h.retries, [True, False])
        self.assertFalse(a.handled)

    def test_a_nearly_right_name_is_corrected_before_asking_whisper(self):
        class Knows(FakeHomeHub):
            names = ['My office lamp', 'Kitchen lights', 'Office', '書房燈']
            def command(self, text, retry=False):
                self.handled = text == 'Turn on My office lamp'
                return super().command(text, retry)
        h, l = Knows(), FakeListener()
        a = answer(b'x', True, l, h, FakeEars('en', 'Turn on my office la.'))
        self.assertEqual(h.sent, ['Turn on my office la.', 'Turn on My office lamp'])
        self.assertEqual((a.handled, l.ran), (True, 0))

    def test_closest_name(self):
        from homehub_voice.pipeline import closest_name
        names = ['My office lamp', 'Kitchen lights', 'Office', "Brenden's left bedside lamp", "Brenden's right bedside lamp", '書房燈']
        self.assertEqual(closest_name('Turn on my office la.', names), 'Turn on My office lamp')
        self.assertEqual(closest_name('switch off, the kitchen light', names), 'switch off Kitchen lights')
        # Too close to call between two names, or nothing like any: left as heard.
        self.assertEqual(closest_name("Turn on Brenden's bedside lamp.", names), "Turn on Brenden's bedside lamp.")
        self.assertEqual(closest_name('Turn on the garage.', names), 'Turn on the garage.')
        self.assertEqual(closest_name('What time is it?', names), 'What time is it?')

    def test_homehub_down_does_not_wait_for_whisper(self):
        l = FakeListener()
        a = answer(b'x', True, l, FakeHomeHub(fail=True), FakeEars('en', 'Turn on the kitchen lights.'))
        self.assertEqual((a.reply, l.ran), ('I can\'t reach HomeHub right now.', 0))

    def test_unread_cantonese_is_still_logged_by_homehub(self):
        h = FakeHomeHub(response="Sorry, I didn't understand that.", handled=False)
        a = answer(b'x', True, FakeListener(), h, FakeEars('yue', '開主人房燈'))
        self.assertEqual(h.sent, ['開主人房燈'])
        self.assertEqual((a.reply, a.handled), (yue.NOT_UNDERSTOOD, False))

    def test_unread_cantonese_is_sent_in_traditional_characters(self):
        h = FakeHomeHub(response="Sorry, I didn't understand that.", handled=False)
        answer(b'x', True, FakeListener(), h, FakeEars('yue', '开主人房灯。'))
        self.assertEqual(h.sent, ['開主人房燈'])

    def test_a_light_named_alone_is_asked_about_not_run_as_a_scene(self):
        # What the logs showed as "run 廚房燈": 開 was cut off after the wake word.
        h = FakeHomeHub(response="Sorry, I didn't understand that.", handled=False)
        a = answer(b'x', True, FakeListener(), h, FakeEars('yue', '廚房燈。'))
        self.assertEqual(h.sent, ['廚房燈'])   # logged as heard, and nothing switched
        self.assertEqual((a.reply, a.handled), ('你想開定熄廚房燈？', False))

    def test_the_question_remembers_what_it_asked(self):
        h = FakeHomeHub(response="Sorry, I didn't understand that.", handled=False)
        self.assertEqual(answer(b'x', True, FakeListener(), h, FakeEars('yue', '廚房燈')).asked, '廚房燈')

    def test_kai_alone_answers_the_question(self):
        for said, sent, reply in [('開', 'turn on 廚房燈', '開咗廚房燈。'), ('熄啦。', 'turn off 廚房燈', '熄咗廚房燈。'),
                                  ('唔該開', 'turn on 廚房燈', '開咗廚房燈。')]:
            h = FakeHomeHub()
            a = answer(b'x', True, FakeListener(), h, FakeEars('yue', said), asked='廚房燈')
            self.assertEqual((h.sent, a.reply, a.handled, a.asked), ([sent], reply, True, None), said)

    def test_a_whole_command_after_the_question_is_its_own(self):
        h = FakeHomeHub()
        answer(b'x', True, FakeListener(), h, FakeEars('yue', '開走廊燈'), asked='廚房燈')
        self.assertEqual(h.sent, ['turn on 走廊燈'])

    def test_kai_alone_without_a_question_is_not_understood(self):
        h = FakeHomeHub(response="Sorry, I didn't understand that.", handled=False)
        a = answer(b'x', True, FakeListener(), h, FakeEars('yue', '開'))
        self.assertEqual((a.reply, a.handled), (yue.NOT_UNDERSTOOD, False))

    def test_on_in_english_answers_the_question(self):
        class Says:
            def __init__(self, text): self.text = text
            def transcribe(self, audio, names): return self.text
        for said, sent in [('On.', 'turn on 廚房燈'), ('Turn it off, please.', 'turn off 廚房燈'), ('off', 'turn off 廚房燈')]:
            h = FakeHomeHub()
            answer(b'x', True, Says(said), h, FakeEars('en', ''), asked='廚房燈')
            self.assertEqual(h.sent, [sent], said)
        h = FakeHomeHub()
        answer(b'x', True, Says('Turn on the hallway lamp.'), h, FakeEars('en', ''), asked='廚房燈')
        self.assertEqual(h.sent, ['Turn on the hallway lamp.'])
        h = FakeHomeHub()
        answer(b'x', True, Says('On.'), h, FakeEars('en', ''))
        self.assertEqual(h.sent, ['On.'], 'nothing was asked')

    def test_a_scene_named_alone_still_runs(self):
        h = FakeHomeHub(response='Done, Good night.')
        a = answer(b'x', True, FakeListener(), h, FakeEars('yue', '晚安'))
        self.assertEqual(h.sent, ['run 晚安'])
        self.assertTrue(a.handled)

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
