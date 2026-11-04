# HomeHub voice bridge

Lets you control HomeHub by voice, with no cloud and no Home Assistant:

```text
speaker → wake word → bridge: Whisper (speech to text) → HomeHub → Piper (spoken reply) → speaker
```

It works with ESPHome voice speakers: [Ava](https://github.com/brownard/Ava) on an Android tablet, and should work with the Home Assistant Voice Preview Edition (not tested yet; see below). Speakers on your network are found automatically.

Commands go through HomeHub's rules only, never an AI model, so a misheard command can't switch a device the rules didn't match. Protected devices are never switched by voice.

## What it needs

- A computer running Ubuntu or Debian, on all the time. An old laptop is fine; a Raspberry Pi 4 is too slow (about 10 seconds to understand a command).
- Python 3.11 or newer, with `python3-venv`, `curl` and `ffmpeg`:

  ```bash
  sudo apt install -y python3-venv curl ffmpeg
  ```

- About 1.5 GB of disk and 1 GB of memory.

## Install

On the computer that will run it, from a copy of the HomeHub repository:

```bash
git clone https://github.com/foodisready/homehub.git
cd homehub/packages/voice-bridge
./install.sh
```

When HomeHub runs on the same computer, the installer connects to it by itself and starts the bridge. Otherwise it explains how to copy HomeHub's internal key across and point `HOMEHUB_URL` at it.

To update, run `git pull` in the repository, then `./install.sh` again.

## Using it

Say the wake word, pause about a second, then the command: "Okay Nabu … turn on the office lamp for 20 minutes". The speaker answers when it's done.

Commands HomeHub didn't understand are listed in **Settings**, from `GET /api/nlp/stats`.

## Settings

Settings live in `~/.config/homehub-voice/config.env`; see [config.env.example](config.env.example). After changing them:

```bash
systemctl --user restart homehub-voice
```

- **Add a speaker by address** if it isn't found: `SPEAKERS=192.168.0.40`. For one with an encryption key: `SPEAKERS=192.168.0.40|<key>`.
- **Speech model:** `WHISPER_MODEL=base.en` is English and fastest. `small` is more accurate and handles other languages, set with `LANGUAGE`, but takes about three times as long.

## Checking on it

```bash
systemctl --user status homehub-voice
journalctl --user -u homehub-voice -f
```

Each command is logged with what was heard, HomeHub's reply and how long each step took. The bridge also checks in with HomeHub every minute, so HomeHub's **Health** page shows whether it's running and which speakers are connected.

## Measured speed

On a 2015 MacBook Pro (Core i7-4980HQ) with `base.en`, recognising a 2 to 4 second command took 0.6 to 0.8 seconds, and making the spoken reply 0.1 to 0.2 seconds. Spoken to Ava on a tablet, with HomeHub on the same laptop, the reply was ready 1.0 to 1.3 seconds after the speaker stopped talking.

## Not done yet

- **Home Assistant Voice:** its firmware expects Home Assistant to set its encryption key, so whether the bridge can connect to one out of the box hasn't been tested.
- Languages other than English: HomeHub's command rules and the Piper voice are English only.

## Tests

```bash
python -m unittest discover tests
```

The tests need the Python packages in `requirements.txt` but no speakers, HomeHub or speech models.
