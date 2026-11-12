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

# Public domain (LJ Speech). The earlier "lessac" voice was for research use only.
PIPER = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx'
OLD_VOICES = ['en_US-lessac-medium.onnx', 'en_US-lessac-medium.onnx.json']
SHERPA = 'https://github.com/k2-fsa/sherpa-onnx/releases/download'
SENSEVOICE = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
CANTONESE_VOICE = 'vits-cantonese-hf-xiaomaiiwn'
# Trained on about 70,000 hours of Vietnamese (Apache 2.0): https://huggingface.co/zzasdf/viet_iter3_pseudo_label
VIETNAMESE = 'sherpa-onnx-zipformer-vi-int8-2025-04-20'
VIETNAMESE_FILES = ['encoder-epoch-12-avg-8.int8.onnx', 'decoder-epoch-12-avg-8.onnx', 'joiner-epoch-12-avg-8.int8.onnx', 'tokens.txt']
# VAIS-1000 (CC BY 4.0), fine-tuned by Piper from its English "lessac" voice.
VIETNAMESE_VOICE = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx'
TIMEOUT_S = 60


def _fetch(url: str, dest: Path) -> None:
    """Downloads to a temporary name first, so an interrupted download is never mistaken for a model."""
    part = dest.with_name(dest.name + '.part')
    with urllib.request.urlopen(url, timeout=TIMEOUT_S) as r, open(part, 'wb') as f:
        shutil.copyfileobj(r, f, 1 << 20)
    part.replace(dest)


def _piper(url: str, path: Path, what: str) -> None:
    if not (path.exists() and path.with_name(path.name + '.json').exists()):
        log.info('downloading %s (about 60 MB)', what)
        path.parent.mkdir(parents=True, exist_ok=True)
        _fetch(url + '.json', path.with_name(path.name + '.json'))
        _fetch(url, path)


def piper_voice(path: Path) -> None:
    _piper(PIPER, path, 'the English voice')
    # The voice it replaced: no longer used, and not ours to keep.
    for old in OLD_VOICES:
        if old != path.name and old != path.name + '.json':
            (path.parent / old).unlink(missing_ok=True)


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


def vietnamese(dest: Path) -> None:
    if not (dest / VIETNAMESE_FILES[0]).exists():
        log.info('downloading the Vietnamese speech model (about 60 MB)')
    _archive(f'{SHERPA}/asr-models/{VIETNAMESE}.tar.bz2', VIETNAMESE, dest, VIETNAMESE_FILES)


def vietnamese_voice(path: Path) -> None:
    _piper(VIETNAMESE_VOICE, path, 'the Vietnamese voice')
