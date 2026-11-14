"""HomeHub voice bridge: speakers → Whisper (SenseVoice for Cantonese, Zipformer for Vietnamese) → HomeHub → Piper → speakers.

Run with `python -m homehub_voice`. Settings come from environment variables;
see config.env.example.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import warnings

from . import __version__, config as cfg
from .homehub import HomeHub, HomeHubError
from .pipeline import answer
from .replies import ReplyCache, ReplyServer, speak_with
from .speakers import OneAnswers, SpeakerLink, Speakers

log = logging.getLogger('homehub-voice')

NAMES_EVERY_S = 600
# While HomeHub hasn't answered yet (it may still be starting), ask for the names this often.
NAMES_RETRY_S = 15
# Exit code when HomeHub asks for a restart: not 0, so systemd (Restart=on-failure) starts it again.
RESTART_EXIT = 75
# How often the bridge checks in with HomeHub's Health page, at most. Changes are reported straight away.
REPORT_EVERY_S = 60
# Between check-ins, how often to look whether the voice settings changed, so a newly ticked
# language starts loading within seconds of Save rather than a minute.
CONFIG_CHECK_S = 10
# While starting, how often to say what it's doing, so the download's progress moves on screen.
STARTING_REPORT_S = 5
# Loggers that report every web request of a model download.
NOISY = ('httpx', 'huggingface_hub', 'faster_whisper')
# While voice is off, how often to look whether it has been turned on.
WAIT_POLL_S = 10


async def main() -> int:
    logging.basicConfig(
        level=os.environ.get('LOG_LEVEL', 'INFO').upper(),
        format='%(levelname)s %(message)s' if os.environ.get('INVOCATION_ID') else '%(asctime)s %(levelname)s %(message)s',
    )
    # Whisper's model download logs each web request, and its libraries reset their own log levels
    # when they load, so their chatter is filtered where it's printed instead.
    for handler in logging.getLogger().handlers:
        handler.addFilter(lambda r: r.levelno >= logging.ERROR or not r.name.startswith(NOISY))
    warnings.filterwarnings('ignore', message='.*unauthenticated requests to the HF Hub.*')
    try:
        conf = cfg.load()
    except cfg.ConfigError as e:
        log.error('%s', e)
        return 2

    homehub = HomeHub(conf.homehub_url, conf.internal_key)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    cantonese, vietnamese, mandarin, config_version = conf.cantonese, conf.vietnamese, conf.mandarin, None
    if conf.managed:
        homehub.kind = 'docker'
        settings = await wait_until_on(homehub, stop)
        if settings is None:
            return 0
        languages = settings.get('languages', [])
        cantonese, vietnamese, mandarin = 'yue' in languages, 'vi' in languages, 'zh' in languages
        config_version = settings.get('version')

    languages = ['en'] + (['yue'] if cantonese else []) + (['vi'] if vietnamese else []) + (['zh'] if mandarin else [])
    try:
        loaded = await while_reporting(homehub, 'starting', stop, lambda: load_models(conf, cantonese, vietnamese, mandarin),
                                       languages)
    except (FileNotFoundError, OSError) as e:   # OSError includes a download that failed
        log.error('%s', e)
        if conf.managed:
            await asyncio.sleep(60)   # try again in a minute, not straight away
        return 2
    if loaded is None or stop.is_set():
        return 0
    listener, voices, ears, vi_ears = loaded
    replies = ReplyServer(conf.reply_port)
    log.info('HomeHub at %s knows %d device and scene names', conf.homehub_url, len(homehub.refresh_names()))

    speak = speak_with(replies, ReplyCache(conf.reply_cache_dir), voices)

    speakers: Speakers
    one_answers = OneAnswers()   # so two speakers that hear the same command don't both answer
    speakers = Speakers(
        conf.speakers,
        lambda s, listed: SpeakerLink(
            s, lambda audio, spoke, asked=None, prefer=None: answer(audio, spoke, listener, homehub, ears, asked, vi_ears, prefer), speak, listed,
            on_change=lambda: speakers.changed.set(), one_answers=one_answers, languages=languages,
        ),
        conf.discover,
    )
    if not conf.speakers and not conf.discover:
        log.error('No speakers: list them in SPEAKERS or turn DISCOVER on')
        return 2

    async def refresh_names() -> None:
        while True:
            await asyncio.sleep(NAMES_EVERY_S if homehub.names else NAMES_RETRY_S)
            await asyncio.get_running_loop().run_in_executor(None, homehub.refresh_names)

    restart = False

    async def names_changed(names_version: object) -> None:
        if names_version and names_version != homehub.names_version:
            count = len(homehub.names)
            await asyncio.get_running_loop().run_in_executor(None, homehub.refresh_names)
            log.info('names changed in HomeHub: now %d (were %d)', len(homehub.names), count)

    async def settings_changed() -> bool:
        """A quick look at the voice settings, between check-ins. A new nickname is fetched straight away."""
        if not config_version:
            return False
        try:
            res = await asyncio.get_running_loop().run_in_executor(None, homehub.config)
        except HomeHubError:
            return False
        # HomeHub before v0.1.79 doesn't say, so names wait for the next check-in.
        await names_changed(res.get('namesVersion'))
        return bool(res.get('version')) and res['version'] != config_version

    async def report() -> None:
        nonlocal restart
        failing = False
        last_report = 0.0
        loop = asyncio.get_running_loop()
        while True:
            try:
                await asyncio.wait_for(speakers.changed.wait(), CONFIG_CHECK_S if config_version else REPORT_EVERY_S)
                await asyncio.sleep(1)  # let a burst of changes settle
            except TimeoutError:
                if last_report and loop.time() - last_report < REPORT_EVERY_S:
                    if await settings_changed():
                        log.info('voice settings changed in HomeHub: restarting to apply them')
                        restart = True
                        stop.set()
                        return
                    continue
            speakers.changed.clear()
            last_report = loop.time()
            try:
                res = await loop.run_in_executor(None, homehub.report, __version__, speakers.status(), 'running', languages)
                if res.get('restart'):
                    log.info('HomeHub asked for a restart')
                    restart = True
                    stop.set()
                    return
                if config_version and res.get('configVersion') and res['configVersion'] != config_version:
                    log.info('voice settings changed in HomeHub: restarting to apply them')
                    restart = True
                    stop.set()
                    return
                await names_changed(res.get('namesVersion'))
                if failing:
                    log.info('checking in with HomeHub again')
                failing = False
            except HomeHubError as e:
                if not failing:
                    log.warning("can't check in with HomeHub: %s", e)
                failing = True

    tasks = [asyncio.create_task(speakers.run()), asyncio.create_task(refresh_names()), asyncio.create_task(report())]
    await stop.wait()
    log.info('stopping')
    for t in tasks:
        t.cancel()
    for link in speakers.links.values():
        if link.task:
            link.task.cancel()
    replies.close()
    return RESTART_EXIT if restart else 0


def load_models(conf: cfg.Config, cantonese: bool, vietnamese: bool = False, mandarin: bool = False):
    """Downloads what's missing (only when the bridge comes with HomeHub) and loads it. Slow: run it in a thread."""
    from . import models
    from .speech import CantoneseVoice, Listener, SenseVoice, Speaker as Voice, VietnameseEars

    if conf.managed:
        models.piper_voice(conf.piper_voice)
        if cantonese or mandarin:
            models.sensevoice(conf.sensevoice_dir)
        if cantonese:
            models.cantonese_voice(conf.cantonese_voice_dir)
        if mandarin:
            models.mandarin_voice(conf.mandarin_voice)
        if vietnamese:
            models.vietnamese(conf.vietnamese_dir)
            models.vietnamese_voice(conf.vietnamese_voice)
    models.progress.start('Loading the speech models')
    log.info('HomeHub voice bridge %s: loading Whisper %s and the Piper voice', __version__, conf.whisper_model)
    listener = Listener(conf.whisper_model, conf.language, conf.whisper_dir)
    voices = {'en': Voice(conf.piper_voice)}
    ears = None
    chinese = (('yue',) if cantonese else ()) + (('zh',) if mandarin else ())
    if chinese:
        log.info('%s on: loading SenseVoice', ' and '.join({'yue': 'Cantonese', 'zh': 'Mandarin'}[c] for c in chinese))
        ears = SenseVoice(conf.sensevoice_dir, chinese=chinese)
    if cantonese:
        log.info('loading the Cantonese voice')
        voices['yue'] = CantoneseVoice(conf.cantonese_voice_dir)
    if mandarin:
        log.info('loading the Mandarin voice')
        voices['zh'] = Voice(conf.mandarin_voice)
    vi_ears = None
    if vietnamese:
        log.info('Vietnamese on: loading its speech model and voice')
        vi_ears = VietnameseEars(conf.vietnamese_dir)
        voices['vi'] = Voice(conf.vietnamese_voice)
    return listener, voices, ears, vi_ears


