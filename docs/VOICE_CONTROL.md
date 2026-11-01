# Voice Control Plan

This is the plan for controlling HomeHub by voice without Google Home, Alexa or, if possible, Home Assistant. Voice control isn't built yet. Chat commands work, but HomeHub has no microphone input, speech recognition or spoken replies.

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

Main Valve must ask for confirmation before any model-selected action switches it.

## Build order

1. Add a real "on for X time" feature. Store the turn-off time in the database so it survives restarts, and have the backend enforce it.
2. Add rule-based command handling.
3. Move HomeHub to the Raspberry Pi.
4. Time Whisper on the Pi using a recorded phrase.
5. Test the voice bridge with the Ava app on an Android tablet.
6. If the bridge works, buy one Home Assistant Voice and test it in the room where it matters most.
7. Add Julia 1 only if real commands show the rules missing too much.

Steps 1 and 2 don't depend on the Pi, and step 5 can run on a Mac.

## Connecting a speaker without Home Assistant

ESPHome voice devices connect through the same protocol, so one bridge could serve several device types. The [`aioesphomeapi`](https://github.com/esphome/aioesphomeapi) Python library includes `subscribe_voice_assistant` and a way to send audio back, so a small HomeHub service should be able to receive voice directly.

This hasn't been run against a real device. Two things need proving:

- Whether Ava accepts a connection from a custom bridge.
- How to handle the Home Assistant Voice encryption key, because [its firmware](https://github.com/esphome/home-assistant-voice-pe) expects Home Assistant to set it.

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

[Julia 1](https://huggingface.co/SupersonicLabs/Julia-1), [Laya](https://github.com/NandhaKishorM/laya) and Autotrust's JEV family choose from options you supply rather than generating text. They suit the Pi better than a chat model, but neither Julia 1 nor Laya has been tested here.

- They choose between fixed options, so they can't return free-form text or an arbitrary duration. Julia 1 can answer named questions, such as which tool, which device, on or off, and which of a fixed set of durations.
- They always pick an option, even for a request that matches none of them, so the options need a "none of these" choice.
- They run as a separate service, not through HomeHub's Ollama chat path.
- Julia 1's weights use 550.5 MiB, and it runs through Python and PyTorch unless an ONNX route is used.
- Julia 1 accepts 2 to 20 options per request.
- Julia 1 scored 71.33% on its published choice benchmark, so its reported confidence shouldn't be treated as accuracy.
- Don't assume published GPU speeds apply to a Pi.

Prefer Julia 1 over Laya if one is needed, because it's smaller. Before relying on it, test about 30 of your own phrases on the Pi and measure accuracy and speed.

### Raspberry Pi expectations

A Pi has no comparable GPU, so Ollama is unlikely to be usable for everyday commands there. Speech recognition may also be too slow: [fully local processing is recommended on an Intel N100 or better](https://smarthomeshopuk.com/products/home-assistant-voice-preview-edition). If Whisper feels slow on the Pi, run speech on a Mac or mini PC, and keep HomeHub on the Pi.

## Success criteria

- A common command finishes within 2 to 3 seconds of speaking.
- "For an hour" turns the device off on time, even after a restart.
- Unclear names ask which device you mean.
- Audio stays on your own network.
- Main Valve is never switched by a guess.
