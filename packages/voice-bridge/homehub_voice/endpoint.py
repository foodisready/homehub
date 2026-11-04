"""Deciding when someone has finished speaking, from 16 kHz 16-bit mono audio."""
from __future__ import annotations

import numpy as np

BYTES_PER_SECOND = 32000

# The first moment often holds the end of the wake word or the chime, so it doesn't count as speech.
SKIP_S = 0.4
# Loudness (RMS, 0..1) that counts as speech.
THRESHOLD = 0.006
# This much quiet after speech ends the command.
END_SILENCE_S = 0.8
# Give up if nobody speaks this soon after the wake word.
NO_SPEECH_S = 4.0
# The longest command.
MAX_S = 8.0


def loudness(chunk: bytes) -> float:
    samples = np.frombuffer(chunk[: len(chunk) // 2 * 2], dtype=np.int16)
    if not samples.size:
        return 0.0
    return float(np.sqrt(np.mean(samples.astype(np.float32) ** 2)) / 32768)


class Endpointer:
    """Collects one command's audio and says when it's over."""

    def __init__(self) -> None:
        self.audio = bytearray()
        self.spoke = False
        self.quiet = 0.0
        self.done = False

    @property
    def seconds(self) -> float:
        return len(self.audio) / BYTES_PER_SECOND

    def add(self, chunk: bytes) -> bool:
        """Adds audio. Returns True once the command is over."""
        if self.done:
            return True
        self.audio.extend(chunk)
        if self.seconds > SKIP_S:
            if loudness(chunk) > THRESHOLD:
                self.spoke = True
                self.quiet = 0.0
            else:
                self.quiet += len(chunk) / BYTES_PER_SECOND
        if (self.spoke and self.quiet >= END_SILENCE_S) or (not self.spoke and self.seconds >= NO_SPEECH_S) or self.seconds >= MAX_S:
            self.done = True
        return self.done
