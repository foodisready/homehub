#!/usr/bin/env bash
# Installs or updates the HomeHub voice bridge for the current user, as a
# service that starts at boot. Run it again after `git pull` to update.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="$HOME/.local/share/homehub-voice"
CONF="$HOME/.config/homehub-voice"
UNIT="$HOME/.config/systemd/user/homehub-voice.service"
# Public domain (LJ Speech). The earlier "lessac" voice was for research use only.
VOICE=en_US-ljspeech-medium
VOICE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ljspeech/medium"

command -v python3 >/dev/null || { echo "Python 3 is missing: sudo apt install -y python3-venv"; exit 1; }
python3 -m venv --help >/dev/null 2>&1 || { echo "Python venv is missing: sudo apt install -y python3-venv"; exit 1; }
command -v systemctl >/dev/null || { echo "This installer needs systemd (Ubuntu, Debian, Raspberry Pi OS)."; exit 1; }

mkdir -p "$DATA" "$CONF" "$(dirname "$UNIT")"

echo "== Python packages (the first time takes a few minutes)"
[ -x "$DATA/venv/bin/python" ] || python3 -m venv "$DATA/venv"
"$DATA/venv/bin/pip" install -q --upgrade pip
"$DATA/venv/bin/pip" install -q -r "$HERE/requirements.txt"

echo "== Bridge"
rm -rf "$DATA/app"
mkdir -p "$DATA/app"
cp -R "$HERE/homehub_voice" "$DATA/app/"

if [ ! -s "$DATA/$VOICE.onnx" ]; then
  echo "== Piper voice (about 60 MB)"
  curl -fsSL -o "$DATA/$VOICE.onnx.json" "$VOICE_URL/$VOICE.onnx.json"
  curl -fsSL -o "$DATA/$VOICE.onnx.part" "$VOICE_URL/$VOICE.onnx"
  mv "$DATA/$VOICE.onnx.part" "$DATA/$VOICE.onnx"
fi

if [ ! -f "$CONF/config.env" ]; then
  cp "$HERE/config.env.example" "$CONF/config.env"
  echo "== Settings written to $CONF/config.env"
fi

# The research-only "lessac" voice is replaced: point settings at the new one, then remove it.
if grep -q "en_US-lessac-medium.onnx" "$CONF/config.env"; then
  sed -i.bak "s#en_US-lessac-medium.onnx#$VOICE.onnx#" "$CONF/config.env"
  echo "== English voice changed to $VOICE in $CONF/config.env"
fi
rm -f "$DATA/en_US-lessac-medium.onnx" "$DATA/en_US-lessac-medium.onnx.json"

# Cantonese (LANGUAGES=en yue): SenseVoice to hear it, and a Cantonese voice to answer.
MODELS="https://github.com/k2-fsa/sherpa-onnx/releases/download"
fetch_model() {   # url, folder name in the archive, where to keep it, files to keep
  local url="$1" inside="$2" dest="$3"; shift 3
  [ -s "$dest/$1" ] && return 0
  local tmp; tmp="$(mktemp -d "$DATA/download.XXXXXX")"
  curl -fsSL "$url" | tar xj -C "$tmp"
  mkdir -p "$dest"
  for f in "$@"; do mv "$tmp/$inside/$f" "$dest/"; done
  rm -rf "$tmp"
}
if grep -Eq '^LANGUAGES=.*\byue\b' "$CONF/config.env"; then
  echo "== Cantonese: SenseVoice (downloads about 1 GB, keeps 230 MB) and a Cantonese voice (110 MB)"
  fetch_model "$MODELS/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2" \
    sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17 "$DATA/sensevoice" model.int8.onnx tokens.txt
  fetch_model "$MODELS/tts-models/vits-cantonese-hf-xiaomaiiwn.tar.bz2" \
    vits-cantonese-hf-xiaomaiiwn "$DATA/cantonese-voice" vits-cantonese-hf-xiaomaiiwn.onnx lexicon.txt tokens.txt rule.fst
