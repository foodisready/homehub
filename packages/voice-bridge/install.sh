#!/usr/bin/env bash
# Installs or updates the HomeHub voice bridge for the current user, as a
# service that starts at boot. Run it again after `git pull` to update.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="$HOME/.local/share/homehub-voice"
CONF="$HOME/.config/homehub-voice"
UNIT="$HOME/.config/systemd/user/homehub-voice.service"
VOICE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium"

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

if [ ! -s "$DATA/en_US-lessac-medium.onnx" ]; then
  echo "== Piper voice (about 60 MB)"
  curl -fsSL -o "$DATA/en_US-lessac-medium.onnx.json" "$VOICE_URL/en_US-lessac-medium.onnx.json"
  curl -fsSL -o "$DATA/en_US-lessac-medium.onnx.part" "$VOICE_URL/en_US-lessac-medium.onnx"
  mv "$DATA/en_US-lessac-medium.onnx.part" "$DATA/en_US-lessac-medium.onnx"
fi

if [ ! -f "$CONF/config.env" ]; then
  cp "$HERE/config.env.example" "$CONF/config.env"
  echo "== Settings written to $CONF/config.env"
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
