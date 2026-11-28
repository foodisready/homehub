"""Serves spoken replies to speakers, which fetch them by URL."""
from __future__ import annotations

import hashlib
import http.server
import logging
import os
import shutil
import socket
import tempfile
import threading
import time
import uuid
import wave
from pathlib import Path

log = logging.getLogger('homehub-voice')

KEEP_S = 600
# Spoken replies kept for reuse, the least recently used dropped first: about 200 KB each.
KEEP_FILES = 500


def address_towards(host: str) -> str:
    """This computer's address as seen from `host` (no packets are sent)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.connect((host, 9))
        return s.getsockname()[0]


class ReplyServer:
    def __init__(self, port: int) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix='homehub-voice-'))
        folder = str(self.dir)

        class Files(http.server.SimpleHTTPRequestHandler):
            # The Voice PE reads the type from here and plays nothing it doesn't know ('audio/x-wav' isn't).
            extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.wav': 'audio/wav', '.flac': 'audio/flac'}

            def __init__(self, *a, **k):
                super().__init__(*a, directory=folder, **k)

            def list_directory(self, path):  # no folder listings
                self.send_error(404)
                return None

            def log_message(self, fmt, *args):
                log.debug('reply served: ' + fmt, *args)

        self.server = http.server.ThreadingHTTPServer(('0.0.0.0', port), Files)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def new_file(self) -> tuple[Path, str]:
        """A path to write a reply to, and its name in URLs. Old replies are removed."""
        cutoff = time.time() - KEEP_S
        for f in self.dir.iterdir():
            if f.suffix in ('.wav', '.flac') and f.stat().st_mtime < cutoff:
                f.unlink(missing_ok=True)
        name = f'{uuid.uuid4().hex}.wav'
        return self.dir / name, name

    def copy_in(self, source: Path) -> tuple[Path, str] | None:
        """A kept reply copied in to be served, or None if it can't be."""
        path, name = self.new_file()
        try:
            shutil.copyfile(source, path)
        except OSError:
            path.unlink(missing_ok=True)
            return None
        return path, name

    def url(self, name: str, for_host: str) -> str:
        return f'http://{address_towards(for_host)}:{self.port}/{name}'

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class ReplyCache:
    """Spoken replies kept on disk and reused: making one takes seconds on a Pi (four for Cantonese),
    and a home hears the same few sentences again and again ("熄咗廚房燈。"). Kept across restarts.
    A reply is found by its words, its language and the voice that said it, so a new voice starts afresh.
    Never in the way: if the folder can't be used, replies are simply made each time."""

    def __init__(self, folder: Path | None, keep: int = KEEP_FILES) -> None:
        self.dir, self.keep = folder, keep
        self.lock = threading.Lock()
        if folder is None:
            return
        try:
            folder.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            log.warning('spoken replies won\'t be kept: %s', e)
            self.dir = None

    @staticmethod
    def voice_id(voice) -> str:
        f = getattr(voice, 'model_file', None)
        try:
            st = Path(f).stat()
            return f'{Path(f).name}:{st.st_size}:{int(st.st_mtime)}'
        except (TypeError, OSError):
            return type(voice).__name__

    def path(self, text: str, lang: str, voice) -> Path | None:
        if self.dir is None:
            return None
        key = hashlib.sha256(f'{lang}\n{self.voice_id(voice)}\n{text}'.encode()).hexdigest()[:32]
        return self.dir / f'{key}.wav'

    def find(self, text: str, lang: str, voice) -> Path | None:
        p = self.path(text, lang, voice)
        try:
            if p is not None and p.stat().st_size > 44:   # more than a bare WAV header
                os.utime(p)   # recently used: kept longest
                return p
        except OSError:
            pass
        return None

    def keep_copy(self, made: Path, text: str, lang: str, voice) -> None:
        p = self.path(text, lang, voice)
        if p is None:
            return
        tmp = p.with_name(f'{p.stem}.{uuid.uuid4().hex}.part')
        try:
            shutil.copyfile(made, tmp)
            os.replace(tmp, p)   # whole or not at all, even if two speakers make it at once
            self._trim()
        except OSError as e:
            log.debug('reply not kept: %s', e)
            tmp.unlink(missing_ok=True)

    def _trim(self) -> None:
        with self.lock:
            files = sorted(self.dir.glob('*.wav'), key=lambda f: f.stat().st_mtime)
            for f in files[: max(0, len(files) - self.keep)]:
                f.unlink(missing_ok=True)


# Silence before each reply. A phone running Ava starts playing before its sound is ready, and the
# first words were lost: 開咗啊亮燈 heard as 啊亮燈 (2026-11-21). Half a second covers them.
LEAD_IN_S = 0.5