fi
# Vietnamese (LANGUAGES=en vi): a Zipformer model to hear it, and a Piper voice to answer.
if grep -Eq '^LANGUAGES=.*\bvi\b' "$CONF/config.env"; then
  echo "== Vietnamese: a speech model (downloads about 60 MB, keeps 86 MB) and a Vietnamese voice (60 MB)"
  fetch_model "$MODELS/asr-models/sherpa-onnx-zipformer-vi-int8-2025-04-20.tar.bz2" \
    sherpa-onnx-zipformer-vi-int8-2025-04-20 "$DATA/vietnamese" \
    encoder-epoch-12-avg-8.int8.onnx decoder-epoch-12-avg-8.onnx joiner-epoch-12-avg-8.int8.onnx tokens.txt
  VI_VOICE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx"
  if [ ! -s "$DATA/vi_VN-vais1000-medium.onnx" ]; then
    curl -fsSL -o "$DATA/vi_VN-vais1000-medium.onnx.json" "$VI_VOICE_URL.json"
    curl -fsSL -o "$DATA/vi_VN-vais1000-medium.onnx.part" "$VI_VOICE_URL"
    mv "$DATA/vi_VN-vais1000-medium.onnx.part" "$DATA/vi_VN-vais1000-medium.onnx"
  fi
fi
chmod 700 "$CONF"
chmod 600 "$CONF/config.env"
[ -f "$CONF/internal-key" ] && chmod 600 "$CONF/internal-key"

cat > "$UNIT" <<EOF
[Unit]
Description=HomeHub voice bridge
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$CONF/config.env
Environment=PYTHONPATH=$DATA/app
Environment=HF_HUB_DISABLE_TELEMETRY=1
ExecStart=$DATA/venv/bin/python -m homehub_voice
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF

# Start at boot without anyone logged in.
loginctl enable-linger "$USER" 2>/dev/null || echo "Note: run 'sudo loginctl enable-linger $USER' so the bridge starts at boot."
systemctl --user daemon-reload

# The bridge signs in to HomeHub with its internal key. When HomeHub runs on
# this computer, copy it from HomeHub's backend: a value in .env wins over the
# one HomeHub made for itself.
if [ ! -s "$CONF/internal-key" ] && command -v docker >/dev/null; then
  backend="$(docker ps --filter label=com.docker.compose.service=backend --format '{{.Names}}' 2>/dev/null | head -1 || true)"
  if [ -n "$backend" ]; then
    (umask 077
     docker exec "$backend" sh -c 'v="$INTERNAL_API_KEY"; case "$v" in ""|change-me*) cat "${HOMEHUB_SECRETS_DIR:-/data/secrets}/INTERNAL_API_KEY";; *) echo "$v";; esac' \
       > "$CONF/internal-key.tmp" 2>/dev/null) && [ -s "$CONF/internal-key.tmp" ] \
      && mv "$CONF/internal-key.tmp" "$CONF/internal-key" && echo "== Connected to HomeHub on this computer" \
      || rm -f "$CONF/internal-key.tmp"
  fi
fi

if [ ! -s "$CONF/internal-key" ]; then
  echo
  echo "Almost done: the bridge needs HomeHub's internal key, and HomeHub isn't running on this computer."
  echo "On the computer running HomeHub, print it with:"
  echo "  docker exec \$(docker ps -qf label=com.docker.compose.service=backend) cat /data/secrets/INTERNAL_API_KEY"
  echo "Save it here in $CONF/internal-key (chmod 600), set HOMEHUB_URL in $CONF/config.env,"
  echo "then run this installer again."
  exit 0
fi

systemctl --user enable homehub-voice >/dev/null 2>&1
systemctl --user restart homehub-voice
echo
echo "The voice bridge is running. Follow it with: journalctl --user -u homehub-voice -f"
