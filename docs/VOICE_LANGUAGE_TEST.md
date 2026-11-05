# Recording the voice language test

HomeHub's voice control understands English only. Before adding Cantonese, Vietnamese or Spanish, we measure how well each speech-to-text engine hears real commands from the household. This page explains how to make those recordings.

## 1. Choose the commands

Pick **10–20 commands per language**. Use the way people at home would actually say them, with your real device names. For example:

- "Turn on the kitchen lights"
- "Turn off the office lamp in 10 minutes"
- "Is the main valve closed?"
- "Turn off everything downstairs"

Mix short and long commands, and include the device names that are hardest to say. The commands don't need to match between languages.

A dozen per language is enough for a first answer. English is optional, because it has already been tested.

## 2. Record them

Use the phone's voice recorder (Voice Memos on iPhone, Recorder on Android).

- Record **one command per recording**.
- Hold the phone about **3–6 feet away**, in a normal room, and speak at a normal volume.
- If possible, the person who will really use a language should be the one recording it: a Cantonese speaker for Cantonese, and so on.

## 3. Name the files

Name each file after its language and a number:

```
cantonese-01.m4a
cantonese-02.m4a
vietnamese-01.m4a
spanish-01.m4a
english-01.m4a
```

Any audio format works.

## 4. Write down what was said

Make one text file, `transcripts.txt`, with a line per recording in the original language:

```
cantonese-01: 開廚房燈
vietnamese-01: Bật đèn bếp
spanish-01: Apaga la lámpara de la oficina
```

This is the answer key the results are scored against. It matters most for Cantonese, where the text written down is the only way to know what the speaker meant.

## 5. Hand them over

Put all the recordings and `transcripts.txt` in one folder, for example `~/Downloads/voice-test/`, and say where it is. They are copied to the HomeHub server, and the comparison runs there.

## What the test measures

For each language and engine, the test reports:

- how many commands were heard correctly, especially the device names;
- the median and the slowest time to turn the speech into text.

| Language | Engines compared |
|---|---|
| English | Whisper base.en (used today) |
| Spanish | Whisper base, Whisper small |
| Vietnamese | Whisper small |
| Cantonese | SenseVoice Small, Whisper small, Whisper large-v3 |

A local language model (Qwen 2.5) is also tried for understanding the non-English commands once they are turned into text.

The results decide whether a language is worth adding, and which engine to use for it.

See [Voice control](VOICE_CONTROL.md) for how voice works today.
