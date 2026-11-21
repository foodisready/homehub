"""Talking to HomeHub's voice routes."""
from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
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
    # The time or the weather, with its numbers, for a question answered in Vietnamese or Cantonese.
    info: dict | None = None
    # HomeHub's own words to say, already in the language heard: "Turn on Porch light?" when it
    # asks before doing what Claude read, or why it won't do something.
    say: str | None = None
    say_lang: str | None = None
    # Set when it asks: the speaker listens for a yes or no and sends it with this.
    confirm_id: str | None = None


class HomeHub:
    def __init__(self, url: str, key: str, timeout: float = 15) -> None:
        self.base = url.rstrip('/') + '/internal/voice'
        self.key = key
        self.timeout = timeout
        self.names: list[str] = []
        # Reminders waiting for a yes or no: [{'id': 3, 'lang': 'yue'}], from the config check.
        self.asking: list[dict] = []
        # The scenes' names among them: only these may be run by saying a name alone.
        self.scenes: list[str] = []
        # Each device's names (its alias and nicknames), so two nicknames of one light aren't a close call.
        self.groups: list[list[str]] = []
        # HomeHub's version of the names, so the bridge knows when they change.
        self.names_version: str | None = None
        # HomeHub can answer a command it doesn't know with "Turn on …?" (see confirm.py).
        self.can_ask = True

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
            # HomeHub before v0.1.59 didn't group them: every name is then its own device.
            groups = res.get('groups')
            self.groups = [list(map(str, g)) for g in groups if isinstance(g, list)] if isinstance(groups, list) else []
        except HomeHubError as e:
            log.warning('%s; keeping %d known names', e, len(self.names))
        return self.names

    # Which bridge this is, so HomeHub notices two running at once.
    bridge_id = uuid.uuid4().hex[:12]
    kind = 'service'

    def report(self, version: str, speakers: list[dict], state: str = 'running',
               languages: list[str] | None = None, detail: str = '') -> dict:
        """Checks in for HomeHub's Health page: the languages it runs with, and while starting what it's
        doing. HomeHub answers with the names' and settings' versions, and whether to restart."""
        body = {'version': version, 'speakers': speakers, 'state': state, 'id': self.bridge_id, 'kind': self.kind}
        if languages is not None:
            body['languages'] = languages
        if detail:
            body['detail'] = detail
        return self._call('/status', body)

    def config(self) -> dict:
        """Voice on or off, and its languages, from HomeHub's Settings."""
        return self._call('/config')

    def announced(self, announcement_id: str, said: list[str], error: str = '') -> None:
        """How saying a reminder went."""
        self._call(f'/announcements/{urllib.parse.quote(announcement_id)}', {'said': said, **({'error': error} if error else {})})

    def answer_ask(self, ask_id: int, answer: str, kind: str = 'reminder') -> bool:
        """The answer to a reminder's "done yet?", or a check-in's "are you OK?". False if HomeHub isn't asking it any more."""
        try:
            self._call(f'/asks/{int(ask_id)}', {'answer': answer, **({'kind': kind} if kind != 'reminder' else {})})
            return True
        except HomeHubError as e:
            if 'answered 404' in str(e):
                return False
            raise

    def sos(self, action: str, where: str, lang: str, heard: str) -> dict:
        """A call for help ('raise') or 'cancel', heard by the speaker `where`. Returns HomeHub's answer: its state."""
        return self._call('/sos', {'action': action, 'where': where, 'lang': lang, 'heard': heard})

    def answer_confirm(self, confirm_id: str, answer: str) -> dict | None:
        """The yes or no to HomeHub's "Turn on …?". Its answer says what to say; None if it isn't asking any more."""
        try:
            return self._call(f'/confirm/{urllib.parse.quote(confirm_id, safe="")}', {'answer': answer})
        except HomeHubError as e:
            if 'answered 404' in str(e):
                return None
            raise

    def command(self, text: str, retry: bool = False, lang: str | None = None, ask: bool = False,
                heard: str | None = None, wake: str | None = None) -> CommandResult:
        """retry: if this isn't understood, the bridge will try again, so HomeHub doesn't list it as missed yet.
        ask: HomeHub may answer a command its rules don't know with a question (with Claude chosen), which the
        speaker can ask and listen for. lang: the language heard. heard: what was said, when `text` is the
        bridge's English for a question it read ("what's the weather today" for 紐約天氣點), so HomeHub's
        Claude can find a city in it. wake: the wake word the speaker was woken with, for the Claude that
        reads a command HomeHub's rules missed (its end can be heard at the start: 老友 as 冇有).

        Every request says the bridge speaks HomeHub's `say` as it is (questions): with Claude chosen, HomeHub
        may answer a question itself, in the language heard, on a retry too.

        Also for what the bridge would take for talk in the room ("make the front brighter" has no on or off
        word): Claude asks only about a device it can name, and when it can't, the speaker stays quiet as before."""
        ask = ask and not retry
        res = self._call('/command', {'text': text, 'questions': True, **({'retry': True} if retry else {}),
                                      **({'ask': True} if ask else {}), **({'lang': lang} if lang else {}),
                                      **({'heard': heard} if heard else {}),
                                      **({'wake': wake} if wake and ask else {})})
        failed = [str((a.get('args') or {}).get('alias', '')) for a in res.get('actions') or []
                  if isinstance(a, dict) and isinstance(a.get('result'), dict) and a['result'].get('error')]
        info = next((a['result'] for a in res.get('actions') or [] if isinstance(a, dict)
                     and a.get('tool') in ('get_time', 'get_weather') and isinstance(a.get('result'), dict)), None)
        say = res.get('say') if isinstance(res.get('say'), str) and res.get('say') else None
        confirm_id = res.get('confirmId') if say and isinstance(res.get('confirmId'), str) else None
        return CommandResult(bool(res.get('handled')), str(res.get('response') or ''), failed, info,
                             say, str(res.get('lang') or lang or 'en') if say else None, confirm_id)