async def while_reporting(homehub: HomeHub, state: str, stop: asyncio.Event, work, languages: list[str] | None = None):
    """Runs slow work in a thread, checking in as `state` meanwhile, with what it's doing, so Settings
    and Health can say so ("Downloading the Vietnamese voice: 45% of 60 MB")."""
    from .models import progress

    loop = asyncio.get_running_loop()
    job = loop.run_in_executor(None, work)
    while True:
        try:
            await loop.run_in_executor(None, homehub.report, __version__, [], state, languages, progress.text())
        except HomeHubError:
            pass
        done, _ = await asyncio.wait({job}, timeout=STARTING_REPORT_S)
        if done or stop.is_set():
            return await job if done else None


async def wait_until_on(homehub: HomeHub, stop: asyncio.Event) -> dict | None:
    """Waits, using almost no memory, until voice is turned on in HomeHub. None if stopped meanwhile."""
    loop = asyncio.get_running_loop()
    said, last_report = False, 0.0
    while not stop.is_set():
        try:
            settings = await loop.run_in_executor(None, homehub.config)
            if settings.get('enabled'):
                log.info('voice is on in HomeHub (%s)', ', '.join(settings.get('languages', [])))
                return settings
            if not said:
                log.info('waiting for voice to be turned on in HomeHub: Settings → Voice control')
                said = True
            if loop.time() - last_report >= REPORT_EVERY_S:
                await loop.run_in_executor(None, homehub.report, __version__, [], 'off')
                last_report = loop.time()
        except HomeHubError as e:
            log.debug('waiting for HomeHub: %s', e)
        try:
            await asyncio.wait_for(stop.wait(), WAIT_POLL_S)
        except TimeoutError:
            pass
    return None


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
