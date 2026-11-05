# Install HomeHub

This guide takes you from a new Raspberry Pi to a running HomeHub. It takes about 20 minutes, and most of that is waiting for downloads.

HomeHub is free. There's no HomeHub account, and it runs entirely on your own hardware.

## What you need

- **A Raspberry Pi 5 with 8 GB of RAM.** Other 64-bit Linux computers can work too.
- **A 64-bit operating system,** such as 64-bit Raspberry Pi OS or Ubuntu 24.04.
- **A wired or Wi-Fi connection** to the same network as your smart devices.
- **Enough free storage for Docker images and an AI model.** Allow at least 20 GB.

A 32-bit operating system won't work. To check yours, run `uname -m`. It should say `aarch64` or `x86_64`.

Docker Desktop on a Mac or Windows PC isn't recommended, because HomeHub's device discovery relies on Linux host networking.

## Step 1: Install HomeHub

Connect to your Pi, then run:

```bash
curl -fsSL https://raw.githubusercontent.com/foodisready/homehub/main/scripts/install.sh | sh
```

The installer:

- installs Docker, if it isn't already installed,
- puts HomeHub's settings in a `homehub` folder in your home folder,
- downloads HomeHub and starts it,
- chooses the smaller AI model on a Pi with 4 GB of memory,
- shows the address to open when HomeHub is ready.

It may ask for your Pi's password, to install Docker. The first time, it takes 10 minutes or more, mostly for downloads. You don't need a Docker account or a settings file: HomeHub makes its own secrets the first time it starts, and you set everything else in the browser.

To see what the installer does before you run it, open [scripts/install.sh](../scripts/install.sh).

### Or install by hand

If you'd rather run each step yourself, install Docker and allow your user to run it:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```

Log out and back in, then download HomeHub's compose file and start it:

```bash
mkdir homehub && cd homehub
curl -fsSLO https://raw.githubusercontent.com/foodisready/homehub/main/docker-compose.yml
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml up -d
```

Use these exact commands, with `-f docker-compose.yml`. HomeHub is ready when `docker compose -f docker-compose.yml ps` shows `backend` and `frontend` as running.

## Step 2: Create your account

1. On a phone or computer on the same network, open **http://homehub.local:4200**. If that doesn't open, use the address the installer showed, such as `http://192.168.1.50:4200`. To find it again, run `hostname -I` on the Pi.
2. HomeHub asks you to create the admin account. Choose a username and a password of at least 8 characters.

Do this straight away: until an account exists, anyone on your network who opens HomeHub can create it.

## Step 3: Follow the guided setup

After you create the account, HomeHub walks you through five short steps. Each one can be skipped, and **Finish later** takes you to the dashboard, which shows a **Continue setup** button until you're done.

1. **Home:** type your town, and HomeHub fills in its location and time zone. Sunrise and sunset schedules use the location; clock times use the time zone. Towns are looked up on HomeHub itself, so nothing is sent anywhere.
2. **Devices:** HomeHub searches your network and lists what it found. Untick anything you don't want, fix any names, and add them in one go. Devices that need a sign-in or key, such as Tuya plugs, can be connected later in **Settings → Devices**.
3. **Rooms:** HomeHub suggests a room from each name, such as *Kitchen* for "Kitchen lights". Change anything that's wrong.
4. **Automations:** optional starters: evening lights (on at sunset, off at a time you choose), outdoor lights from sunset to sunrise, and a **Goodnight** scene.
5. **Family:** show a QR code. Each person scans it with their phone, chooses a name and password, and is in.

You can run the setup again any time from **Settings → Home**. The [User Guide](./USER_GUIDE.md) covers everything else.

### Optional: settings file

A few things are set in a `.env` file next to `docker-compose.yml`, such as Wyze cameras or a smaller AI model. To make one:

```bash
curl -fsSL https://raw.githubusercontent.com/foodisready/homehub/main/.env.example -o .env
nano .env
```

Every setting is optional, and the file explains each one. Press `Ctrl+O`, `Enter`, then `Ctrl+X` to save. Then run `docker compose -f docker-compose.yml up -d` in the `homehub` folder.

- **No Wyze cameras:** set `HOMEHUB_CAMERA_BRIDGE=0` to leave the camera bridge out. It uses almost no memory until someone signs in to Wyze, so this is optional. You can also just turn cameras off in **Settings → Integrations**.
- **A different AI model:** set `OLLAMA_MODEL`. The installer already sets `llama3.2:1b` on a Pi with 4 GB of memory.
- **Another name than homehub.local,** for example with two HomeHubs on one network: set `HOMEHUB_LOCAL_NAME=cabin` for `http://cabin.local:4200`, or `off`.

Keep `.env` private if you put passwords or secrets in it.

## Step 4: Reserve your Pi's address

In your router's settings, reserve the Pi's current IP address. This keeps the address from changing, which would break your bookmarks and any motion sensors reporting to it.

### On an old laptop

A laptop running Ubuntu also works as the computer HomeHub runs on, but out of the box it sleeps when you close the lid or leave it alone. To keep it awake, run these on the laptop:

```bash
# Keep running with the lid closed
sudo mkdir -p /etc/systemd/logind.conf.d
printf '[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\n' | sudo tee /etc/systemd/logind.conf.d/homehub.conf

# Ubuntu Desktop only: don't sleep when idle on mains power
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'
```

Then restart the laptop (`sudo reboot`) so the lid setting takes effect. On Ubuntu Desktop, run the `gsettings` line in a terminal on the laptop itself, or turn off Settings → Power → **Automatic Suspend**. Ubuntu Server has no desktop, so it skips that step.

## Step 5 (optional): Use HomeHub away from home

[Tailscale](https://tailscale.com) gives your phone a private connection to HomeHub from anywhere, without opening your router to the internet. It's free for home use.

1. [Create a Tailscale account](https://login.tailscale.com/start), and install the Tailscale app on your phone.
2. On the Pi, install Tailscale and sign in. The second command shows a link: open it on your phone or computer and sign in with the same account.

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up --hostname=homehub
   ```

3. Give HomeHub a secure web address:

   ```bash
   sudo tailscale serve --bg 4200
   ```

   The first time, it may show a link to turn on HTTPS for your account. Open it and approve. If the command stops, run it again.
4. In the [Tailscale admin console](https://login.tailscale.com/admin/machines), open the Pi's **⋯** menu and choose **Disable key expiry**, so the Pi stays signed in.

With Tailscale on, your phone opens HomeHub at `https://homehub.<your-tailnet>.ts.net`. `tailscale serve status` shows the exact address. To let other people in your home use it, invite them to your tailnet; each person also needs their own HomeHub account. See [Remote Access](./REMOTE_ACCESS.md) for other options.

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

Back up first, then run the installer again:

```bash
curl -fsSL https://raw.githubusercontent.com/foodisready/homehub/main/scripts/install.sh | sh
```

It downloads only the images that changed and restarts only those services. Your data stays in Docker's `homehub_homehub-data` volume, and your `.env` file stays as it is.

Usually you don't need the installer for this: the Home page offers each new version with an **Update** button. If an update misbehaves, **More → Health → Go back to** returns to the version before. The updater service behind both downloads that release's `docker-compose.yml` along with its images, so a release that adds a service needs nothing more than the button. It keeps the old file as `docker-compose.yml.previous`, and records the chosen version in `.env` as `HOMEHUB_TAG`. Running the installer replaces that with the newest release. HomeHub installed before v0.1.14 gets the updater by running the installer once.

If you installed with `git clone`, run `git pull` instead, then `docker compose -f docker-compose.yml pull` and `docker compose -f docker-compose.yml up -d`. To build HomeHub from source, for example to try your own changes, run `docker compose -f docker-compose.yml up -d --build` from the cloned folder. It takes 30–60 minutes on a Raspberry Pi 4.

### Publishing images

HomeHub's images are on GitHub's registry, `ghcr.io/foodisready/homehub-*`, for Raspberry Pi and for PCs. Anyone can download them without an account.

To publish a release, push a version tag:

```bash
git tag v1.2.0 && git push origin v1.2.0
```

GitHub Actions builds the four images, publishes them tagged with the version, the commit and `latest`, then creates the GitHub Release. HomeHub's **Update** card offers a new version once its Release exists, so the images are always ready first. To try a build on a Pi without releasing it, run **Release images** by hand in the repo's **Actions** tab, then set `HOMEHUB_TAG` to the commit, such as `1d04500`, in the Pi's `.env`.

`scripts/release-images.sh` builds and pushes from your own computer instead, after `docker login ghcr.io`. To publish under another account, set `HOMEHUB_IMAGE_PREFIX`, such as `ghcr.io/yourname`, both when publishing and in the Pi's `.env`.

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
| 5353 (UDP) | The homehub.local name, shared with the Pi's own `.local` name |
| 3001 | AI assistant connection (MCP) |
| 3002 | Scheduler |
| 8080 | Self-update helper (Watchtower) |
| 8081 | Updater, which updates HomeHub and can go back a version. Only HomeHub itself can reach it. |
| 11434 | Local AI model |
| 5080 | Wyze camera bridge. Reachable on your network, but only with HomeHub's key. |
| 1984, 8554 | The camera bridge's video. Only HomeHub itself can reach these. |

Don't forward these ports through your router. For access away from home, use [Remote Access](./REMOTE_ACCESS.md).

## Problems during install

**HomeHub asks you to sign in, but you never made an account:** someone else on your network created it first. On a new install, start again with `docker compose -f docker-compose.yml down -v`, then the start command. `-v` deletes all of HomeHub's data, so don't use it once you've set HomeHub up.

**`Cannot start — required environment variables are missing`:** HomeHub couldn't save its secrets in its data volume. Check the backend logs, and that the disk isn't full.

**`permission denied` when running Docker:** log out and back in after installing, so your user can run Docker without `sudo`.

**homehub.local doesn't open:** some phones, especially Android ones, and some networks don't support `.local` names. Use the Pi's IP address instead, and bookmark it.

**The website doesn't load:** run the status command. If `backend` isn't running, check its logs. It waits for the AI model service, so give it a few more minutes on the first start.

**Chat is slow:** a Pi has no strong graphics chip, so requests that need the AI model can be slow. Simple commands such as "turn on the porch light" don't use the model.