def lead_in(path: Path, seconds: float = LEAD_IN_S) -> None:
    """`path`, a WAV file, with `seconds` of silence put in front. Left as it is if it can't be read."""
    try:
        with wave.open(str(path), 'rb') as r:
            params, frames = r.getparams(), r.readframes(r.getnframes())
        silence = b'\0' * (int(params.framerate * seconds) * params.sampwidth * params.nchannels)
        with wave.open(str(path), 'wb') as w:
            w.setparams(params)
            w.writeframes(silence + frames)
    except (OSError, EOFError, wave.Error) as e:
        log.warning('reply played without its lead-in: %s', e)


# The Voice PE's firmware (26.9.0) plays FLAC only, and asks for 48 kHz: given a WAV it fetches it and stays
# silent ("Could not determine audio file type", 2026-11-26). Phones running Ava play the WAV.
FLAC_RATE = 48000


def to_flac(path: Path) -> Path | None:
    """`path`, a WAV file, as 48 kHz mono FLAC beside it, or None if it can't be made (the WAV is then played)."""
    out = path.with_suffix('.flac')
    try:
        import av  # comes with faster-whisper
        with av.open(str(path)) as src, av.open(str(out), 'w', format='flac') as dst:
            stream = dst.add_stream('flac', rate=FLAC_RATE, layout='mono')
            resampler = av.AudioResampler(format='s16', layout='mono', rate=FLAC_RATE)
            for frame in [*src.decode(audio=0), None]:
                for f in resampler.resample(frame):
                    for packet in stream.encode(f):
                        dst.mux(packet)
            for packet in stream.encode(None):
                dst.mux(packet)
    except Exception as e:  # noqa: BLE001 — a reply in the wrong format is better than none
        log.warning('reply not made into FLAC: %s', e)
        out.unlink(missing_ok=True)
        return None
    path.unlink(missing_ok=True)
    return out


def seconds_of(path: Path) -> float:
    """How long a WAV file plays, or 0 if it can't be read."""
    try:
        with wave.open(str(path), 'rb') as r:
            return r.getnframes() / float(r.getframerate() or 1)
    except (OSError, EOFError, wave.Error):
        return 0.0


class Speech:
    """speak(text, host, lang, flac=False) -> the URL a speaker plays the reply from, reusing a kept reply when
    there is one. Kept replies stay as the voice made them; the copy served gets its lead-in, and is FLAC for
    speakers that play only that.

    A voice marked `slow` (the Cantonese one: seconds for a sentence on a Pi) is helped along: `ready` says
    whether a reply can be played straight away, `prepare` makes one ahead of time, and `seconds` says how
    long a served reply plays, so the next sentence can follow it."""

    def __init__(self, server: ReplyServer, cache: ReplyCache, voices: dict) -> None:
        self.server, self.cache, self.voices = server, cache, voices
        self.lengths: dict[str, float] = {}   # served URL -> seconds it plays, the last few

    def voice(self, lang: str):
        return self.voices.get(lang, self.voices['en'])

    def ready(self, text: str, lang: str = 'en') -> bool:
        """True if saying `text` takes no time to make: a voice that's quick, or a reply already kept."""
        voice = self.voice(lang)
        return getattr(voice, 'slow', False) is not True or self.cache.find(text, lang, voice) is not None

    def prepare(self, text: str, lang: str = 'en') -> None:
        """Makes and keeps the reply, without serving it, so the next time it's said it's ready. Slow: run it in a thread."""
        voice = self.voice(lang)
        if self.cache.dir is None or self.cache.find(text, lang, voice) is not None:
            return
        path, _ = self.server.new_file()
        try:
            voice.say(text, path)
            self.cache.keep_copy(path, text, lang, voice)
        except Exception as e:  # noqa: BLE001 — only a head start; the reply is made when it's needed
            log.warning('reply %r not made ahead: %s', text, e)
        finally:
            path.unlink(missing_ok=True)

    def seconds(self, url: str) -> float:
        """How long the reply at `url` plays, lead-in included; 0 if unknown."""
        return self.lengths.get(url, 0.0)

    def _served(self, path: Path, name: str, host: str, flac: bool) -> str:
        lead_in(path)
        length = seconds_of(path)
        if flac and (made := to_flac(path)):
            name = made.name
        url = self.server.url(name, host)
        if len(self.lengths) > 50:
            self.lengths.clear()
        self.lengths[url] = length
        return url

    def __call__(self, text: str, host: str, lang: str = 'en', flac: bool = False) -> str:
        voice = self.voice(lang)
        kept = self.cache.find(text, lang, voice)
        copied = self.server.copy_in(kept) if kept else None
        if copied:
            return self._served(*copied, host, flac)
        path, name = self.server.new_file()
        voice.say(text, path)
        self.cache.keep_copy(path, text, lang, voice)
        return self._served(path, name, host, flac)


def speak_with(server: ReplyServer, cache: ReplyCache, voices: dict) -> Speech:
    return Speech(server, cache, voices)
