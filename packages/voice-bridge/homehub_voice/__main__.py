"""HomeHub voice bridge: speakers → Whisper → HomeHub → Piper → speakers.

Run with `python -m homehub_voice`. Settings come from environment variables;
see config.env.example.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys

from . import config as cfg
from .homehub import HomeHub
from .pipeline import answer
from .replies import ReplyServer
from .speakers import SpeakerLink, Speakers

log = logging.getLogger('homehub-voice')

NAMES_EVERY_S = 600


async def main() -> int:
    logging.basicConfig(
        level=os.environ.get('LOG_LEVEL', 'INFO').upper(),
        format='%(levelname)s %(message)s' if os.environ.get('INVOCATION_ID') else '%(asctime)s %(levelname)s %(message)s',
    )
    for noisy in ('httpx', 'faster_whisper'):  # model download checks, per-command details
        logging.getLogger(noisy).setLevel(logging.WARNING)
    try:
        conf = cfg.load()
    except cfg.ConfigError as e:
        log.error('%s', e)
        return 2

    from .speech import Listener, Speaker as Voice

    log.info('loading Whisper %s and the Piper voice', conf.whisper_model)
    listener = Listener(conf.whisper_model, conf.language)
    voice = Voice(conf.piper_voice)
    replies = ReplyServer(conf.reply_port)
    homehub = HomeHub(conf.homehub_url, conf.internal_key)
    log.info('HomeHub at %s knows %d device and scene names', conf.homehub_url, len(homehub.refresh_names()))

    def speak(text: str, host: str) -> str:
        path, name = replies.new_file()
        voice.say(text, path)
        return replies.url(name, host)

    speakers = Speakers(
        conf.speakers,
        lambda s, listed: SpeakerLink(s, lambda audio, spoke: answer(audio, spoke, listener, homehub), speak, listed),
        conf.discover,
    )
    if not conf.speakers and not conf.discover:
        log.error('No speakers: list them in SPEAKERS or turn DISCOVER on')
        return 2

    async def refresh_names() -> None:
        while True:
            await asyncio.sleep(NAMES_EVERY_S)
            await asyncio.get_running_loop().run_in_executor(None, homehub.refresh_names)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    tasks = [asyncio.create_task(speakers.run()), asyncio.create_task(refresh_names())]
    await stop.wait()
    log.info('stopping')
    for t in tasks:
        t.cancel()
    for link in speakers.links.values():
        if link.task:
            link.task.cancel()
    replies.close()
    return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
