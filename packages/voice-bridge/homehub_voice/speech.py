"""Speech to text (Whisper; SenseVoice for Cantonese; Zipformer for Vietnamese) and text to speech
(Piper, for English and Vietnamese; VITS for Cantonese)."""
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
        self.model_file = voice
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
        # One lock for each pass, so the Cantonese pass can run while the first is still listening.
        self.locks = {id(self.auto): threading.Lock(), id(self.yue): threading.Lock()}

    def _run(self, rec, audio: bytes):
        s = rec.create_stream()
        s.accept_waveform(16000, _pcm(audio))
        with self.locks[id(rec)]:
            rec.decode_stream(s)
        return s.result

    def hear(self, audio: bytes) -> tuple[str, str]:
        """The language ('en', 'yue', 'zh', ... from a tag like <|yue|>) and the words, from one quick pass.
        On a Pi 4 this takes about a second, where Whisper takes ten."""
        r = self._run(self.auto, audio)
        return r.lang.strip('<|>') or 'en', r.text.strip()

    def language(self, audio: bytes) -> str:
        return self.hear(audio)[0]

    def transcribe(self, audio: bytes) -> str:
        return self._run(self.yue, audio).text.strip()


class VietnameseEars:
    """Vietnamese speech to text (sherpa-onnx Zipformer): about a third of a second a command on a Pi 4."""

    def __init__(self, folder: Path, threads: int = 2) -> None:
        import sherpa_onnx

        from .models import VIETNAMESE_FILES
        enc, dec, join, tokens = (folder / f for f in VIETNAMESE_FILES)
        if not all(f.exists() for f in (enc, dec, join, tokens)):
            raise FileNotFoundError(f'The Vietnamese speech model isn\'t in {folder}: run install.sh with LANGUAGES=en vi')
        # Beam search weighs a few readings before settling on one. On commands with background noise
        # or a room's echo, as from a tablet across the room, it understood 146 of 175 against 133
        # for taking each word's best guess, for about 0.04 s more on a Pi 4. More paths added nothing.
        self.rec = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=str(enc), decoder=str(dec), joiner=str(join), tokens=str(tokens), num_threads=threads,
            decoding_method='modified_beam_search', max_active_paths=4)
        self.lock = threading.Lock()

    def transcribe(self, audio: bytes) -> str:
        s = self.rec.create_stream()
        s.accept_waveform(16000, _pcm(audio))
        with self.lock:
            self.rec.decode_stream(s)
        return s.result.text.strip()


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
        self.model_file = model
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
