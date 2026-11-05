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
| **Any Matter brand** | Plugs, lights, switches and power strips (on and off) | Shared from Google Home, Apple Home, Alexa or SmartThings. See [Matter devices](#matter-devices) |

Zigbee devices aren't supported. "Works with Google or Alexa" on a box doesn't mean it works with HomeHub, but the **Matter** logo does.

For what to buy, model by model, and which ones have been tested, see [Works with HomeHub](./DEVICES.md).

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

### Matter devices

Matter is the common standard behind the Matter logo on boxes. A Matter device can work with several apps at once, so you share it with HomeHub from the app it's already in, and it stays there too. HomeHub then controls it directly on your network, without the cloud, and sees changes straight away, even from a wall switch or another app.

1. Add the device to Google Home, Apple Home, Alexa or SmartThings first, using the code on the device or its box. HomeHub can't do this step itself, because new devices join Wi-Fi over Bluetooth.
2. In that app, share the device. For example, in Google Home open the device's settings, then **Linked Matter apps & services → Link apps & services**. The app shows a pairing code.
3. In HomeHub, open **Settings → Devices → + Add a Matter device**, enter the code within a few minutes, and select **Add device**.

Each part that switches on and off becomes its own device: a plug is one, and a power strip with four outlets is four. Rename them and pick rooms like any other device. Schedules, scenes, timers, Chat and voice all work with them. HomeHub switches Matter devices on and off; dimming and colour aren't supported yet.

Deleting a Matter device from HomeHub also unpairs it from HomeHub. It stays in your other apps.

Thread devices work too, as long as you have a Thread border router, such as a Google Nest Hub, an Apple TV or HomePod, or an Echo 4th generation.

HomeHub keeps its Matter pairings in its database, so backups include them and a restore brings them back. Keep backups private: they hold HomeHub's Matter keys.

## Cameras

HomeHub can show Wyze cameras live, pause them while you're home, and save snapshots from them. It works through the camera bridge, a service that comes with HomeHub, and needs a free Wyze developer API key.

### Add your cameras

1. Create an API key at the [Wyze developer console](https://developer-api-console.wyze.com/), signed in with your Wyze account. Keep the key and its ID handy.
2. Open **Cameras** (under **More** on a phone), and sign in with your Wyze email, password, API key ID and API key. The camera bridge restarts with your account, which takes up to a minute.
3. Select **Add** next to each camera, or **Add all**. Then give each one a room in **Settings → Devices**.

HomeHub keeps your Wyze sign-in on the HomeHub computer, in its data folder, where only the camera bridge reads it. It's needed again whenever the bridge restarts. **Sign out of Wyze**, at the bottom of the Cameras page, deletes it and stops the bridge.

If your Wyze account uses two-step verification, the bridge can't sign in yet; turn it off in the Wyze app first.

The cameras need to be on the same network as the HomeHub computer. A camera on another network, such as a second router's Wi-Fi, appears but shows no picture.

### Turn cameras off

No Wyze cameras? Select **Turn cameras off** on the Cameras page, or clear **Wyze cameras** under **Settings → Integrations**. Cameras disappears from the menu. Turn it back on in the same place.

Until someone signs in to Wyze, the camera bridge waits and uses almost no memory. To leave it out of HomeHub entirely, set `HOMEHUB_CAMERA_BRIDGE=0` in `.env` and run `docker compose -f docker-compose.yml up -d`. Remove the line and run the command again to bring it back.

### Watch, pause and resume

On the **Cameras** page, select a camera's picture or **Live** to watch. Live video can be a few seconds behind, and starts with the sound off; the 🔇 button turns it on.

To zoom, pinch or double-tap on a phone, or scroll, double-click or press **+** and **−** on a computer. Drag to look around while zoomed, and double-tap or press **0** to see the whole picture again. Zoom enlarges the picture, as in the Wyze app; it doesn't turn the camera.

A **Pan** camera, such as the Pan v3, also gets arrows to turn the camera itself. Hold an arrow to keep turning and let go to stop; a tap turns it a little. On a computer, the arrow keys do the same. On a phone held upright the arrows sit under the picture, and over it when the phone is turned sideways or in full screen. If you close live view or lose the connection while an arrow is held, HomeHub stops the camera within 2 seconds. The camera turns 0–355° across and stops by itself at either end. If its own motion tracking is on in the Wyze app, it may turn away again to follow movement.

Each camera shows **Watching** only while its pictures actually arrive. **No picture** means HomeHub couldn't get one twice in a row, with the likely reason: the camera isn't on HomeHub's network (it may have joined another Wi-Fi, or another device may be using its address), or it's on the network but not sending video. In that second case HomeHub reconnects to it by itself, at most every 10 minutes. **More → Health** also mentions a camera with no picture for 10 minutes.

**Pause** turns a camera off with Wyze's own switch, the same one as in the Wyze app, and asks you to confirm. A paused camera doesn't stream, record or detect motion, and a Pan v3 tucks its lens away. It stays on Wi-Fi, so **Resume** turns it back on; its picture returns within about 15 seconds. A camera works like any other device, so you can also pause or resume it from the dashboard, a scene or a schedule. For example, make an "I'm home" scene that pauses your cameras and a "Leaving" scene that resumes them.

Cameras are protected: Chat and voice can resume a camera but can't pause one.

HomeHub switches cameras through your Wyze account, using the sign-in you saved, so it needs the internet.

### Snapshots

Select **Snapshot** to save a picture yourself. Snapshots appear on the **Cameras** page, newest first, and you can filter them by camera. They're saved as JPG files in HomeHub's data folder, under `snapshots/<camera>/<date>/`, and deleted after 30 days, which administrators can change at the bottom of the page.

Snapshots are history, so JSON backups leave them out. The install guide's full backup copies them.

### Motion snapshots

When a camera sees motion, Wyze reports it to your account, and HomeHub saves a picture from the camera, usually 5 to 15 seconds later. Snapshots from motion are marked **motion**. HomeHub checks for motion every 10 seconds, which uses a small part of what Wyze allows your account; the Wyze app shares the same allowance.

Administrators can change these settings at the bottom of the Cameras page:

- **Save a snapshot on motion:** on by default.
- **Notify my phone:** sends a notification with each motion snapshot, saying what Wyze saw, such as "a person" or "a pet".
- **Wait between snapshots:** 30 seconds by default, so one visit doesn't fill the folder.

Paused cameras don't report motion. Motion follows the camera's own detection settings in the Wyze app, such as its sensitivity and detection zones.

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

If more than one applies, it shows whichever comes first. Garage doors say "Closes in".

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

"**Room** lights" or "**room** lamps", such as "turn on Brenden's lights", switches the lights in that room. A room also answers to its name without "room", so "Brenden's" means "Brenden's room". Protected devices, and ones named as something else, such as a fan or TV, are left out. A nickname that matches the words wins.

### Teach HomeHub what you meant

When Chat or voice doesn't understand a command, it's listed under **Settings → Teach HomeHub** (administrators only). Select **Teach**, check the words, then choose the devices or the scene you meant and select **Save**. HomeHub saves the words as a nickname for those devices, or as another name for the scene, so the same command works next time, in Chat and by voice. Select **Ignore** for anything that isn't a command, such as a question.

HomeHub refuses words it would still read some other way, for example another device's name or a room's name, and says why.

### Choose what HomeHub says back

**Settings → Voice replies** (administrators only) sets what voice and Chat say after a command: turning something on or off, turning on with a timer, running a scene, and not understanding. Tick the built-in replies you like, in Plain, Friendly or Funny style, or use **Start from** to tick a whole style at once. Type your own under any of them and select **Add**; **▶** plays a reply with example names. HomeHub picks one ticked reply at random each time. Select **Save replies** when you're done.

Your own replies can use `{device}`, `{minutes}` and `{scene}`, and must include the device or scene, so you always hear what changed. Garage doors, cameras and valves always get a plain confirmation.

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
4. Press the sensor's button to wake it. A new rule searches for sensors straight away; for an existing one, select **Connect sensor**, then **Find sensors**.
5. Pick your sensor from the list. HomeHub fills in its address, and the username `admin` if it has a login. Enter its password if it has one, then select **Connect**. If the sensor isn't listed, press its button and search again, or type its address.

A sensor already used by another rule is marked. Picking it moves it to this rule.

**+ Discover on network** in Settings leaves sensors out, since they have nothing to switch.
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

## Pause automations

This is for developers. If you run a development copy of HomeHub against the same devices as your main one, pause automations on it so the two don't undo each other. On the development copy, open **Settings → Preferences** and select **Pause automations** (administrators only). The option doesn't appear on HomeHubs installed from a release, unless one is already paused.

While paused, that HomeHub runs no schedules, motion rules, "Turn off after" timers or automatic water shutoff. You can still switch devices by hand, use Chat and run scenes. A banner on every page says it's paused, with a **Resume** button. Timers that ran out while paused end without switching anything.

Don't pause your main HomeHub for long: automatic water shutoff is off while paused. The setting isn't included in backups, so restoring a backup never pauses or resumes a HomeHub.

Motion sensors report to one HomeHub only, the one they were last connected to on the **Sensors** page. Connect them to your main HomeHub.

## Home location and time zone

The guided setup asks for your town and sets both for you. To change them later, open **Settings → Home**, or select **Run the guided setup again** there.

- **Time zone:** clock-time schedules, timers and every time HomeHub shows use it. **Use** sets it to the time zone of the phone or computer you're using.
- **Location:** sunrise and sunset schedules use it. In Google Maps, right-click your home and select the numbers at the top, then paste both into the first box. On an `https` address, such as through Tailscale, **Use this device's location** fills them in.

After you save, the page shows today's sunrise and sunset, so you can check they look right. Schedules change straight away, without a restart.

## AI assistant

An AI app such as Claude Desktop can see and switch your devices through HomeHub's MCP server. In **Settings → Integrations → AI assistant (MCP)**, select **Show secret** and give the app the address and secret shown. See [Connecting an AI assistant](./mcp-connection.md) for the app's settings.

Anyone with the secret can control every device, so share it only with apps you trust.

## Household members

The easiest way to add people is an invite. In **Settings → Users**, select **Show an invite code**. Each person scans the QR code with their phone's camera, chooses their own name and password, and is signed in. HomeHub then shows them how to add it to their home screen.

- An invite works for up to 10 people for 24 hours. **Cancel this invite** stops it straight away.
- Invited people get family logins, never administrator ones.
- Open HomeHub at its network address, such as `http://homehub.local:4200`, before showing the code. A code made on `localhost` points phones at an address they can't reach, and HomeHub warns you.

You can also add someone by typing a name and password under **Settings → Users**.

Everyone can switch devices and set timers. Only administrators can add, edit or remove devices, or change settings.

Settings sections fold away. Select a section's name to open or close it. Devices starts open, and HomeHub remembers your choice on each browser.

## Remote access

To reach HomeHub away from home, set up [Remote Access](./REMOTE_ACCESS.md). Don't forward ports on your router.

**QR code** gives you a quick way to open HomeHub on your phone. On a computer, it's at the top right. On a phone, it's under **More**.

## Health

**More → Health** shows whether HomeHub is working, in plain words: its services, devices that aren't responding, voice speakers, the nightly backup, disk space and the computer's temperature. Anything that needs a look comes first, with what to do about it. Admins also see a notice on the Home page when something does.

### Go back a version

If something stopped working after an update, open **Health**, and under **Version** select **Go back to** the version HomeHub ran before. HomeHub saves a copy of its database, switches back and restarts, which takes a minute or two. Your devices, schedules and settings stay. When a fixed version is out, the Update card on the Home page offers it as usual.

If Health says to run the installer once more, your HomeHub was installed before going back was possible: run the installer again on the HomeHub computer, and the option appears.

## Voice control

Say a command to a speaker or tablet, and HomeHub does it and answers, with no cloud. It needs the [voice bridge](../packages/voice-bridge/README.md) running on an always-on computer, such as the one HomeHub runs on, and a voice speaker such as the Ava app on an Android tablet. Its speakers appear under **Health**. See the [voice control plan](./VOICE_CONTROL.md) for what's still to come.

## Troubleshooting

**A device shows as offline:** check that it has power and is on Wi-Fi. Its address may also have changed. Run **Discover on network**, and if it's listed as moved, select **Update address**. Don't add it as a new device, or you'll lose its schedules.

**Discover doesn't find a device:** run it again, because a scan can miss devices. Make sure HomeHub is on the same network as the device, then try adding it by IP address.

**A Kasa plug says the email or password was rejected:** see [Kasa plugs](#kasa-plugs). This can happen even with the right password.

**The motion sensor says it can't be reached:** press its button to wake it, then try again. It can take up to a minute to respond.

**A motion rule says it's waiting for the first report:** select **Connect sensor** and wait for "Sensor connected", then wave at it. It ignores new motion for a short time after each report.

**The Cameras page says it can't reach the bridge:** the bridge can take a minute to start. Check it's running with `docker compose -f docker-compose.yml ps wyze-bridge`, and that `.env` doesn't set `HOMEHUB_CAMERA_BRIDGE=0`. `docker compose -f docker-compose.yml logs wyze-bridge` shows what it's doing.

**Wyze sign-in didn't work:** check the email, password, API key ID and API key, then sign in again. Wyze also limits how often an account can sign in, so after several tries, wait a few minutes.

**A camera shows no picture:** the card says why. A camera HomeHub can't find on its network needs to be back on the same Wi-Fi as HomeHub; check its Wi-Fi in the Wyze app (**Settings → Device Info**), and that no other device has its address. One that's on the network but sends nothing usually recovers after HomeHub reconnects to it; if not, unplug it for 10 seconds.

**A schedule runs at the wrong time:** check the time zone in **Settings → Home**. Sunrise and sunset schedules also need your home's location there. **Settings → Home** shows today's sunrise and sunset, so you can check them.

**Chat doesn't understand a command:** use a device's full name, or add a nickname. Commands that need the AI model can be slow on a Pi.
