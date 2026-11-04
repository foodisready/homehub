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
# The release the backend reports, such as v0.1.3. Releases before v0.1.4 always said 1.0.0.
running_version() {
  v=$(curl -fs -m 3 http://localhost:3000/health 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p') || true
  [ "$v" = "1.0.0" ] && v=""
  echo "$v"
}

if [ -f docker-compose.yml ]; then
  FRESH=""
  OLD_VERSION=$(running_version)
  say "Updating HomeHub${OLD_VERSION:+ $OLD_VERSION} in $DIR"
else
  FRESH=1
  OLD_VERSION=""
  say "Installing HomeHub in $DIR"
fi
curl -fsSL "$RAW/docker-compose.yml" -o docker-compose.yml.new
mv docker-compose.yml.new docker-compose.yml

# HomeHub's Update and Go back record the version they chose in .env. Running
# the installer means the newest release, so drop that (a HOMEHUB_TAG set by
# hand stays).
if grep -qs '^# Chosen in HomeHub' .env; then
  sed -i '/^# Chosen in HomeHub/{N;/\nHOMEHUB_TAG=/d;}' .env
fi

# A 4 GB Pi runs short of memory with the default AI model, so pick the small one.
MEM_KB=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
if [ "${MEM_KB:-0}" -lt 6000000 ] && ! grep -qs '^OLLAMA_MODEL=.' .env; then
  echo "This computer has under 6 GB of memory, so HomeHub will use the smaller AI model (llama3.2:1b)."
  printf '\n# Set by the installer: this computer has under 6 GB of memory.\nOLLAMA_MODEL=llama3.2:1b\n' >> .env
fi

if [ -n "$FRESH" ]; then say "Downloading HomeHub. This can take 10 minutes or more."; else say "Downloading what's new"; fi
# A slow or dropped connection shouldn't end the install, so try a few times.
n=1
until $DOCKER compose -f docker-compose.yml pull; do
  [ $n -ge 3 ] && fail "Couldn't download HomeHub. Check the internet connection, then run the installer again."
  n=$((n + 1))
  echo "Download interrupted. Trying again ($n of 3)…"
  sleep 10
done
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
NEW_VERSION=$(running_version)
if [ -n "$FRESH" ] || [ -z "$NEW_VERSION" ]; then
  say "HomeHub${NEW_VERSION:+ $NEW_VERSION} is running."
elif [ -n "$OLD_VERSION" ] && [ "$OLD_VERSION" != "$NEW_VERSION" ]; then
  say "HomeHub updated from $OLD_VERSION to $NEW_VERSION, and is running."
elif [ -n "$OLD_VERSION" ]; then
  say "HomeHub $NEW_VERSION is running. It was already up to date."
else
  say "HomeHub updated to $NEW_VERSION, and is running."
fi
echo "Open it on a phone or computer on the same network:"
echo
echo "    http://homehub.local:4200"
[ -n "$IP" ] && echo "    http://$IP:4200   (if homehub.local doesn't open)"
echo
if [ -n "$FRESH" ]; then
  echo "HomeHub asks you to create your account. Do that straight away."
  echo "The AI model for Chat keeps downloading in the background for a few more minutes."
  echo
fi
echo "To update HomeHub later, run this installer again."
case "$DOCKER" in
  sudo*) echo "To use docker commands without sudo, log out and back in." ;;
esac
