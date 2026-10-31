# Tailscale Setup Guide

This guide walks through reaching HomeHub securely from anywhere using Tailscale, from creating an account to keeping it connected on a Mac and an Android phone.

For the Docker sidecar and self-hosted Headscale options, see [REMOTE_ACCESS.md](REMOTE_ACCESS.md).

## Contents

1. [How it works](#how-it-works)
2. [Before you start](#before-you-start)
3. [Create an account or sign in](#1-create-an-account-or-sign-in)
4. [Set up the Mac running HomeHub](#2-set-up-the-mac-running-homehub)
5. [Set up an Android phone](#3-set-up-an-android-phone)
6. [Set up an iPhone](#4-set-up-an-iphone)
7. [Test remote access](#5-test-remote-access)
8. [Turn on HTTPS](#6-turn-on-https)
9. [Add family members and more devices](#7-add-family-members-and-more-devices)
10. [Moving HomeHub to a Raspberry Pi](#8-moving-homehub-to-a-raspberry-pi)
11. [Everyday checklist](#everyday-checklist)
12. [Troubleshooting](#troubleshooting)
13. [Security notes](#security-notes)
14. [Removing a device](#removing-a-device)

## How it works

Tailscale creates a private network, called a *tailnet*, between devices signed in to the same account. HomeHub stays off the public internet: no router ports are opened, and only devices on your tailnet can reach it.

Every device gets a private address starting with `100.`, which works at home and away. Traffic is encrypted between devices, including over plain `http://` addresses.

HomeHub's own login still applies. Tailscale controls who can reach the app, and HomeHub controls who can use it.

## Before you start

You need:

- A computer running HomeHub. This guide uses a Mac, and the Raspberry Pi route is in [section 8](#8-moving-homehub-to-a-raspberry-pi).
- A Google, Microsoft, GitHub or Apple account to sign in with. Tailscale has no separate password.
- An administrator password for the Mac.
- A phone with internet access.

Tailscale has offered a free personal plan. Check [tailscale.com/pricing](https://tailscale.com/pricing) for current limits.

**Use one account for all your devices.** Devices on different accounts can't see each other unless you share them.

## 1. Create an account or sign in

**If you've used Tailscale before**, sign in with that same login. Your old devices will still be listed. That's normal and they do no harm.

**If you're new:**

1. Go to [login.tailscale.com/start](https://login.tailscale.com/start).
2. Choose your sign-in provider and approve it.
3. Finish the short welcome steps.

Your tailnet is created automatically. Pick a login you'll keep long term, as moving devices between accounts is extra work.

## 2. Set up the Mac running HomeHub

### Install the app

Run this in Terminal or iTerm and enter your Mac password when asked:

```sh
brew install --cask tailscale-app
open -a Tailscale
```

Without Homebrew, download the app from [tailscale.com/download](https://tailscale.com/download).

> The install needs your password, so run it in a normal terminal window. Tools without an interactive password prompt will fail with `sudo: a password is required`.

### Enable the network extension

This step is required. If it's skipped, the buttons in the Tailscale app appear to do nothing.

1. Open **System Settings → General → Login Items & Extensions**.
2. Scroll down to **Extensions**.
3. Click the **ⓘ** next to **Network Extensions**.
4. Turn on **Tailscale**, then click **Done**.
5. Quit and reopen Tailscale:

   ```sh
   killall Tailscale
   open -a Tailscale
   ```

6. If macOS asks to allow a VPN configuration, click **Allow**.

To check it from a terminal:

```sh
systemextensionsctl list | grep -i tailscale   # should end in [activated enabled]
scutil --nc status Tailscale | head -1         # should say Connected once signed in
```

### Sign in

1. In the Tailscale window, click **Sign in to your network**.
2. Approve the device in your browser.
3. Go through the remaining setup screens.

The status should change to **Connected**. The **Start at login** toggle on the setup screen may refuse to turn on. You can skip it and use the next step.

### Start automatically at login

1. Open **System Settings → General → Login Items & Extensions**.
2. Scroll to the **very top**, to the **Open at Login** list.
3. Click **+**, choose **Applications → Tailscale**, and click **Open**.

To check it:

```sh
osascript -e 'tell application "System Events" to get the name of every login item'
```

### Keep the Mac available

The phone can only reach HomeHub while the Mac is awake and its servers are running.

- In **System Settings → Energy**, set the Mac to stay awake, or use `caffeinate -s` in a terminal.
- Make sure you're logged in after a restart, or Tailscale won't start.
- Start HomeHub again after a restart:

  ```sh
  # Terminal 1
  cd packages/backend && npm run dev

  # Terminal 2
  cd packages/frontend && npm start
  ```

### Find the Mac's address

Open the Tailscale app, or run:

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4
```

Note this address. You'll use it in place of `<mac-tailscale-ip>` below.

## 3. Set up an Android phone

These steps were written for a Google Pixel. Menu names can vary on other phones.

### Install and sign in

1. Turn off any other VPN first, including **VPN by Google** and ad-blocking VPNs. Android runs only one VPN at a time.
2. Install **Tailscale** from the Play Store.
3. Open it and sign in with the **same account** as the Mac.
4. Tap **OK** on the VPN connection request.
5. Check that the switch is on and your Mac appears in the device list.

### Turn on Always-on VPN

This reconnects Tailscale automatically after a restart.

1. Open **Settings → Network & internet → VPN**. If it isn't there, search Settings for "VPN".
2. Tap the **gear icon** next to **Tailscale**.
3. Turn on **Always-on VPN**.
4. Leave **Block connections without VPN** **off**. With it on, you lose all internet whenever Tailscale is down.

### Stop Android from pausing it

1. Open **Settings → Apps → Tailscale → App battery usage**.
2. Choose **Unrestricted**.

### Add a home screen icon

1. Open HomeHub in your browser.
2. Open the browser menu and tap **Add to Home screen**.

If you later switch to the HTTPS address, replace this icon.

### Choose a browser

If Chrome shows **This site can't be reached** while the Mac is fine, try Brave or Firefox. On one tested Pixel, Chrome wouldn't connect to a local address while Brave worked, and no request ever reached the Mac. See [Troubleshooting](#chrome-on-android-cant-reach-homehub).

## 4. Set up an iPhone

1. Install **Tailscale** from the App Store.
2. Sign in with the **same account** as the Mac.
3. Tap **Allow** when iOS asks to add a VPN configuration.
4. Turn the switch on and check that your Mac is listed.
5. Open **Settings → Privacy & Security → Local Network** and turn on your browser, if it's listed.

To stay connected, open Tailscale's settings and turn on **VPN On Demand**, if your version offers it.

## 5. Test remote access

1. On the phone, make sure Tailscale is on.
2. **Turn Wi-Fi off** so it uses mobile data.
3. Open this address, using the Mac's address from section 2:

   ```text
   http://<mac-tailscale-ip>:4201
   ```

4. Log in to HomeHub and check that your devices appear.

If that works, remote access is working. Port `4201` is the frontend's development port. A Docker deployment uses `4200`.

To check the connection from the Mac:

```sh
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
$TS status
$TS ping <phone-tailscale-ip>
```

## 6. Turn on HTTPS

HTTPS gives HomeHub a friendlier address and is required in production, where login cookies are marked `secure`.

### Check whether it's already on

From the Mac:

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale status --json | grep -E 'MagicDNSEnabled|CertDomains' -A1
```

- `"MagicDNSEnabled": true` means MagicDNS is on.
- `CertDomains` listing your machine's `.ts.net` name means HTTPS certificates are on. `null` means they're off.

You can also check in your browser on the [DNS page](https://login.tailscale.com/admin/dns).

### Turn it on

1. Open the [DNS page](https://login.tailscale.com/admin/dns).
2. Under **MagicDNS**, click **Enable MagicDNS**.
3. Under **HTTPS Certificates**, click **Enable HTTPS** and confirm.

Certificate details are recorded in public logs, so your machine name and tailnet name become publicly visible. Your device and its traffic stay private, but rename anything you wouldn't want seen. Your tailnet name is on the same page.

### Serve HomeHub over HTTPS

On the Mac:

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 4201
```

Then open the address it prints on your phone:

```text
https://<machine-name>.<tailnet-name>.ts.net
```

The first load can take several seconds while the certificate is issued. The setting survives restarts. To stop it:

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --https=443 off
```

### Allow the address on the dev server

The Angular dev server rejects hostnames it doesn't recognize. `packages/frontend/angular.json` already allows Tailscale addresses, and the leading dot covers every `.ts.net` name:

```json
"allowedHosts": [".ts.net"]
```

If you pulled this change while `npm start` was running, restart it. Production builds don't need this.

> **Avoid Tailscale Funnel.** `tailscale funnel` makes a service public on the internet. Use `tailscale serve`, which stays private to your tailnet.

## 7. Add family members and more devices

### Your own extra devices

Install Tailscale on the device and sign in with the same account.

### Other people

Choose one:

- **Invite them to your tailnet:** on the [Users page](https://login.tailscale.com/admin/users), invite them, and they sign in with their own account. Check your plan's user limit first.
- **Share only the HomeHub machine:** on the [Machines page](https://login.tailscale.com/admin/machines), open the machine's menu and choose **Share**. They can reach that machine from their own tailnet, and nothing else on yours.

Then create a HomeHub account for them under **Settings → Users**, with the member role unless they need admin access.

They need to repeat the phone setup: install, sign in, Always-on VPN and battery settings.

## 8. Moving HomeHub to a Raspberry Pi

Use the **same Tailscale account**. The Pi joins as another device, and your phones need no changes other than a new address.

1. Create an auth key on the [Keys page](https://login.tailscale.com/admin/settings/keys).
2. Define the tag in your [access controls](https://login.tailscale.com/admin/acls), because `docker-compose.yml` advertises `tag:homehub`:

   ```json
   "tagOwners": { "tag:homehub": ["autogroup:admin"] }
   ```

3. Put the key in `.env` as `TS_AUTHKEY`.
4. Start the sidecar:

   ```sh
   docker compose --profile remote-access up -d
   ```

5. Set up HTTPS with `tailscale serve`, as production cookies don't work over plain `http://`. The `docker-compose.yml` sidecar doesn't do this yet and needs extra configuration, including a route from the sidecar to the frontend.
6. Update bookmarks and home screen icons. The address becomes `https://homehub.<tailnet-name>.ts.net`.
7. Remove the Mac from the tailnet if it no longer needs access.

Devices on a *different* Tailscale account won't appear as normal members. Add them to this account, or share them.

## Everyday checklist

If HomeHub won't load, check in this order:

- [ ] Tailscale is **on** on the phone.
- [ ] The Mac is awake, logged in, and Tailscale shows **Connected**.
- [ ] The backend is running, shown by `curl http://localhost:3300/health`.
- [ ] The frontend is running on port `4201`.

## Troubleshooting

### Tailscale's buttons do nothing on the Mac

The network extension is probably off. Run:

```sh
systemextensionsctl list | grep -i tailscale
```

If it says `activated disabled`, follow [Enable the network extension](#enable-the-network-extension). Restart the Mac if the switch won't stay on.

The `Tailscale` command can also hang while the extension is off, so fix the extension first.

### "Start at login" won't turn on

Skip it during setup and use [Start automatically at login](#start-automatically-at-login).

### The phone shows "This site can't be reached"

Work through these in order:

1. Check that the Mac and both servers are running.
2. Check that Tailscale is on, on the phone.
3. Turn off any other VPN on the phone.
4. Try another browser.
5. Test the phone's route to the Mac:

   ```sh
   sudo tcpdump -i en1 -n -c 20 'tcp port 4201'
   ```

   Replace `en1` with your network interface, then reload the page on the phone. Use the Tailscale interface, shown as `utun` in `ifconfig`, when testing over Tailscale. If nothing appears, the request isn't reaching the Mac, so the cause is on the phone or network.

   `sudo` needs a normal terminal window.

### Chrome on Android can't reach HomeHub

If another browser works, HomeHub and your network are fine. Try these in Chrome:

1. Open **Settings → Apps → Chrome → Permissions** and allow **Nearby devices** or **Local network**, if listed.
2. Open `chrome://net-internals/#sockets` and tap **Flush socket pools**.
3. Open `chrome://net-internals/#dns` and tap **Clear host cache**.
4. Force-stop Chrome and reopen it.
5. Type the full `http://` address in an Incognito tab.

If it still fails, note the error code under the message, or keep using the working browser. The exact cause on the tested Pixel wasn't confirmed.

### The frontend log shows `ECONNREFUSED`

The frontend is running but the backend isn't. Check the backend terminal and restart it.

### "Blocked request" or "host not allowed"

The dev server doesn't recognize the address. Follow [Allow the address on the dev server](#allow-the-address-on-the-dev-server).

### The `.ts.net` address doesn't load

- Check that MagicDNS and HTTPS Certificates are both on.
- Check that `tailscale serve status` shows your port.
- Wait a minute on the first visit, while the certificate is issued.
- Turn Tailscale off and on again on the phone.

### Login fails or you keep being logged out

Over plain `http://` in production, browsers won't send `secure` cookies. Use the HTTPS address.

### Devices show as unreachable in HomeHub

That's a separate problem from Tailscale, and it's between the Mac and your smart devices.

- **Check Local Network access on macOS.** Open **System Settings → Privacy & Security → Local Network** and turn on the app you start the backend from, such as iTerm or VS Code. Quit that app and start the backend again.
- **Check for changed IP addresses.** Routers can reassign addresses. Update the device under **Settings → Devices → Edit**, and set DHCP reservations on your router.

## Security notes

- **Don't expose HomeHub publicly.** Some routes rely on LAN trust, and it can control real hardware, including water shutoff valves. Login rate limiting slows password guessing, but it doesn't make public exposure safe.
- **Don't forward router ports** to HomeHub.
- **Anyone on your tailnet can reach exposed ports** on the Mac, including the development backend. Only add people you trust, or restrict access with [Tailscale access controls](https://login.tailscale.com/admin/acls).
- **Use a strong HomeHub password**, and change the default admin password.
- **Treat auth keys like passwords.** Never commit them, and rotate them periodically.
- **Remove lost phones** from the tailnet right away.

## Removing a device

1. Open the [Machines page](https://login.tailscale.com/admin/machines).
2. Open the device's **⋯** menu and choose **Remove**.

To remove Tailscale from a Mac:

```sh
killall Tailscale
brew uninstall --cask tailscale-app
```

Then remove any leftover entry under **System Settings → General → Login Items & Extensions**.
