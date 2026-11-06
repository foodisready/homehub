"""Downloads the speech models the bridge needs, once, into its models folder.

The bridge that comes with HomeHub does this itself when voice is turned on.
install.sh does the same for a bridge installed on its own. Whisper downloads
its own model when first loaded.
"""
from __future__ import annotations

import logging
import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path

log = logging.getLogger('homehub-voice')

PIPER = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx'
SHERPA = 'https://github.com/k2-fsa/sherpa-onnx/releases/download'
SENSEVOICE = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
CANTONESE_VOICE = 'vits-cantonese-hf-xiaomaiiwn'
TIMEOUT_S = 60


def _fetch(url: str, dest: Path) -> None:
    """Downloads to a temporary name first, so an interrupted download is never mistaken for a model."""
    part = dest.with_name(dest.name + '.part')
    with urllib.request.urlopen(url, timeout=TIMEOUT_S) as r, open(part, 'wb') as f:
        shutil.copyfileobj(r, f, 1 << 20)
    part.replace(dest)


def piper_voice(path: Path) -> None:
    if path.exists() and path.with_name(path.name + '.json').exists():
        return
    log.info('downloading the English voice (about 60 MB)')
    path.parent.mkdir(parents=True, exist_ok=True)
    _fetch(PIPER + '.json', path.with_name(path.name + '.json'))
    _fetch(PIPER, path)


def _archive(url: str, inside: str, dest: Path, keep: list[str]) -> None:
    """Fetches a .tar.bz2 and keeps only the files the bridge uses."""
    if all((dest / f).exists() for f in keep):
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=dest.parent) as tmp:
        archive = Path(tmp) / 'model.tar.bz2'
        _fetch(url, archive)
        with tarfile.open(archive) as t:
            t.extractall(tmp, filter='data')
        dest.mkdir(exist_ok=True)
        for f in keep:
            (Path(tmp) / inside / f).replace(dest / f)


def sensevoice(dest: Path) -> None:
    if not (dest / 'model.int8.onnx').exists():
        log.info('downloading SenseVoice, for Cantonese (about 1 GB; keeps 230 MB)')
    _archive(f'{SHERPA}/asr-models/{SENSEVOICE}.tar.bz2', SENSEVOICE, dest, ['model.int8.onnx', 'tokens.txt'])


def cantonese_voice(dest: Path) -> None:
    if not (dest / f'{CANTONESE_VOICE}.onnx').exists():
        log.info('downloading the Cantonese voice (about 110 MB)')
    _archive(f'{SHERPA}/tts-models/{CANTONESE_VOICE}.tar.bz2', CANTONESE_VOICE, dest,
             [f'{CANTONESE_VOICE}.onnx', 'lexicon.txt', 'tokens.txt', 'rule.fst'])
