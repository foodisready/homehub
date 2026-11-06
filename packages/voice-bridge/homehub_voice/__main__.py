"""HomeHub voice bridge: speakers → Whisper (or SenseVoice for Cantonese) → HomeHub → Piper → speakers.

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
from .replies import ReplyServer
from .speakers import SpeakerLink, Speakers

log = logging.getLogger('homehub-voice')

NAMES_EVERY_S = 600
# While HomeHub hasn't answered yet (it may still be starting), ask for the names this often.
NAMES_RETRY_S = 15
# Exit code when HomeHub asks for a restart: not 0, so systemd (Restart=on-failure) starts it again.
RESTART_EXIT = 75
# How often the bridge checks in with HomeHub's Health page, at most. Changes are reported straight away.
REPORT_EVERY_S = 60
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

    cantonese, config_version = conf.cantonese, None
    if conf.managed:
        homehub.kind = 'docker'
        settings = await wait_until_on(homehub, stop)
        if settings is None:
            return 0
        cantonese, config_version = 'yue' in settings.get('languages', []), settings.get('version')

    try:
        loaded = await while_reporting(homehub, 'starting', stop, lambda: load_models(conf, cantonese))
    except (FileNotFoundError, OSError) as e:   # OSError includes a download that failed
        log.error('%s', e)
        if conf.managed:
            await asyncio.sleep(60)   # try again in a minute, not straight away
        return 2
    if loaded is None or stop.is_set():
        return 0
    listener, voices, ears = loaded
    replies = ReplyServer(conf.reply_port)
    log.info('HomeHub at %s knows %d device and scene names', conf.homehub_url, len(homehub.refresh_names()))

    def speak(text: str, host: str, lang: str = 'en') -> str:
        path, name = replies.new_file()
        voices.get(lang, voices['en']).say(text, path)
        return replies.url(name, host)

    speakers: Speakers
    speakers = Speakers(
        conf.speakers,
        lambda s, listed: SpeakerLink(
            s, lambda audio, spoke, asked=None: answer(audio, spoke, listener, homehub, ears, asked), speak, listed,
            on_change=lambda: speakers.changed.set(),
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

    async def report() -> None:
        nonlocal restart
        failing = False
        while True:
            try:
                await asyncio.wait_for(speakers.changed.wait(), REPORT_EVERY_S)
                await asyncio.sleep(1)  # let a burst of changes settle
            except TimeoutError:
                pass
            speakers.changed.clear()
            try:
                res = await asyncio.get_running_loop().run_in_executor(None, homehub.report, __version__, speakers.status())
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
                if res.get('namesVersion') and res['namesVersion'] != homehub.names_version:
                    count = len(homehub.names)
                    await asyncio.get_running_loop().run_in_executor(None, homehub.refresh_names)
                    log.info('names changed in HomeHub: now %d (were %d)', len(homehub.names), count)
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


def load_models(conf: cfg.Config, cantonese: bool):
    """Downloads what's missing (only when the bridge comes with HomeHub) and loads it. Slow: run it in a thread."""
    from . import models
    from .speech import CantoneseVoice, Listener, SenseVoice, Speaker as Voice

    if conf.managed:
        models.piper_voice(conf.piper_voice)
        if cantonese:
            models.sensevoice(conf.sensevoice_dir)
            models.cantonese_voice(conf.cantonese_voice_dir)
    log.info('HomeHub voice bridge %s: loading Whisper %s and the Piper voice', __version__, conf.whisper_model)
    listener = Listener(conf.whisper_model, conf.language, conf.whisper_dir)
    voices = {'en': Voice(conf.piper_voice)}
    ears = None
    if cantonese:
        log.info('Cantonese on: loading SenseVoice and the Cantonese voice')
        ears = SenseVoice(conf.sensevoice_dir)
        voices['yue'] = CantoneseVoice(conf.cantonese_voice_dir)
    return listener, voices, ears


async def while_reporting(homehub: HomeHub, state: str, stop: asyncio.Event, work):
    """Runs slow work in a thread, checking in as `state` meanwhile so Health can say what's happening."""
    loop = asyncio.get_running_loop()
    job = loop.run_in_executor(None, work)
    while True:
        try:
            await loop.run_in_executor(None, homehub.report, __version__, [], state)
        except HomeHubError:
            pass
        done, _ = await asyncio.wait({job}, timeout=REPORT_EVERY_S)
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
