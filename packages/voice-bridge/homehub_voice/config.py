"""Settings, read from environment variables (the service loads them from config.env)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Speaker:
    host: str
    port: int = 6053
    # ESPHome encryption key (base64), for speakers that use one.
    key: str | None = None

    @property
    def label(self) -> str:
        return self.host if self.port == 6053 else f'{self.host}:{self.port}'


@dataclass(frozen=True)
class Config:
    homehub_url: str
    internal_key: str
    speakers: list[Speaker] = field(default_factory=list)
    whisper_model: str = 'base.en'
    language: str = 'en'
    piper_voice: Path = Path()
    # Spoken languages besides Whisper's: 'yue' adds Cantonese.
    cantonese: bool = False
    sensevoice_dir: Path = Path()
    cantonese_voice_dir: Path = Path()
    # Comes with HomeHub (Docker): waits until voice is turned on in HomeHub's
    # Settings, takes its languages from there, and downloads its own models.
    managed: bool = False
    # Where Whisper keeps its model; None for its usual cache.
    whisper_dir: Path | None = None
    reply_port: int = 39500
    # Look for speakers on the network as well as any listed in SPEAKERS.
    discover: bool = True


class ConfigError(Exception):
    pass


def parse_speakers(text: str) -> list[Speaker]:
    """`host[:port][|key]`, separated by commas or spaces."""
    out: list[Speaker] = []
    for item in text.replace(',', ' ').split():
        addr, _, key = item.partition('|')
        host, port = addr, 6053
        if addr.count(':') == 1:  # not an IPv6 address
            host, p = addr.split(':')
            if not p.isdigit() or not 0 < int(p) < 65536:
                raise ConfigError(f'SPEAKERS: "{item}" has a bad port')
            port = int(p)
        if not host:
            raise ConfigError(f'SPEAKERS: "{item}" has no address')
        out.append(Speaker(host, port, key or None))
    return out


def _flag(value: str | None, default: bool) -> bool:
    if value is None or not value.strip():
        return default
    return value.strip().lower() not in ('0', 'false', 'no', 'off')


def load(env: dict[str, str] | None = None) -> Config:
    env = dict(os.environ if env is None else env)
    url = env.get('HOMEHUB_URL', '').strip().rstrip('/')
    if not url:
        raise ConfigError('Set HOMEHUB_URL to your HomeHub backend, for example http://homehub.local:3000')

    key = env.get('HOMEHUB_INTERNAL_KEY', '').strip()
    key_file = env.get('HOMEHUB_INTERNAL_KEY_FILE', '').strip()
    if not key and key_file:
        try:
            key = Path(key_file).expanduser().read_text().strip()
        except OSError as e:
            raise ConfigError(f'HOMEHUB_INTERNAL_KEY_FILE can\'t be read: {e.strerror}') from None
    if not key:
        raise ConfigError('Set HOMEHUB_INTERNAL_KEY_FILE to a file holding HomeHub\'s INTERNAL_API_KEY')

    data = Path(env.get('MODELS_DIR', '').strip() or '~/.local/share/homehub-voice').expanduser()
    voice = Path(env.get('PIPER_VOICE', '').strip() or data / 'en_US-lessac-medium.onnx').expanduser()
    managed = _flag(env.get('HOMEHUB_VOICE_MANAGED'), False)
    port = env.get('REPLY_PORT', '39500').strip()
    extra = {x.strip().lower() for x in env.get('LANGUAGES', '').replace(',', ' ').split()}
    unknown = extra - {'en', 'yue'}
    if unknown:
        raise ConfigError(f'LANGUAGES: {", ".join(sorted(unknown))} isn\'t supported yet. Use en and yue (Cantonese).')
    if not port.isdigit():
        raise ConfigError('REPLY_PORT must be a number')

    return Config(
        homehub_url=url,
        internal_key=key,
        speakers=parse_speakers(env.get('SPEAKERS', '')),
        whisper_model=env.get('WHISPER_MODEL', '').strip() or 'base.en',
        language=env.get('LANGUAGE', '').strip() or 'en',
        piper_voice=voice,
        reply_port=int(port),
        discover=_flag(env.get('DISCOVER'), True),
        cantonese='yue' in extra,
        managed=managed,
        whisper_dir=data / 'whisper' if managed else None,
        sensevoice_dir=Path(env.get('SENSEVOICE_DIR', '').strip() or data / 'sensevoice').expanduser(),
        cantonese_voice_dir=Path(env.get('CANTONESE_VOICE_DIR', '').strip() or data / 'cantonese-voice').expanduser(),
    )
