"""Talking to HomeHub's voice routes."""
from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from dataclasses import dataclass

log = logging.getLogger('homehub-voice')


class HomeHubError(Exception):
    pass


@dataclass
class CommandResult:
    handled: bool
    response: str


class HomeHub:
    def __init__(self, url: str, key: str, timeout: float = 15) -> None:
        self.base = url.rstrip('/') + '/internal/voice'
        self.key = key
        self.timeout = timeout
        self.names: list[str] = []

    def _call(self, path: str, body: dict | None = None) -> dict:
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'X-Internal-Key': self.key, 'Content-Type': 'application/json'},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise HomeHubError('HomeHub refused the bridge: check the internal key') from None
            raise HomeHubError(f'HomeHub answered {e.code}') from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise HomeHubError(f'HomeHub can\'t be reached: {getattr(e, "reason", e)}') from None

    def refresh_names(self) -> list[str]:
        """Device and scene names, which help speech recognition spell them right. Keeps the old list on failure."""
        try:
            self.names = list(self._call('/device-names').get('names', []))
        except HomeHubError as e:
            log.warning('%s; keeping %d known names', e, len(self.names))
        return self.names

    def command(self, text: str) -> CommandResult:
        res = self._call('/command', {'text': text})
        return CommandResult(bool(res.get('handled')), str(res.get('response') or ''))
