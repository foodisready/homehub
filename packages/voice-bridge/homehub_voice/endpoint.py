"""Deciding when someone has finished speaking, from 16 kHz 16-bit mono audio."""
from __future__ import annotations

import logging
import threading

import numpy as np

log = logging.getLogger(__name__)

BYTES_PER_SECOND = 32000

# The first moment often holds the end of the wake word or the chime, so it doesn't count as speech.
SKIP_S = 0.4
# Loudness (RMS, 0..1) that counts as speech.
THRESHOLD = 0.006
# This much quiet after speech ends the command.
END_SILENCE_S = 0.8
# But after less speech than SHORT_SPEECH_S, wait this long: people pause after a verb and
# "light" ("mở đèn … nhà bếp"), and 0.8 s cut that off. A finished short command waits a moment longer.
SHORT_SPEECH_S = 1.0
SHORT_END_SILENCE_S = 1.3
# Give up if nobody speaks this soon after the wake word.
NO_SPEECH_S = 4.0
# The longest command.
MAX_S = 8.0


# Silero, the speech detector Whisper already uses, says whether each 32 ms is someone speaking.
# A Voice PE turns its microphone up until a quiet room is as loud as THRESHOLD, so loudness alone never
# heard it stop and every command ran to MAX_S. Once Silero has heard speech, its going quiet counts as quiet.
WINDOW = 512
CONTEXT = 64
SPEECH_ON = 0.5
SPEECH_OFF = 0.35

_model = None
_model_lock = threading.Lock()
_model_failed = False


def _silero():
    global _model, _model_failed
    with _model_lock:
        if _model is None and not _model_failed:
            try:
                from faster_whisper.vad import get_vad_model
                _model = get_vad_model()
            except Exception as e:  # without it, loudness alone decides, as before
                _model_failed = True
                log.warning('speech detector unavailable, using loudness alone: %s', e)
        return _model


class SpeechDetector:
    """Follows one command's audio through Silero, a window at a time."""

    def __init__(self, model) -> None:
        self.model = model
        self.h = np.zeros((1, 1, 128), np.float32)
        self.c = np.zeros((1, 1, 128), np.float32)
        self.context = np.zeros((1, CONTEXT), np.float32)
        self.pending = np.zeros(0, np.float32)
        self.speaking = False
        self.heard = False

    @classmethod
    def make(cls) -> SpeechDetector | None:
        model = _silero()
        return cls(model) if model is not None else None

    def add(self, chunk: bytes) -> bool:
        """Adds audio. Returns whether someone is speaking at its end."""
        samples = np.frombuffer(chunk[: len(chunk) // 2 * 2], dtype=np.int16).astype(np.float32) / 32768
        self.pending = np.concatenate([self.pending, samples])
        while self.pending.size >= WINDOW:
            window, self.pending = self.pending[None, :WINDOW], self.pending[WINDOW:]
            out, self.h, self.c = self.model.session.run(
                None, {'input': np.concatenate([self.context, window], 1), 'h': self.h, 'c': self.c})
            self.context = window[:, -CONTEXT:]
            p = float(np.ravel(out)[0])
            if p >= SPEECH_ON:
                self.speaking = self.heard = True
            elif p < SPEECH_OFF:
                self.speaking = False
        return self.speaking


def loudness(chunk: bytes) -> float:
    samples = np.frombuffer(chunk[: len(chunk) // 2 * 2], dtype=np.int16)
    if not samples.size:
        return 0.0
    return float(np.sqrt(np.mean(samples.astype(np.float32) ** 2)) / 32768)


def new_endpointer() -> Endpointer:
    return Endpointer(SpeechDetector.make())


class Endpointer:
    """Collects one command's audio and says when it's over."""

    def __init__(self, detector: SpeechDetector | None = None) -> None:
        self.detector = detector
        self.audio = bytearray()
        self.spoke = False
        self.quiet = 0.0
        # Seconds that were loud enough to be speech.
        self.voiced = 0.0
        # The loudest moment, and the quietest stretch after the wake word: for the log, to tune THRESHOLD.
        self.peak = 0.0
        self.floor = 1.0
        self.done = False

    @property
    def seconds(self) -> float:
        return len(self.audio) / BYTES_PER_SECOND

    def add(self, chunk: bytes) -> bool:
        """Adds audio. Returns True once the command is over."""
        if self.done:
            return True
        self.audio.extend(chunk)
        speaking = self.detector.add(chunk) if self.detector else True
        if self.seconds > SKIP_S:
            level = loudness(chunk)
            self.peak, self.floor = max(self.peak, level), min(self.floor, level)
            # Until Silero has heard someone speak, loudness alone decides: it may miss a voice.
            if level > THRESHOLD and (speaking or not self.detector.heard):
                self.spoke = True
                self.quiet = 0.0
                self.voiced += len(chunk) / BYTES_PER_SECOND
            else:
                self.quiet += len(chunk) / BYTES_PER_SECOND
        end_after = END_SILENCE_S if self.voiced >= SHORT_SPEECH_S else SHORT_END_SILENCE_S
        if (self.spoke and self.quiet >= end_after) or (not self.spoke and self.seconds >= NO_SPEECH_S) or self.seconds >= MAX_S:
            self.done = True
        return self.done
