"""Speech to text (Whisper) and text to speech (Piper)."""
from __future__ import annotations

import threading
import wave
from pathlib import Path

import numpy as np


class Listener:
    def __init__(self, model: str, language: str) -> None:
        from faster_whisper import WhisperModel

        self.model = WhisperModel(model, device='cpu', compute_type='int8')
        self.language = language
        self.lock = threading.Lock()

    def transcribe(self, audio: bytes, names: list[str]) -> str:
        pcm = np.frombuffer(audio[: len(audio) // 2 * 2], dtype=np.int16).astype(np.float32) / 32768
        # Short commands and the home's device names steer Whisper towards them ("office lens" → "office lamp").
        hint = 'Turn on the lamp. Turn off the lights.'
        if names:
            hint += ' Devices: ' + ', '.join(names) + '.'
        with self.lock:
            segments, _ = self.model.transcribe(pcm, language=self.language, beam_size=5, initial_prompt=hint, vad_filter=True)
            return ' '.join(s.text.strip() for s in segments).strip()


class Speaker:
    def __init__(self, voice: Path) -> None:
        from piper import PiperVoice

        if not voice.exists():
            raise FileNotFoundError(f'Piper voice not found: {voice}')
        self.voice = PiperVoice.load(str(voice))
        self.lock = threading.Lock()

    def say(self, text: str, path: Path) -> None:
        with self.lock, wave.open(str(path), 'wb') as w:
            self.voice.synthesize_wav(text, w)
