"""Serves spoken replies to speakers, which fetch them by URL."""
from __future__ import annotations

import http.server
import logging
import socket
import tempfile
import threading
import time
import uuid
from pathlib import Path

log = logging.getLogger('homehub-voice')

KEEP_S = 600


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

    def url(self, name: str, for_host: str) -> str:
        return f'http://{address_towards(for_host)}:{self.port}/{name}'

    def close(self) -> None:
        self.server.shutdown()
