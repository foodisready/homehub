# HomeHub voice bridge

Lets you control HomeHub by voice, with no cloud and no Home Assistant:

```text
speaker → wake word → bridge: Whisper (speech to text) → HomeHub → Piper (spoken reply) → speaker
```

It works with ESPHome voice speakers: [Ava](https://github.com/brownard/Ava) on an Android tablet, and should work with the Home Assistant Voice Preview Edition (not tested yet; see below). Speakers on your network are found automatically.

Commands go through HomeHub's rules only, never an AI model, so a misheard command can't switch a device the rules didn't match. Protected devices are never switched by voice.

## Turning it on

The bridge comes with HomeHub, and updates with it. Open **Settings → Voice control**, tick **Voice control**, and save. Within a minute the bridge downloads its speech models (about 200 MB for English; Cantonese adds about 350 MB) and starts listening. Until then it waits, using almost no memory. A change there, such as adding Cantonese, is applied within a minute.

It needs a computer that's fast enough: an old laptop is fine, but a Raspberry Pi 4 takes about 10 seconds to understand a command. It uses about 1 GB of memory once on. To leave it out of HomeHub entirely, set `HOMEHUB_VOICE_BRIDGE=0` in `.env`.

## On another computer

To run the bridge on a different computer from HomeHub, install it there instead. It needs Ubuntu or Debian, Python 3.11 or newer with `python3-venv` and `curl` (`sudo apt install -y python3-venv curl`), and about 1.5 GB of disk. From a copy of the HomeHub repository:

```bash
git clone https://github.com/foodisready/homehub.git
cd homehub/packages/voice-bridge
./install.sh
```

When HomeHub runs on the same computer, the installer connects to it by itself and starts the bridge. Otherwise it explains how to copy HomeHub's internal key across and point `HOMEHUB_URL` at it.

To update it, run `git pull` in the repository, then `./install.sh` again: a bridge installed this way doesn't update with HomeHub, and takes its settings from its own `config.env` rather than from Settings → Voice control.

**Moving from an installed bridge to the one that comes with HomeHub:** stop the installed one with `systemctl --user disable --now homehub-voice`, then turn voice on in Settings. If both run at once, each command is answered twice, and **Health** says so.

## Using it

Say the wake word, pause about a second, then the command: "Okay Nabu … turn on the office lamp for 20 minutes". The speaker answers when it's done.

Commands HomeHub didn't understand are listed in **Settings**, from `GET /api/nlp/stats`.

## Settings

For a bridge installed with install.sh, settings live in `~/.config/homehub-voice/config.env`; see [config.env.example](config.env.example). After changing them:

```bash
systemctl --user restart homehub-voice
```

- **Add a speaker by address** if it isn't found: `SPEAKERS=192.168.0.40`. For one with an encryption key: `SPEAKERS=192.168.0.40|<key>`.
- **Speech model:** `WHISPER_MODEL=base.en` is English and fastest. `small` is more accurate and handles other languages, set with `LANGUAGE`, but takes about three times as long.
- **Cantonese:** see below.

## Cantonese

With Cantonese on, each command can be English or Cantonese, and is answered in the same language.

1. In **Settings → Voice control**, tick **Cantonese** and save. The bridge downloads SenseVoice Small (about 1 GB, of which it keeps 230 MB) and a Cantonese voice (110 MB). For a bridge installed with install.sh, set `LANGUAGES=en yue` in its `config.env` and run `./install.sh` again instead.
2. In HomeHub, give each device you want to use a Cantonese nickname, in **Settings → Devices**: for example 廚房燈 on the kitchen lights, or 寫字樓燈 and 書房燈 on the office lamp. Giving two devices the same nickname, such as 卓希房燈, switches both. You can also teach one from a missed command, in **Settings → Teach HomeHub**. The bridge picks up new nicknames within a minute.
3. Say the verb, then the nickname: 開廚房燈, 着廚房燈, 關廚房燈, 熄廚房燈. 幫我 or 唔該 first, and 啦 or 呀 at the end, are fine. A scene with a Cantonese name runs by its name alone.

How it works: SenseVoice hears each command first and says which language it's in, in about 0.1 seconds. English then goes to Whisper as before. Cantonese is matched to your Cantonese nicknames by how it sounds, using Jyutping with tones ignored, because speech recognition often writes a word with a different character that sounds the same (民房 for 文房). Only the first word is read as the verb, so a name that starts with a verb's sound, such as 卓 and 着, still works. A command that doesn't clearly match one nickname isn't guessed: the speaker says 唔好意思，我聽唔明, and HomeHub lists it with the commands it missed. HomeHub's rules still decide what happens, so protected devices and cameras are as safe as in English.

On the household's 37 test recordings, it read all 33 commands for devices that exist correctly, and refused the 4 for a room with no light. Its matching was tuned on those same recordings, so expect some misses on new ones.

Not yet in Cantonese: timers ("for an hour"), pausing or resuming cameras by name, and the replies HomeHub's settings let you choose.

## Checking on it

```bash
systemctl --user status homehub-voice
journalctl --user -u homehub-voice -f
```

Each command is logged with what was heard, HomeHub's reply and how long each step took. The bridge also checks in with HomeHub every minute, so HomeHub's **Health** page shows whether it's running and which speakers are connected. HomeHub's answer tells it when device or scene names have changed, so it fetches them again, and when an admin selected **Restart voice bridge** on the Health page. It then stops with exit code 75, and systemd starts it again.

## Measured speed

On a 2015 MacBook Pro (Core i7-4980HQ) with `base.en`, recognising a 2 to 4 second command took 0.6 to 0.8 seconds, and making the spoken reply 0.1 to 0.2 seconds. Spoken to Ava on a tablet, with HomeHub on the same laptop, the reply was ready 1.0 to 1.3 seconds after the speaker stopped talking.

## Not done yet

- **Home Assistant Voice:** its firmware expects Home Assistant to set its encryption key, so whether the bridge can connect to one out of the box hasn't been tested.
- Languages other than English and Cantonese.

## Credits

The bridge downloads these speech models when voice is turned on. They aren't part of HomeHub, and each has its own license.

| Model | Used for | Source and license |
|---|---|---|
| Whisper `base.en`, as converted for faster-whisper | Hearing English | OpenAI; Systran (conversion). MIT |
| Piper voice `en_US-ljspeech-medium` | Speaking English | Piper (Michael Hansen, Rhasspy), trained on the LJ Speech dataset by Keith Ito and Linda Johnson. Public domain dataset |
| SenseVoice Small, as converted for sherpa-onnx (int8) | Telling the language apart, and hearing Cantonese | [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) by Tongyi Lab, Alibaba Group; sherpa-onnx (conversion). [FunASR Model Open Source License](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE) |
| `vits-cantonese` | Speaking Cantonese | [xiaomaiiwn on Hugging Face](https://huggingface.co/xiaomaiiwn/vits-cantonese); sherpa-onnx (conversion). No license stated |

Until v0.1.25 the English voice was Piper's `en_US-lessac-medium`, whose recordings are licensed for research only. Updating removes it.

## Tests

```bash
python -m unittest discover tests
```

The tests need the Python packages in `requirements.txt` but no speakers, HomeHub or speech models.
