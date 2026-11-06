"""Speech to text (Whisper; SenseVoice for Cantonese) and text to speech (Piper; VITS for Cantonese)."""
from __future__ import annotations

import threading
import wave
from pathlib import Path

import numpy as np

PEAK = 0.95      # how loud the loudest moment of a reply is, as Piper makes it
MAX_GAIN = 10.0  # so near-silence isn't turned into loud noise


def louder(samples: np.ndarray) -> np.ndarray:
    """Raises a reply to full volume, as Piper does for English; sherpa-onnx voices come out at about a third."""
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    if peak <= 0:
        return samples
    return np.clip(samples * min(PEAK / peak, MAX_GAIN), -1, 1)


class Listener:
    def __init__(self, model: str, language: str, folder: Path | None = None) -> None:
        from faster_whisper import WhisperModel

        self.model = WhisperModel(model, device='cpu', compute_type='int8', download_root=str(folder) if folder else None)
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


def _pcm(audio: bytes) -> np.ndarray:
    return np.frombuffer(audio[: len(audio) // 2 * 2], dtype=np.int16).astype(np.float32) / 32768


class SenseVoice:
    """Cantonese speech to text, and which language a command is in (sherpa-onnx SenseVoice Small)."""

    def __init__(self, folder: Path, threads: int = 2) -> None:
        import sherpa_onnx

        model, tokens = folder / 'model.int8.onnx', folder / 'tokens.txt'
        if not model.exists() or not tokens.exists():
            raise FileNotFoundError(f'SenseVoice not found in {folder}: run install.sh with LANGUAGES=en yue')
        make = lambda lang: sherpa_onnx.OfflineRecognizer.from_sense_voice(  # noqa: E731
            model=str(model), tokens=str(tokens), language=lang, use_itn=True, num_threads=threads)
        # "auto" tells the language; forcing Cantonese then hears the words better.
        self.auto, self.yue = make('auto'), make('yue')
        self.lock = threading.Lock()

    def _run(self, rec, audio: bytes):
        s = rec.create_stream()
        s.accept_waveform(16000, _pcm(audio))
        with self.lock:
            rec.decode_stream(s)
        return s.result

    def language(self, audio: bytes) -> str:
        """'en', 'yue', 'zh', ... from a tag like <|yue|>."""
        return self._run(self.auto, audio).lang.strip('<|>') or 'en'

    def transcribe(self, audio: bytes) -> str:
        return self._run(self.yue, audio).text.strip()


class CantoneseVoice:
    """Spoken Cantonese replies (sherpa-onnx VITS). Its dictionary knows simplified characters best."""

    def __init__(self, folder: Path, threads: int = 2) -> None:
        import opencc
        import sherpa_onnx

        model = folder / 'vits-cantonese-hf-xiaomaiiwn.onnx'
        if not model.exists():
            raise FileNotFoundError(f'Cantonese voice not found in {folder}: run install.sh with LANGUAGES=en yue')
        v = sherpa_onnx.OfflineTtsVitsModelConfig(
            model=str(model), lexicon=str(folder / 'lexicon.txt'), tokens=str(folder / 'tokens.txt'))
        self.tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(vits=v, num_threads=threads),
            rule_fsts=str(folder / 'rule.fst')))
        self.simplify = opencc.OpenCC('t2s').convert
        self.lock = threading.Lock()

    def say(self, text: str, path: Path) -> None:
        with self.lock:
            sound = self.tts.generate(self.simplify(text), sid=0, speed=1.0)
        pcm = (louder(np.asarray(sound.samples, dtype=np.float32)) * 32767).astype(np.int16)
        with wave.open(str(path), 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sound.sample_rate)
            w.writeframes(pcm.tobytes())
