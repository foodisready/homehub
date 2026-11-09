"""Talking to HomeHub's voice routes."""
from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field

log = logging.getLogger('homehub-voice')


class HomeHubError(Exception):
    pass


@dataclass
class CommandResult:
    handled: bool
    response: str
    # Devices HomeHub couldn't switch, from its list of actions.
    failed: list[str] = field(default_factory=list)


class HomeHub:
    def __init__(self, url: str, key: str, timeout: float = 15) -> None:
        self.base = url.rstrip('/') + '/internal/voice'
        self.key = key
        self.timeout = timeout
        self.names: list[str] = []
        # The scenes' names among them: only these may be run by saying a name alone.
        self.scenes: list[str] = []
        # HomeHub's version of the names, so the bridge knows when they change.
        self.names_version: str | None = None

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
            res = self._call('/device-names')
            self.names = list(res.get('names', []))
            # HomeHub before v0.1.27 didn't list scenes apart, so every name could be one.
            self.scenes = list(res['scenes']) if isinstance(res.get('scenes'), list) else self.names
            self.names_version = res.get('version')
        except HomeHubError as e:
            log.warning('%s; keeping %d known names', e, len(self.names))
        return self.names

    # Which bridge this is, so HomeHub notices two running at once.
    bridge_id = uuid.uuid4().hex[:12]
    kind = 'service'

    def report(self, version: str, speakers: list[dict], state: str = 'running') -> dict:
        """Checks in for HomeHub's Health page. HomeHub answers with the names' and settings' versions, and whether to restart."""
        return self._call('/status', {'version': version, 'speakers': speakers, 'state': state, 'id': self.bridge_id, 'kind': self.kind})

    def config(self) -> dict:
        """Voice on or off, and its languages, from HomeHub's Settings."""
        return self._call('/config')

    def command(self, text: str, retry: bool = False) -> CommandResult:
        """retry: if this isn't understood, the bridge will try again, so HomeHub doesn't list it as missed yet."""
        res = self._call('/command', {'text': text, **({'retry': True} if retry else {})})
        failed = [str((a.get('args') or {}).get('alias', '')) for a in res.get('actions') or []
                  if isinstance(a, dict) and isinstance(a.get('result'), dict) and a['result'].get('error')]
        return CommandResult(bool(res.get('handled')), str(res.get('response') or ''), failed)
