# HomeHub's voice bridge, as it comes with HomeHub: it waits, using almost no
# memory, until voice is turned on in Settings → Voice control, then downloads
# its speech models into /models and connects to the speakers.

FROM python:3.12-slim-bookworm AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY homehub_voice ./homehub_voice

# The tests need no models, speakers or HomeHub; a failing test stops the build.
FROM base AS test
COPY tests ./tests
RUN python -m unittest discover tests

FROM base AS production
# The same user and group as HomeHub's backend (100:101), whose group can read
# the internal key it makes in its data volume.
RUN groupadd -g 101 homehub && useradd -u 100 -g 101 -M -d /models -s /usr/sbin/nologin homehub \
 && mkdir -p /models && chown 100:101 /models
# Built only after the tests pass.
COPY --from=test /app/tests /tmp/tests-passed
RUN rm -rf /tmp/tests-passed
USER 100:101
ENV HOMEHUB_VOICE_MANAGED=1 \
    MODELS_DIR=/models \
    HOMEHUB_URL=http://localhost:3000 \
    HOMEHUB_INTERNAL_KEY_FILE=/homehub/secrets/INTERNAL_API_KEY \
    HF_HOME=/models/huggingface \
    HF_HUB_DISABLE_TELEMETRY=1
CMD ["python", "-m", "homehub_voice"]
