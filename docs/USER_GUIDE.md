# HomeHub User Guide

This guide covers everyday use, from adding devices to automating your lights. To install HomeHub first, see the [install guide](./INSTALL.md).

## Devices HomeHub supports

HomeHub controls devices directly over your home network. All of them are switched on and off, and it doesn't support dimming or color.

| Brand | Works with | Notes |
|---|---|---|
| **TP-Link Kasa** | Smart plugs | Set up in the Kasa app first |
| **Shelly** | Wi-Fi relays and switches | Generation 1 and 2 |
| **Shelly Motion** | First-generation motion sensor | Used by motion lights |
| **Tuya** | Wi-Fi smart plugs | Needs a Device ID and Local Key |
| **Meross** | MSG100 and MSG200 garage door openers | Needs a one-time Meross sign-in |
| **Wyze** | Cameras, such as Cam v2, v3 and Pan v3 | Needs the camera bridge and a Wyze API key. See [Cameras](#cameras) |

Zigbee and Philips Hue devices aren't supported. "Works with Google or Alexa" on a box doesn't mean it works with HomeHub, so check the brand first.

## Add a device

Set up every device in its own app first, so it's on your home Wi-Fi. Then:

1. Open **Settings → Devices**.
2. Select **+ Discover on network**.
3. Tick the devices you want, and give each a clear name.
4. Select **Register Selected**.

If a device isn't found, type its IP address in the add form, select **Probe**, then **Add**.

Settings lists your devices by room, with **Unassigned** at the top, since those are the ones still to set up. Rooms start folded, except Unassigned. Select a room's name to open or fold it, and HomeHub remembers your choice on each browser. Searching or filtering shows every match, even in folded rooms.

### Devices on another Wi-Fi network

Some homes have a second Wi-Fi network, such as a garage access point with its own router. Discover only searches HomeHub's own network at first. To search another one:

1. Under **Discover on network**, select **Devices on another Wi-Fi network?**
2. Add the other network, such as `192.168.1.x`, or tap one of the common networks. You'll find a device's address in its app, and `192.168.1.20` is on `192.168.1.x`.
3. Select **Discover on network** again.

This works when HomeHub's router is plugged into the router that runs the other Wi-Fi. It can't work the other way round: a second router plugged into your main network blocks HomeHub from reaching the devices behind it. To fix that:

- **Best:** set the other router or access point to **bridge** or **access point mode**, so its devices join your main network.
- Move the device to your main Wi-Fi, if it can connect.
- As a last resort, forward port 80 on the other router to the device, and add the router's address. Only do this on a router inside your home, never on the one connected to the internet.

You can always add a device by its IP address with **Probe**.

Reserve each device's address in your router's settings, so it doesn't change.

### Kasa plugs

Most Kasa plugs appear in Discover without a login. Newer ones can stay locked at first, and show fields for your TP-Link email and password.

If a plug rejects a correct login, or you'd rather not enter one:

1. In the Kasa app, open **Me → Third-Party Services**.
2. Turn on **Third-Party Compatibility**.
3. Unplug the plug for 10 seconds, plug it back in, and wait a minute.
4. Run **Discover on network** again.

If it's still locked, remove the plug from the Kasa app and set it up again.

HomeHub saves one TP-Link login for all your Kasa plugs, stored as a hash rather than the password. If you change your TP-Link password, select **Edit** on one of these plugs and enter the new one.

### Shelly devices

If a Shelly is password-protected, Discover shows **Username** and **Password** fields. To change them later, select **Edit** on the device. A saved password is never shown, so leave the field blank to keep it, or clear the username to remove the login. Shelly needs the real password, so it's stored unencrypted in HomeHub's database, but it isn't sent to anyone's browser.

### Tuya plugs

Tuya plugs need a **Device ID** and **Local Key**. The easiest way to get them is from a free [Tuya IoT](https://iot.tuya.com) developer account:

1. Open **Settings → Integrations → Tuya Cloud** and enter your Access ID and secret.
2. Run **Discover on network**, then select **Auto-fill from Tuya Cloud**.

If you remove a plug and pair it again, its Local Key changes, so you'll need to update it in HomeHub.

### Meross garage door openers

1. Set up the opener in the Meross app, and reserve its address on your router.
2. Open **Settings → Integrations → Meross**, enter your Meross email and password, and select **Sign in**. If Meross emails you a code, enter it and sign in again.
3. Select **Discover on network**. The opener appears with the name you gave it in the Meross app.
4. Select **Register Selected**.

If Discover doesn't find it, HomeHub tells you which openers on your Meross account it couldn't reach. The opener may be on another Wi-Fi network, so see [Devices on another Wi-Fi network](#devices-on-another-wi-fi-network). You can also type its IP address and select **Probe**. The Meross app shows the address under the device's **Device info**.

HomeHub keeps only the key that Meross returns, not your password, plus a sign-in token it uses to read device names. The opener is then controlled over your home network, without the internet. The key works for every Meross device on that account.

Garage doors are always protected. The dashboard shows **Open** or **Closed** and asks you to confirm, and Chat and voice can't switch them. While the door is closing, it still shows **Open** until it's all the way down, which takes about 25 seconds to update.

## Cameras

HomeHub can show Wyze cameras live, pause them while you're home, and save a snapshot when one sees motion. It works through the camera bridge, a service that comes with HomeHub, and needs a free Wyze developer API key.

### Add your cameras

1. Create an API key at the [Wyze developer console](https://developer-api-console.wyze.com/), signed in with your Wyze account. Keep the key and its ID handy.
2. Open **Cameras** (under **More** on a phone), and sign in with your Wyze email, password, API key ID and API key. HomeHub passes these to the bridge and doesn't keep them.
3. Select **Add** next to each camera, or **Add all**. Then give each one a room in **Settings → Devices**.

Cameras on another Wi-Fi network work too, because the bridge finds them through your Wyze account.

### Turn cameras off

No Wyze cameras? Select **Turn cameras off** on the Cameras page, or clear **Wyze cameras** under **Settings → Integrations**. Cameras disappears from the menu and HomeHub stops watching for motion. Turn it back on in the same place.

The bridge itself keeps running, idle, using about 90 MB of memory. To leave it out of HomeHub entirely, set `HOMEHUB_CAMERA_BRIDGE=0` in `.env` and run `docker compose -f docker-compose.yml up -d`. Remove the line and run the command again to bring it back.

### Watch, pause and resume

On the **Cameras** page, select a camera's picture or **Live** to watch. Live video can be a few seconds behind.

**Pause** stops a camera watching, using Wyze's own off switch, and asks you to confirm. **Resume** turns it back on. A camera works like any other device, so you can also pause or resume it from the dashboard, a scene or a schedule. For example, make an "I'm home" scene that pauses your cameras and a "Leaving" scene that resumes them.

Cameras are protected: Chat and voice can resume a camera but can't pause one.

### Motion snapshots

When a camera reports motion through your Wyze account, HomeHub saves a picture from it. Snapshots appear on the **Cameras** page, newest first, and you can filter them by camera. They're saved as JPG files in HomeHub's data folder, under `snapshots/<camera>/<date>/`.

Administrators can change these settings at the bottom of the page:

- **Save a snapshot on motion:** on by default.
- **Notify my phone:** sends a notification with each motion snapshot.
- **Keep snapshots for:** 30 days by default. Older ones are deleted automatically.
- **Wait between snapshots:** 30 seconds by default, so one visit doesn't fill the folder.

Motion is reported through Wyze's servers, so a snapshot can come a few seconds after the motion. Paused cameras don't report motion. Select **Snapshot** on a camera to save a picture yourself at any time.

Snapshots are history, so JSON backups leave them out. The install guide's full backup copies them.

The camera bridge is unofficial, and a Wyze firmware update can stop it working until the bridge is updated.

## Control your devices

On a phone, the tabs at the bottom take you to Home, Scenes, Chat and Schedules. **More** has everything else, plus **Sign out**. On a computer, the same pages are along the top, and your name at the top right has **Sign out**.


- **Dashboard:** tap a device's switch. Tap its name or timer icon for timers and details.
- **Settings → Devices:** tap **On** or **Off** to test a light.
- **Chat:** type a command, such as "turn on the porch light".

Set up a timer in Chat by adding a time, such as "turn on my office lamp for an hour".

When something will turn a device off by itself, its dashboard row says when and why, and the timer icon turns blue:

- **"Off in 8 min · no motion":** a motion rule, counting down since the room emptied. Moving resets it.
- **"On · off 10 min after motion stops":** a motion rule waiting for the room to empty.
- **"Off in 45 min · timer":** a timer you set. In the last minute it counts seconds.
- **"Off at 9:30 PM · schedule":** a "turn off after" schedule. More than an hour away, it shows the time instead of a countdown.

If more than one applies, it shows whichever comes first. Garage doors say "Closes in" and cameras "Pauses in".

## Activity

**Activity** (under **More** on a phone) lists every device change, newest first: what changed, when, and what caused it. For example:

- "Porch turned on, by alice"
- "Kitchen lights turned on, by scene Evening, from Chat"
- "Porch turned off, by schedule Lights out, was on for 4 h 12 min"
- "Garage door opened, outside HomeHub"
- "Hall lamp went offline"

Causes include someone in the app, a scene, a schedule, a timer, a motion rule, Chat, voice, an AI assistant and automatic water shutoff. **Outside HomeHub** means a wall switch, the device's own app, or a change made while HomeHub was off. HomeHub notices those at its next check, within about a minute, and can't tell who made them.

Filter by device or cause at the top. On the dashboard, a device that's on shows when it came on, and its details panel shows its recent activity.

Activity is kept for 90 days. Administrators can change this at the bottom of the page, from 7 days to 2 years. JSON backups leave it out, since it's history.

## Rooms

Rooms keep the dashboard short. Open **Settings → Devices**, select **Edit** on a device, and enter a room. Devices with no room appear under **Unassigned**.

On the dashboard, you can collapse a room, and **All off** turns off everything in it except protected devices. Offline devices move to their own group at the bottom.

Search by device name, nickname or room, or use the **On** and **Offline** filters. The same search is in **Settings → Devices**. On a computer, press `/` to jump to search.

You can also use rooms in Chat and voice, such as "turn off the living room".

## Names and groups

Open **Settings → Devices** and select **Edit** to add nicknames, separated by commas. HomeHub recognizes them in Chat and voice commands.

To switch several devices together, give them the same nickname. If two plugs both have the nickname `living room lights`, then "turn off living room lights" switches both.

"Light" and "lamp" count as the same word if a name wouldn't otherwise match. If a name could mean more than one device, HomeHub asks which one you mean.

## Schedules

Open **Schedules** to add a time for a device. Each device has its own collapsible group, and a schedule can run:

- **At a fixed time,** such as every weekday at 7 AM
- **At a sun event,** such as 15 minutes before sunset
- **After a device turns on,** such as turning off after 10 minutes

Sun schedules need your location in `.env`.

## Scenes

A scene sets several devices at once, and each one can do something different. For example, "Goodnight" could turn off the living room but turn on the porch light.

1. Open **Scenes** and create a new scene.
2. Choose **On**, **Off** or **Skip** for each device.
3. Save it.

Run it from the Scenes page, or in Chat or voice with "run Goodnight". Chat and voice skip protected devices.

## Motion lights

Motion lights turn a light on when someone arrives, and off once the room has been empty for a set time. They need a first-generation Shelly Motion.

1. Set up the sensor on your Wi-Fi with the Shelly app or its setup page, and reserve its address on your router.
2. Open **Sensors** and go to **Motion lights**.
3. Enter a name, choose a light and set the minutes, then select **Add**.
4. Press the sensor's button to wake it, and select **Connect sensor**.
5. Enter the sensor's IP address, plus its username and password if it has one, then select **Connect**.
6. Wave at the sensor to activate the rule.

A rule does nothing until its sensor first reports. Its card shows what it's doing, including a countdown to when the light turns off. The countdown clears when the light goes off, within about a minute if you use a wall switch. Clear **Turn on when motion starts** to only turn lights off. You can edit a rule's name, light and minutes on its card, and test the light with the button next to it.

After the sensor detects motion, it ignores new motion for about a minute. If you turn the light off in HomeHub during that time, HomeHub resets the sensor so your next movement counts, usually within about 5 seconds. A wall switch can't do this, so wait about a minute before motion will turn the light back on.

A light on a keep-on timer stays on, and protected devices can't be used. If a sensor's battery runs out, HomeHub isn't told, so the light still turns off after the set time. If HomeHub moves to a new address, select **Connect sensor** again.

## Protected devices

Marking a device as protected stops Chat, voice and AI assistants from switching it, and the dashboard asks you to confirm before switching it. Open **Settings → Devices**, select **Edit**, and tick **Don't let Chat or AI assistants switch this device**.

Garage doors, devices with "valve" in their name, and devices used for automatic water shutoff are always protected. Protected devices can still be switched from their dashboard tile.

## Backups

Open **Settings → Backups** and select **Back up now**, with an optional note such as "before moving to the Pi". HomeHub saves your devices, rooms, schedules, scenes, motion rules, users and logins as a JSON file in its `data/backups` folder. Energy history isn't included.

- **View / Edit** opens the file. Passwords and keys show as `<hidden>`, and HomeHub keeps the real values when you save. Saving checks your changes against the current database first, so a mistake, such as two devices with the same name, is caught before you restore.
- **Restore** replaces your devices, rooms, schedules, scenes, motion rules and logins with the backup's. HomeHub saves your current settings as a `before-restore` backup first, so you can undo it. To leave something alone, remove its whole table from the file before restoring.

A restore never changes the accounts already on this HomeHub, so you can still sign in afterwards:

- Accounts here keep their passwords, even if the backup has an account with the same name.
- Accounts that are only in the backup are added, with their passwords and notification choices from the backup.
- Your home's location and time zone stay as they are. If they aren't set here yet, they come from the backup.

Undoing a restore doesn't remove accounts it added. Remove those under **Settings → Users**.

A restore also removes energy history for devices that aren't in the backup.

### Moving to another HomeHub

To move your setup, for example from a computer to a Raspberry Pi:

1. On the old HomeHub, select **Back up now**, then **Download** on that backup.
2. On the new HomeHub, select **Upload a backup** and choose the file. HomeHub checks it and adds it to the list without changing anything.
3. Select **Restore** on it.

Keep signing in with the account you made on the new HomeHub. Other people's accounts come across with their old passwords. A downloaded file includes passwords and device logins, so keep it private and delete it once you've moved. Motion sensors still report to the old HomeHub's address until you reconnect them on the **Sensors** page.

HomeHub also makes a full copy of its database once a day and keeps the last 7. Those include history, and you restore them from the command line.

## Home location and time zone

Open **Settings → Home** to choose your time zone and enter your home's latitude and longitude. HomeHub opens it for you after you create your account.

- **Time zone:** clock-time schedules, timers and every time HomeHub shows use it. **Use** sets it to the time zone of the phone or computer you're using.
- **Location:** sunrise and sunset schedules use it. In Google Maps, right-click your home and select the numbers at the top, then paste both into the first box. On an `https` address, such as through Tailscale, **Use this device's location** fills them in.

After you save, the page shows today's sunrise and sunset, so you can check they look right. Schedules change straight away, without a restart.

## AI assistant

An AI app such as Claude Desktop can see and switch your devices through HomeHub's MCP server. In **Settings → Integrations → AI assistant (MCP)**, select **Show secret** and give the app the address and secret shown. See [Connecting an AI assistant](./mcp-connection.md) for the app's settings.

Anyone with the secret can control every device, so share it only with apps you trust.

## Household members

Open **Settings → Users** to add people. Everyone can switch devices and set timers. Only administrators can add, edit or remove devices, or change settings.

Settings sections fold away. Select a section's name to open or close it. Devices starts open, and HomeHub remembers your choice on each browser.

## Remote access

To reach HomeHub away from home, set up [Remote Access](./REMOTE_ACCESS.md). Don't forward ports on your router.

**QR code** gives you a quick way to open HomeHub on your phone. On a computer, it's at the top right. On a phone, it's under **More**.

## Voice control

Voice control is experimental and isn't included in the install. The test setup works with the Ava app on an Android tablet, but its connection to HomeHub isn't packaged yet. See the [voice control plan](./VOICE_CONTROL.md).

## Troubleshooting

**A device shows as offline:** check that it has power and is on Wi-Fi. Its address may also have changed. Run **Discover on network**, and if it's listed as moved, select **Update address**. Don't add it as a new device, or you'll lose its schedules.

**Discover doesn't find a device:** run it again, because a scan can miss devices. Make sure HomeHub is on the same network as the device, then try adding it by IP address.

**A Kasa plug says the email or password was rejected:** see [Kasa plugs](#kasa-plugs). This can happen even with the right password.

**The motion sensor says it can't be reached:** press its button to wake it, then try again. It can take up to a minute to respond.

**A motion rule says it's waiting for the first report:** select **Connect sensor** and wait for "Sensor connected", then wave at it. It ignores new motion for a short time after each report.

**The Cameras page says it can't reach the bridge:** the bridge can take a minute to start. Check it's running with `docker compose -f docker-compose.yml ps wyze-bridge`, and that `.env` doesn't set `HOMEHUB_CAMERA_BRIDGE=0`.

**A camera shows no picture:** it may be paused, offline or still connecting. Wyze cameras connect to the bridge a little while after it starts.

**A schedule runs at the wrong time:** check the time zone in **Settings → Home**. Sunrise and sunset schedules also need your home's location there. **Settings → Home** shows today's sunrise and sunset, so you can check them.

**Chat doesn't understand a command:** use a device's full name, or add a nickname. Commands that need the AI model can be slow on a Pi.
