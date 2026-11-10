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
from collections.abc import Callable
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
        for f in self.dir.glob('*.wav'):
            if f.stat().st_mtime < cutoff:
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


def speak_with(server: ReplyServer, cache: ReplyCache, voices: dict) -> Callable[[str, str, str], str]:
    """speak(text, host, lang) -> the URL a speaker plays the reply from, reusing a kept reply when there is one."""
    def speak(text: str, host: str, lang: str = 'en') -> str:
        voice = voices.get(lang, voices['en'])
        kept = cache.find(text, lang, voice)
        copied = server.copy_in(kept) if kept else None
        if copied:
            return server.url(copied[1], host)
        path, name = server.new_file()
        voice.say(text, path)
        cache.keep_copy(path, text, lang, voice)
        return server.url(name, host)
    return speak
