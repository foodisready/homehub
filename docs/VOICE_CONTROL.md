# Voice Control Plan

This is the plan for controlling HomeHub by voice without Google Home, Alexa or, if possible, Home Assistant. A full voice loop has worked with Ava on an Android tablet through a test bridge, but that bridge isn't part of HomeHub yet.

## Goal

Say something like "turn on my office lamp and leave it on for an hour", and have it work quickly, privately and reliably, even on a Raspberry Pi.

## Planned design

```text
Speaker or tablet → voice bridge → Whisper (speech to text)
                                 → HomeHub rules → device
                                 → optional decision model or Ollama
                                 → Piper (text to speech) → Speaker or tablet
```

Commands are handled in layers, fastest and most predictable first:

1. **Rules:** handle common commands such as "turn on X for an hour" with no AI model.
2. **Decision model (optional):** Julia 1 could resolve wording the rules miss, by choosing from the device list.
3. **Ollama:** handles open questions, on a machine with a capable GPU.

Chat and MCP refuse to switch a protected device, whether a rule or a model picked it. A device is protected if it's marked in Settings, its name contains "valve", or a sensor uses it for automatic shutoff. It can still be switched from its dashboard tile. Voice needs a confirmation step before this can be relaxed.

## Build order

1. ~~Add a real "on for X time" feature.~~ Done. The backend stores the turn-off time in `devices.timer_off_at` and checks it every 15 seconds, so a timer survives a restart.
2. ~~Add rule-based command handling.~~ Done, in `packages/backend/src/nlp/commands.ts`. Anything the rules can't read goes to Ollama.
3. Move HomeHub to the Raspberry Pi.
4. Time Whisper on the Pi using a recorded phrase.
5. Test the voice bridge with the Ava app on an Android tablet.
6. If the bridge works, buy one Home Assistant Voice and test it in the room where it matters most.
7. Add Julia 1 only if real commands show the rules missing too much.

Step 5 can run on a Mac.

## Connecting a speaker without Home Assistant

