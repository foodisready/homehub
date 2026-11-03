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

HomeHub's ready-made images are on Docker Hub, so you only need the file that tells Docker how to run them:

```bash
mkdir homehub && cd homehub
curl -fsSLO https://raw.githubusercontent.com/playground/homehub/main/docker-compose.yml
```

You don't need a settings file. HomeHub makes its own secrets the first time it starts, and you set everything else in the browser.

## Step 3: Start HomeHub

```bash
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml up -d
```

Use these exact commands, with `-f docker-compose.yml`.

The first start can take a while, because it downloads HomeHub and an AI model of about 2 GB. To check on it:

```bash
docker compose -f docker-compose.yml ps
```

HomeHub is ready when `backend` and `frontend` both show as running.

## Step 4: Create your account

1. Find your Pi's address with `hostname -I`.
2. On a phone or computer on the same network, open `http://<your-pi-address>:4200`.
3. HomeHub asks you to create the admin account. Choose a username and a password of at least 8 characters.

Do this straight away: until an account exists, anyone on your network who opens HomeHub can create it.

## Step 5: Set your home's location

After you create the account, HomeHub opens **Settings → Home**. Choose your time zone and enter your home's latitude and longitude. To find them, right-click your home in Google Maps and select the numbers at the top. Sunrise and sunset schedules use the location, and clock-time schedules use the time zone.

Next, follow the [User Guide](./USER_GUIDE.md) to add your devices.

### Optional: settings file

A few things are set in a `.env` file next to `docker-compose.yml`, such as Wyze cameras or a smaller AI model. To make one:

```bash
curl -fsSL https://raw.githubusercontent.com/playground/homehub/main/.env.example -o .env
nano .env
```

Every setting is optional, and the file explains each one. Press `Ctrl+O`, `Enter`, then `Ctrl+X` to save, then run the start command again.

- **Wyze cameras:** set `COMPOSE_PROFILES=cameras`. Then sign in to Wyze in HomeHub under **Cameras**, as the [User Guide](./USER_GUIDE.md#cameras) explains.
- **A Pi with 4 GB of memory:** set `OLLAMA_MODEL=llama3.2:1b`.

Keep `.env` private if you put passwords or secrets in it.

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

Back up first, then run this from the `homehub` folder:

```bash
curl -fsSLO https://raw.githubusercontent.com/playground/homehub/main/docker-compose.yml
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml up -d
```

Docker downloads only the images that changed, and restarts only those services. Your data stays in Docker's `homehub_homehub-data` volume.

If you installed with `git clone`, run `git pull` instead of the `curl` line. To build HomeHub from source, for example to try your own changes, run `docker compose -f docker-compose.yml up -d --build` from the cloned folder. It takes 30–60 minutes on a Raspberry Pi 4.

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

**HomeHub asks you to sign in, but you never made an account:** someone else on your network created it first. On a new install, start again with `docker compose -f docker-compose.yml down -v`, then the start command. `-v` deletes all of HomeHub's data, so don't use it once you've set HomeHub up.

**`Cannot start — required environment variables are missing`:** HomeHub couldn't save its secrets in its data volume. Check the backend logs, and that the disk isn't full.

**`permission denied` when running Docker:** log out and back in after Step 1.

**The website doesn't load:** run the status command. If `backend` isn't running, check its logs. It waits for the AI model service, so give it a few more minutes on the first start.

**Chat is slow:** a Pi has no strong graphics chip, so requests that need the AI model can be slow. Simple commands such as "turn on the porch light" don't use the model.
