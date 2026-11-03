# Install HomeHub

This guide takes you from a new Raspberry Pi to a running HomeHub. It should take about an hour, and most of that is waiting for downloads and builds.

HomeHub is free. There's no HomeHub account, and it runs entirely on your own hardware.

## What you need

- **A Raspberry Pi 5 with 8 GB of RAM.** Other 64-bit Linux computers can work too.
- **A 64-bit operating system,** such as 64-bit Raspberry Pi OS or Ubuntu 24.04.
- **A wired or Wi-Fi connection** to the same network as your smart devices.
- **Enough free storage for Docker images and an AI model.** Allow at least 20 GB.

A 32-bit operating system won't work. To check yours, run `uname -m`. It should say `aarch64` or `x86_64`.

Docker Desktop on a Mac or Windows PC isn't recommended, because HomeHub's device discovery relies on Linux host networking.

## Step 1: Install Docker

Connect to your Pi, then install Docker and allow your user to run it:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
sudo systemctl enable docker
```

Log out and back in, then check that it works:

```bash
docker run --rm hello-world
docker compose version
```

Other install options are in [Docker's documentation](https://docs.docker.com/engine/install/).

## Step 2: Download HomeHub

HomeHub's ready-made images are on Docker Hub. You still download the source code, because it holds the settings template and the file that tells Docker how to run everything.

```bash
sudo apt-get install -y git
git clone https://github.com/playground/homehub.git
cd homehub
```

## Step 3: Add your settings

Copy the settings template:

```bash
cp .env.example .env
```

Run this command five times, and save each result for the first five settings below:

```bash
openssl rand -hex 32
```

Open the file with `nano .env` and change these settings:

| Setting | What to enter |
|---|---|
| `JWT_SECRET` | The first generated value |
| `JWT_REFRESH_SECRET` | The second generated value |
| `INTERNAL_API_KEY` | The third generated value |
| `MCP_SECRET` | The fourth generated value |
| `WATCHTOWER_HTTP_API_TOKEN` | The fifth generated value. HomeHub won't start without it. |
| `ADMIN_PASSWORD` | The password you'll use to sign in |
| `LATITUDE`, `LONGITUDE` | Your home's location, used for sunrise and sunset schedules |
| `TIMEZONE`, `TZ` | Your time zone, such as `America/New_York` |

Put quotes around a password that contains `#` or spaces. Press `Ctrl+O`, `Enter`, then `Ctrl+X` to save and exit.

Keep `.env` private, because it holds your passwords and secrets.

## Step 4: Start HomeHub

```bash
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml up -d
```

Use these exact commands. A plain `docker compose up` runs the development version instead.

The first start can take a while, because it downloads HomeHub and an AI model of about 2 GB. To check on it:

```bash
docker compose -f docker-compose.yml ps
```

HomeHub is ready when `backend` and `frontend` both show as running.

### Optional: Wyze cameras

To use Wyze cameras, set `COMPOSE_PROFILES=cameras` and `WYZE_BRIDGE_API_KEY` in `.env` before starting, as the [User Guide](./USER_GUIDE.md#cameras) explains. To add them later, set those and run the start command again.

## Step 5: Sign in

1. Find your Pi's address with `hostname -I`.
2. On a phone or computer on the same network, open `http://<your-pi-address>:4200`.
3. Sign in with the username `admin` and your `ADMIN_PASSWORD`.

Next, follow the [User Guide](./USER_GUIDE.md) to add your devices.

## Step 6: Reserve your Pi's address

In your router's settings, reserve the Pi's current IP address. This keeps the address from changing, which would break your bookmarks and any motion sensors reporting to it.

## After a restart or power cut

HomeHub starts by itself once Docker starts, so you don't need to do anything. If you stopped a service by hand, it stays stopped until you start it again.

## Everyday commands

Run these from the `homehub` folder.

| Task | Command |
|---|---|
| Check status | `docker compose -f docker-compose.yml ps` |
| See backend logs | `docker compose -f docker-compose.yml logs -f backend` |
| Stop HomeHub | `docker compose -f docker-compose.yml down` |
| Start HomeHub | `docker compose -f docker-compose.yml up -d` |

`down` keeps your data. Adding `-v` to it deletes your data, so don't use that unless you mean to.

## Update HomeHub

Back up first, then run:

```bash
git pull
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml up -d
```

To build HomeHub on the Pi from source instead, for example to try your own changes, run `docker compose -f docker-compose.yml up -d --build`. It takes 30–60 minutes on a Raspberry Pi 4.

### Publishing images

HomeHub's maintainer publishes new images from a computer with Docker signed in to Docker Hub:

```bash
scripts/release-images.sh
```

It builds the four HomeHub images for 64-bit ARM from committed code and pushes them tagged `latest` and with the commit. To publish under another Docker Hub account, set `HOMEHUB_IMAGE_PREFIX` to that account's name, both when publishing and in the Pi's `.env`.

## Back up your data

For everyday backups, use **Settings → Backups** in HomeHub. See the [User Guide](./USER_GUIDE.md#backups).

To copy all of HomeHub's data, including history and backups, off the Pi, run this. It creates a backup file in the current folder:

```bash
docker compose -f docker-compose.yml stop backend scheduler
docker run --rm -v homehub_homehub-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/homehub-backup.tgz -C /data .
docker compose -f docker-compose.yml start backend scheduler
```

Keep the backup somewhere other than the Pi, and treat it as private, because it contains device passwords.

## Ports

HomeHub uses these ports, so make sure nothing else on the computer does:

| Port | Used for |
|---|---|
| 4200 | The HomeHub website |
| 3000 | Backend, and motion sensor reports |
| 3001 | AI assistant connection (MCP) |
| 3002 | Scheduler |
| 8080 | Self-update helper |
| 11434 | Local AI model |
| 5050, 8888 | Wyze camera bridge, if turned on. Only HomeHub itself can reach these. |

Don't forward these ports through your router. For access away from home, use [Remote Access](./REMOTE_ACCESS.md).

## Problems during install

**`WATCHTOWER_HTTP_API_TOKEN must be set in .env`:** add a value for it in `.env`, as in Step 3.

**`Cannot start — required environment variables are missing`:** check the backend logs. A setting from Step 3 is missing or still has its placeholder value.

**`permission denied` when running Docker:** log out and back in after Step 1.

**The website doesn't load:** run the status command. If `backend` isn't running, check its logs. It waits for the AI model service, so give it a few more minutes on the first start.

**Chat is slow:** a Pi has no strong graphics chip, so requests that need the AI model can be slow. Simple commands such as "turn on the porch light" don't use the model.