ESPHome voice devices connect through the same protocol, so one bridge could serve several device types. The [`aioesphomeapi`](https://github.com/esphome/aioesphomeapi) Python library includes `subscribe_voice_assistant` and a way to send audio back, so a small HomeHub service should be able to receive voice directly.

Ava accepts a connection from a custom bridge. Tested on 2026-11-01 with [`brownard/Ava`](https://github.com/brownard/Ava) v0.6.2 on an Android tablet and `aioesphomeapi` 46.25.0 on an Apple M1, without Home Assistant:

- The bridge connected and subscribed to voice with no password. Ava's port is unauthenticated.
- The "Okay Nabu" wake word started a run, and audio arrived about 50 ms later as 16 kHz 16-bit mono.
- With `base.en` on the M1 CPU, Whisper took under 1 second on a 10-second recording. It heard "office lens" until it was given the device names as a prompt, then heard "office lamp". That's one recording, so it isn't an accuracy measurement.
- An earlier recording was almost silent and the cause wasn't found. The working one was made about 1 foot from the tablet. Distance needs testing, and Ava's microphone source setting may help.

The full loop then worked: the wake word, Whisper, HomeHub's rules and a spoken Piper reply. HomeHub's reply was ready about 1 second after speech ended, on the Mac. Ava only streams after it detects the wake word, so people need to pause for about a second before speaking. HomeHub's voice route uses rules only, never a model, and records what it misses in `GET /api/nlp/stats`.

Voice and Chat can switch several devices that share a nickname, and run a scene by its whole name, such as "run Goodnight". Protected devices are skipped in both cases.

How to handle the Home Assistant Voice encryption key still needs proving, because [its firmware](https://github.com/esphome/home-assistant-voice-pe) expects Home Assistant to set it. The Ava test doesn't answer that.

### Rough effort

These are estimates, not measurements.

| Route | Effort | Notes |
|---|---|---|
| Home Assistant as a bridge | 1 to 2 days | Adds a second system to run |
| Custom bridge with stock firmware | 1 to 2 weeks, part-time | Preferred if the Ava test works |
| Custom firmware | 3 to 6 weeks | Also means maintaining the firmware |

The "on for X time" feature is needed on every route. These totals assume speech services and rules are included.

### If the bridge fails

Use Willow on an ESP32-S3-BOX-3, or a minimal Home Assistant as a bridge. Decide between them after the test.

## Hardware options

| Option | Good for | Watch out for |
|---|---|---|
| **Home Assistant Voice** | First choice: assembled, with an XMOS audio chip | Its normal setup requires Home Assistant |
| **ESP32-S3-BOX-3 + Willow** | Fastest working setup: [Willow can post recognized speech to a REST endpoint](https://github.com/HeyWillow/willow) | Mics are likely weaker, and it can't speak custom replies by itself |
| **Satellite1** | Noisy rooms: 4 mics and an XMOS chip | Has been sold as a dev kit, so check how it ships |
| **Android tablet or old phone + Ava** | Testing, or a voice panel with a screen | Always-on listening has Android limits, and the app port has no authentication |
| **Pi + Linux Voice Assistant** | Using a USB mic near the Pi | Experimental, and targets Home Assistant |
| **Pi + OpenVoiceOS** | A full voice platform with no Home Assistant | Another large system to run and maintain |
| **M5Stack Atom VoiceS3R** | A cheap test device, if it can run ESPHome voice firmware | One mic and a 1 W speaker, so close range only |
| **M5Stack Voice Pyramid** | Desktop use with echo cancellation | Sold without the Atom, listings show one mic, and it has no independent reviews yet |
| **ReSpeaker XVF3800** | Excellent 4-mic hardware | Needs its own speaker and enclosure, and ESPHome support is a community project |
| **Waveshare Smart 86 Box** | A wall panel with a screen | No confirmed ESPHome voice setup, so expect custom firmware |

Avoid unbranded AliExpress voice speakers, because their firmware and network behavior are unknown. Avoid `wyoming-satellite` too, because the project is archived. Regular Echo and Nest speakers can't pass voice directly to HomeHub, and a Bluetooth speaker's mic is unlikely to work for always-on listening.

Published pickup ranges are estimates. Test a device in the actual room before buying more.

## AI models

### Measured results

Tested on an Apple M1 with real commands and fake devices, 2026-10-31. Times exclude about 10 seconds per fake device, which can't respond.

| Setup | Time per command | Result |
|---|---|---|
| Docker, CPU only, `qwen2.5:3b` | About 3.5 minutes | Found the device, but very slow and repeated itself |
| Native Ollama, GPU, `qwen2.5:3b` | Mostly 3 to 9 seconds | Reliable tool calls |
| Native Ollama, GPU, `llama3.2:1b` | About 4 to 13 seconds | Sent a malformed command once |

A smaller model didn't help. The GPU made the difference, so keep `qwen2.5:3b` where a GPU is available.

A model that hasn't loaded yet can take about 45 seconds on the first command.

### Decision models

[Julia 1](https://huggingface.co/SupersonicLabs/Julia-1), [Laya](https://github.com/NandhaKishorM/laya) and Autotrust's JEV family choose from options you supply rather than generating text. They suit the Pi better than a chat model. Julia 1 has been tested here, as described below. Laya hasn't.

- They choose between fixed options, so they can't return free-form text or an arbitrary duration. Julia 1 can answer named questions, such as which tool, which device, on or off, and which of a fixed set of durations.
- They always pick an option, even for a request that matches none of them, so the options need a "none of these" choice.
- They run as a separate service, not through HomeHub's Ollama chat path.
- Julia 1's weights use 550.5 MiB, and it runs through Python and PyTorch unless an ONNX route is used.
- Julia 1 accepts 2 to 20 options per request.
- Julia 1 scored 71.33% on its published choice benchmark, so its reported confidence shouldn't be treated as accuracy.
- Don't assume published GPU speeds apply to a Pi.

`GET /api/nlp/stats` shows how often the rules miss, and on which messages, so check it before adding a model. Prefer Julia 1 over Laya if one is needed, because it's smaller. Before relying on it, measure its speed on the Pi.

### Julia 1 test results

Tested on an Apple M1 CPU on 2026-10-31, with 14 device names, 45 phrases written before the first run, and no connection to real devices. Of those, 27 phrases should switch a device: typos, speech errors and reworded commands. The other 18 match nothing or are unclear.

| Question | First attempt | Reworded attempt |
|---|---|---|
| Which device, for the 27 commands | 19 right, 1 wrong, 7 "none" | Same |
| Picks "none" for 12 unrelated requests | 12 of 12 | 12 of 12 |
| On or off, for the 27 commands | 15 right | 11 right |
| How long, for the 27 commands | 2 right | 1 right |
| Of the commands it would run | 12 of 19 right | 7 of 21 right |

- It's good at choosing a device and at refusing unrelated requests.
- It isn't safe for on or off. It read "kill the kitchen lights" as on at 98% confidence, and a confidence cutoff doesn't fix this: at 95%, 2 of 6 actions were still wrong.
- It can't be used for durations.
- It took about 80 ms per command and about 600 MB of memory on the M1. Expect it to be slower on a Pi.

If it's used, use it only to pick the device, and take on or off and the duration from rules. That combined design hasn't been tested yet.

### Raspberry Pi expectations

A Pi has no comparable GPU, so Ollama is unlikely to be usable for everyday commands there. Speech recognition may also be too slow: [fully local processing is recommended on an Intel N100 or better](https://smarthomeshopuk.com/products/home-assistant-voice-preview-edition). If Whisper feels slow on the Pi, run speech on a Mac or mini PC, and keep HomeHub on the Pi.

### A voice computer from an old laptop

An old laptop runs speech for the Pi while HomeHub stays on the Pi. The one in testing is a 2015 15" MacBook Pro (Core i7-4980HQ, 16 GB) with Ubuntu 26.04 Desktop. Its built-in Wi-Fi worked without extra drivers.

To set one up:

1. Install Ubuntu. Tick **Install OpenSSH server** if the installer offers it; otherwise install it afterwards:

   ```bash
   sudo apt update && sudo apt install -y openssh-server
   sudo systemctl enable --now ssh
   ```

2. From the computer you'll manage it from, copy your SSH key so you don't need its password each time: `ssh-copy-id <user>@<laptop-address>`.
3. Give it a fixed address. A reservation in your router's app is simplest. If you set it on the laptop instead, in Settings → Wi-Fi → the network's ⚙ → IPv4, choose **Manual** and fill in the address, netmask `255.255.255.0`, your router as the gateway, and your router as DNS. Reserve the address in the router too, so it isn't handed to another device.
4. Keep it awake with the lid closed: see [On an old laptop](./INSTALL.md#on-an-old-laptop).
5. Install the tools speech needs. On a MacBook, also turn on `mbpfan`, which runs the fans under Linux:

   ```bash
   sudo apt install -y git ffmpeg python3-venv python3-pip curl mbpfan
   sudo systemctl enable --now mbpfan
   ```

The speech software itself isn't packaged yet. The next step is to measure Whisper and SenseVoice there for English, Spanish, Vietnamese and Cantonese, using commands the household records.

## Success criteria

- A common command finishes within 2 to 3 seconds of speaking.
- "For an hour" turns the device off on time, even after a restart.
- Unclear names ask which device you mean.
- Audio stays on your own network.
- Main Valve is never switched by a guess.
