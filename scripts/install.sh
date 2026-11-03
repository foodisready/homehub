#!/bin/sh
# Install or update HomeHub on a Raspberry Pi or other 64-bit Linux computer.
#
#   curl -fsSL https://raw.githubusercontent.com/foodisready/homehub/main/scripts/install.sh | sh
#
# It installs Docker if needed, puts docker-compose.yml in ~/homehub,
# downloads HomeHub and starts it. Running it again updates HomeHub and
# keeps your data and your .env file.
#
# HOMEHUB_DIR changes the folder (default ~/homehub).
set -eu

RAW="${HOMEHUB_RAW_URL:-https://raw.githubusercontent.com/foodisready/homehub/main}"
DIR="${HOMEHUB_DIR:-$HOME/homehub}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# ── Check the computer ─────────────────────────────────────────
[ "$(uname -s)" = Linux ] || fail "HomeHub installs on Linux, such as Raspberry Pi OS. See docs/INSTALL.md."
case "$(uname -m)" in
  aarch64|arm64) ;;
  x86_64|amd64) ;;
  *) fail "HomeHub needs a 64-bit operating system. This one is $(uname -m). On a Raspberry Pi, install Raspberry Pi OS (64-bit)." ;;
esac
command -v curl >/dev/null || fail "curl is missing. Install it with: sudo apt install curl"

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

# ── Docker ─────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker. This takes a few minutes, and may ask for your password."
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
fi
if [ -n "$SUDO" ] && ! id -nG | tr ' ' '\n' | grep -qx docker; then
  $SUDO usermod -aG docker "$(id -un)" || true
fi
# Joining the docker group only counts after logging in again, so use sudo until then.
if docker info >/dev/null 2>&1; then DOCKER="docker"; else DOCKER="$SUDO docker"; fi
$DOCKER compose version >/dev/null 2>&1 || fail "Docker Compose is missing. Install it with: sudo apt install docker-compose-plugin"

# ── HomeHub ────────────────────────────────────────────────────
mkdir -p "$DIR"
cd "$DIR"
if [ -f docker-compose.yml ]; then say "Updating HomeHub in $DIR"; else say "Installing HomeHub in $DIR"; fi
curl -fsSL "$RAW/docker-compose.yml" -o docker-compose.yml.new
mv docker-compose.yml.new docker-compose.yml

# A 4 GB Pi runs short of memory with the default AI model, so pick the small one.
MEM_KB=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
if [ "${MEM_KB:-0}" -lt 6000000 ] && ! grep -qs '^OLLAMA_MODEL=.' .env; then
  echo "This computer has under 6 GB of memory, so HomeHub will use the smaller AI model (llama3.2:1b)."
  printf '\n# Set by the installer: this computer has under 6 GB of memory.\nOLLAMA_MODEL=llama3.2:1b\n' >> .env
fi

say "Downloading HomeHub. The first time, this can take 10 minutes or more."
$DOCKER compose -f docker-compose.yml pull
$DOCKER compose -f docker-compose.yml up -d --remove-orphans

say "Waiting for HomeHub to start"
i=0
until curl -fs -o /dev/null http://localhost:4200 && curl -fs -o /dev/null http://localhost:3000/health; do
  i=$((i + 1))
  if [ $i -ge 120 ]; then
    fail "HomeHub hasn't started after 10 minutes. Check it with: cd $DIR && docker compose -f docker-compose.yml logs backend"
  fi
  sleep 5
done

IP=$(hostname -I 2>/dev/null | awk '{ print $1 }') || true
[ -n "$IP" ] || IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }') || true
say "HomeHub is running."
echo "Open it on a phone or computer on the same network:"
echo
echo "    http://homehub.local:4200"
[ -n "$IP" ] && echo "    http://$IP:4200   (if homehub.local doesn't open)"
echo
echo "The first time, HomeHub asks you to create your account. Do that straight away."
echo "The AI model for Chat keeps downloading in the background for a few more minutes."
echo
echo "To update HomeHub later, run this installer again."
case "$DOCKER" in
  sudo*) echo "To use docker commands without sudo, log out and back in." ;;
esac
