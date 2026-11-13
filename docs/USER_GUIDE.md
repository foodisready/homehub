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
| **Ring** | Doorbells and cameras: doorbell presses, motion, snapshots and live view | Through your Ring account. See [Ring doorbells and cameras](#ring-doorbells-and-cameras) |
| **IP cameras** | Reolink, Amcrest and other cameras with ONVIF or RTSP: live video, snapshots, motion snapshots and turning | Local, no cloud. See [IP cameras](#ip-cameras-reolink-amcrest-and-others) |
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

Garage doors are always protected. The dashboard shows **Open** or **Closed** and asks you to confirm. Chat and voice can close one ("close the garage door", "đóng cửa ga-ra") but never open it, since opening one by mistake leaves the house open. While the door is closing, it still shows **Open** until it's all the way down, which takes about 25 seconds to update.

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

HomeHub can show Wyze cameras live, pause them while you're home, and save snapshots from them. It works through the camera bridge, a service that comes with HomeHub, and needs a free Wyze developer API key. Ring and IP cameras are below.

The Cameras page has three tabs:

- **Cameras**: every camera, Wyze, Ring and IP, together. When something needs attention, such as Ring wanting you to sign in again or a camera on your account that isn't in HomeHub yet, a note above the cameras says so.
- **Snapshots**: saved pictures, newest first. The tab shows how many are new since you last looked.
- **Setup** (administrators): signing in to Wyze and Ring, adding cameras, and the motion and snapshot settings shared by every camera.

### Add your cameras

1. Create an API key at the [Wyze developer console](https://developer-api-console.wyze.com/), signed in with your Wyze account. Keep the key and its ID handy.
2. Open **Cameras** (under **More** on a phone), then **Setup**, select **Sign in to Wyze**, and sign in with your Wyze email, password, API key ID and API key. The camera bridge restarts with your account, which takes up to a minute.
3. Select **Add** next to each camera, or **Add all**. Then give each one a room in **Settings → Devices**.

HomeHub keeps your Wyze sign-in on the HomeHub computer, in its data folder, where only the camera bridge reads it. It's needed again whenever the bridge restarts. **Sign out of Wyze**, on the Cameras page's **Setup** tab, deletes it and stops the bridge.

If your Wyze account uses two-step verification, the bridge can't sign in yet; turn it off in the Wyze app first.

The cameras need to be on the same network as the HomeHub computer. A camera on another network, such as a second router's Wi-Fi, appears with **Other network** and no live video, because HomeHub talks to the cameras directly on its own network. Its motion pictures still arrive from Wyze. To fix it, set the camera up again in the Wyze app on the same Wi-Fi as HomeHub.

### Turn cameras off

No cameras at all? Select **Turn off** on the Cameras page's **Setup** tab, or clear **Wyze cameras** under **Settings → Integrations**. Cameras disappears from the menu. Turn it back on in the same place.

Until someone signs in to Wyze, the camera bridge waits and uses almost no memory. To leave it out of HomeHub entirely, set `HOMEHUB_CAMERA_BRIDGE=0` in `.env` and run `docker compose -f docker-compose.yml up -d`. Remove the line and run the command again to bring it back.

### Watch, pause and resume

On the **Cameras** page, select a camera's picture or **Live** to watch. Live video can be a few seconds behind, and starts with the sound off; the 🔇 button turns it on.

To zoom, pinch or double-tap on a phone, or scroll, double-click or press **+** and **−** on a computer. Drag to look around while zoomed, and double-tap or press **0** to see the whole picture again. Zoom enlarges the picture, as in the Wyze app; it doesn't turn the camera.

A **Pan** camera, such as the Pan v3, also gets arrows to turn the camera itself. Hold an arrow to keep turning and let go to stop; a tap turns it a little. On a computer, the arrow keys do the same. On a phone held upright the arrows sit under the picture, and over it when the phone is turned sideways or in full screen. If you close live view or lose the connection while an arrow is held, HomeHub stops the camera within 2 seconds. The camera turns 0–355° across and stops by itself at either end. If its own motion tracking is on in the Wyze app, it may turn away again to follow movement.

Each camera shows **Watching** only while its pictures actually arrive. **No picture** means HomeHub couldn't get one twice in a row, with the likely reason: the camera isn't on HomeHub's network (it may have joined another Wi-Fi, or another device may be using its address), or it's on the network but not sending video. In that second case HomeHub reconnects to it by itself, at most every 10 minutes. **More → Health** also mentions a camera with no picture for 10 minutes.

**Pause** turns a camera off with Wyze's own switch, the same one as in the Wyze app, and asks you to confirm. A paused camera doesn't stream, record or detect motion, and a Pan v3 tucks its lens away. It stays on Wi-Fi, so **Resume** turns it back on; its picture returns within about 15 seconds. A camera works like any other device, so you can also pause or resume it from the dashboard, a scene or a schedule. For example, make an "I'm home" scene that pauses your cameras and a "Leaving" scene that resumes them.

Cameras are protected: Chat and voice can resume a camera, but pause one only through a scene allowed to. See [Pause cameras by voice](#pause-cameras-by-voice).

HomeHub switches cameras through your Wyze account, using the sign-in you saved, so it needs the internet.

### Snapshots

Select **Snapshot** to save a picture yourself. Snapshots appear on the Cameras page's **Snapshots** tab, newest first, and you can filter them by camera. Tap one to see it full size, then swipe left for older pictures and right for newer ones; on a computer, use the arrow keys. They're saved as JPG files in HomeHub's data folder, under `snapshots/<camera>/<date>/`, and deleted after 30 days, which administrators can change on the **Setup** tab.

To send pictures to someone, open one and select **Share**, or select **Select** above the snapshots, tap the pictures you want (up to 20) and select **Share**. Your phone's own share menu opens, for Messages, email, Photos and so on. The pictures go only where you send them.

Phones share pictures only from a secure address, so **Share** needs HomeHub's `https://` address, such as the one you use away from home ([Remote Access](REMOTE_ACCESS.md)). At its plain `http://` home address, and on computers whose browser can't share, the button says **Save** instead and downloads the pictures.

Snapshots are history, so JSON backups leave them out. The install guide's full backup copies them.

### Motion snapshots

When a camera sees motion, Wyze reports it to your account, and HomeHub saves a picture from the camera, usually 5 to 15 seconds later. Snapshots from motion are marked **motion**. HomeHub checks for motion every 10 seconds, which uses a small part of what Wyze allows your account; the Wyze app shares the same allowance.

Administrators can change these settings on the Cameras page's **Setup** tab:

- **Save a snapshot on motion:** on by default.
- **Notify my phone:** sends a notification with each motion snapshot, saying what Wyze saw, such as "a person" or "a pet".
- **Wait between snapshots:** 30 seconds by default, so one visit doesn't fill the folder.

Paused cameras don't report motion. Motion follows the camera's own detection settings in the Wyze app, such as its sensitivity and detection zones.

The camera bridge is unofficial, and a Wyze firmware update can stop it working until the bridge is updated.

### Ring doorbells and cameras

HomeHub can save a picture when someone rings a Ring doorbell, notify your phone, show a Ring camera live, and turn on a light when a Ring camera sees motion. It works through your Ring account, so it needs the internet.

1. Open **Cameras**, then **Setup**, and select **Sign in to Ring**. Only an administrator can.
2. Enter your Ring email and password. Ring sends a code by text message, email or your authenticator app; enter it.
3. Select **Add** next to each doorbell or camera you want in HomeHub.

HomeHub keeps the sign-in Ring gives it, not your password, on this computer only, and leaves it out of backups. A restored backup keeps the list of Ring cameras, so after restoring you only sign in again. HomeHub appears in the Ring app as **HomeHub** under **Control Center → Authorized Client Devices**, where you can also remove it.

What happens:

- **The doorbell rings:** HomeHub saves Ring's picture of the moment, marked **doorbell**, and notifies phones that have HomeHub notifications on. Turn off **Notify my phone when the doorbell rings** in the Ring section to keep the pictures without notifications. Presses less than 15 seconds apart count once.
- **A camera sees motion:** HomeHub follows the same settings as Wyze motion: **Save a snapshot on motion**, **Notify my phone** and **Wait between snapshots**. Ring reports motion within a few seconds.
- **Snapshot** on a Ring camera saves a picture now.
- **Live** shows the camera live, with sound off until you turn it on. The video comes straight from Ring to your phone or computer, not through the HomeHub computer, so it works the same on a Raspberry Pi. It's a few seconds behind, and stops after 10 minutes, as in the Ring app; select **Try again** to keep watching. A mode in the Ring app that turns off live view turns it off here too. Watching a battery camera live drains its battery faster.

Ring's own settings still decide what counts as motion, such as its motion zones and modes. If **End-to-end encryption** is on for a camera in the Ring app, Ring shares no pictures with HomeHub; doorbell notifications still work.

While automations are paused, Ring motion does nothing, but doorbell presses still save a picture and notify you. A backup or development HomeHub doesn't connect to Ring.

If Ring stops accepting HomeHub's sign-in, **Health** says so; sign in again on the Cameras page. Ring has no official way for other apps to connect, so HomeHub uses the same unofficial library as Homebridge and Home Assistant's Ring add-on. A change at Ring can stop it working until the library is updated.

### IP cameras (Reolink, Amcrest and others)

HomeHub can show IP cameras live, save a picture when one sees motion, and turn one that turns. It talks to the camera directly on your home network, with no cloud account or subscription, so it keeps working when the internet is down. Most IP cameras work: any with **ONVIF**, such as Reolink, Amcrest, Axis, and UniFi with ONVIF turned on. A camera without ONVIF can still be added by its RTSP address, for live video and pictures but no motion.

Before you start, in the camera's own app or web page:

- Note the camera's **username and password**. These are set on the camera itself, not a cloud account.
- Turn on **ONVIF**. On a Reolink: **Settings → Network → Advanced → Server Settings**. Many Amcrest cameras have it on already.
- Make sure the camera is on the same Wi-Fi as HomeHub. HomeHub can't reach a camera on a second router's Wi-Fi.

Then, as an administrator:

1. Open **Cameras**, then **Setup**, and select **Add an IP camera**.
2. Select **Search the network** and **Use** next to your camera, or type its address, as shown in the camera's app.
3. Enter the camera's username and password, and a name if you like, then select **Add camera**.

HomeHub asks the camera where its video and pictures are and whether it turns, which takes a few seconds. If it says the camera didn't answer, check the address and that ONVIF is on. For a camera without ONVIF, select **No ONVIF? Add by RTSP address** and enter the address from its manual, which starts with `rtsp://`.

Each camera's card shows a picture that refreshes every 20 seconds, and whether HomeHub is watching it for motion:

- **Live** shows the camera live, through HomeHub, so it works over HomeHub's own address. Arrows turn a camera that turns. If live video stutters, or a phone shows nothing, select **Edit** and choose the smaller stream; full-quality streams from 4K cameras use a format some phones can't play.
- **Snapshot** saves a picture now.
- **Motion** follows the same settings as Wyze and Ring motion: **Save a snapshot on motion**, **Notify my phone** and **Wait between snapshots**. The camera's own settings decide what counts as motion. A Reolink that tells people, vehicles and animals apart says which it saw in the notification. To stop motion snapshots from one camera, select **Edit** and clear **Save a picture when it sees motion**.
- **Edit** changes the name, login, stream and motion. Leave the password blank to keep the saved one.

HomeHub keeps each camera's login on this computer and in backups, where it's hidden when a backup is viewed. Video goes through the **camera relay**, a small service HomeHub adds when you update, using about 15 MB of memory while nobody watches. While automations are paused, IP camera motion does nothing. A backup or development HomeHub doesn't watch for motion.

Motion lights can't use an IP camera as their sensor yet.

## Control your devices

On a phone, the tabs at the bottom take you to Home, Scenes, Chat and Schedules. **More** has everything else, plus **Sign out**. On a computer, the same pages are along the top, and your name at the top right has **Sign out**.


- **Dashboard:** tap a device's switch. Tap its name or timer icon for timers and details.
- **Settings → Devices:** tap **On** or **Off** to test a light.
- **Chat:** type a command, such as "turn on the porch light".

Set up a timer in Chat by adding a time, such as "turn on my office lamp for an hour".

Ask what's on, such as "which devices are on?", "which lights are off?" or "is the kitchen light on?", in Chat or by voice. HomeHub answers these itself, straight away, from the states the dashboard shows. Cameras are left out of the lists. Anything HomeHub can't answer itself goes to the AI model, which runs on the HomeHub computer and can take a minute on an older one. Under each reply, Chat shows who answered, **HomeHub** or **the AI model**, and how long it took.

When something will turn a device off by itself, its dashboard row says when and why, and the timer icon turns blue:

- **"Off at 9:12 PM · in 8 min · no motion":** a motion rule, counting down since the room emptied. Moving resets it.
- **"On · off 10 min after motion stops":** a motion rule waiting for the room to empty.
- **"Off at 10:15 PM · in 45 min · timer":** a timer you set. In the last minute it counts seconds.
- **"Off at 9:04 AM · in 17 min · schedule":** a "turn off after" schedule, such as on at sunrise for 2 hours. The countdown is from now, so it can be less than the schedule's length. More than an hour away, only the time shows.

If more than one applies, it shows whichever comes first. Garage doors say "Closes at".

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

A schedule that turns a device **on** can also turn it off again: fill in **Turn off after**, in minutes or hours (up to 24 hours), and the schedule's card reads, for example, "Sunset ON for 3 h". Leave it empty and the device stays on. While it's on, the dashboard shows when it will turn off, and **Activity** names the schedule that did it. If someone switches the device in the meantime, by hand, in Chat or by voice, the turn-off is cancelled, so a lamp you turned off early doesn't come back and one you turned back on stays on. It's kept through a restart, and a device whose time ran out while HomeHub was off turns off when it starts.

## Scenes

A scene sets several devices at once, and each one can do something different. For example, "Goodnight" could turn off the living room but turn on the porch light.

1. Open **Scenes** and create a new scene.
2. Choose **On**, **Off** or **Skip** for each device. For a camera, the choices are **Resume** and **Pause**.
3. Save it.

Run it from the Scenes page, or in Chat or voice with "run Goodnight". Chat and voice skip protected devices.

### Pause cameras by voice

Chat and voice never pause cameras on their own, because anyone who says the wake word, or a TV, could otherwise turn them off. To pause them by voice anyway, an administrator makes a scene for it:

1. Create a scene with a name a visitor wouldn't guess, such as "Pineapple time", and set each camera to **Pause**.
2. Tick **Voice may pause cameras**, then save. The box is also on the scene's card, to change later.
3. Say the scene's name: "Okay Nabu, pineapple time".

Each time voice or Chat pauses cameras, everyone with notifications on gets one, such as "Pineapple time (by voice) paused Front Door and Garage", so you'll know if someone else uses the phrase. Anyone with a HomeHub login can see scene names, and voice commands appear in **Activity**.

To resume them, say "resume the cameras" or "turn the cameras back on". Anyone can resume cameras, since that is never a risk. You can also make a second scene that resumes them.

"Pause the cameras" or "turn off the garage camera" gets "For safety, I can't pause cameras that way." The reply doesn't mention scenes.

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

A Ring doorbell or camera can be a rule's sensor too, instead of or as well as a Shelly Motion: choose it under **Ring camera** on the rule's card, after adding it on the Cameras page. Its motion counts, and so does the doorbell ringing, so a porch light can come on for whoever's at the door. Ring sends no "motion over", so the rule hears it a minute after the last motion. Ring has no light reading, so **When the room is dark** needs a Shelly Motion; use **Between sunset and sunrise** instead.

A rule does nothing until its sensor first reports. Its card shows what it's doing, including a countdown to when the light turns off. The countdown clears when the light goes off, within about a minute if you use a wall switch. Clear **Turn on when motion starts** to only turn lights off. You can edit a rule's name, light and minutes on its card, and test the light with the button next to it.

### Only when it's dark

So motion doesn't light a room that's bright already, choose when motion may turn the light on, under **Turn on when motion starts → Only**:

- **Any time:** the default.
- **When the room is dark:** the Shelly Motion measures the light each time it sees motion, and HomeHub turns the light on only below the level you choose, such as **Dark (below 100 lux)** or **Dim (below 300 lux)**. This follows the room itself, so a cloudy afternoon or closed blinds count as dark. The card shows the last reading, which helps you pick a level: wave at the sensor at a time you'd want the light, and see what it reads.
- **Between sunset and sunrise:** uses your home's location from **Settings → Home**, and follows the seasons. To start earlier and end later, add minutes, such as 30 for a room that gets dark before sunset. The card shows today's times.
- **Between set hours:** for example **17:00 until 08:00**, which runs overnight.

This only stops motion turning the light on. The light still turns off after no motion, and the wall switch, the app, scenes and voice work as usual. When motion leaves the light off, the card says why, for example "bright enough (650 lux)". If HomeHub can't read the sensor's light level, it turns the light on anyway. Motion that starts in daylight doesn't turn the light on later as the room darkens, while someone stays in it; the next motion after the sensor's one-minute rest does.

After the sensor detects motion, it ignores new motion for about a minute. If you turn the light off in HomeHub during that time, HomeHub resets the sensor so your next movement counts, usually within about 5 seconds. A wall switch can't do this, so wait about a minute before motion will turn the light back on.

A light on a keep-on timer stays on, and protected devices can't be used. If a sensor's battery runs out, HomeHub isn't told, so the light still turns off after the set time. If HomeHub moves to a new address, select **Connect sensor** again.

## Protected devices

Marking a device as protected stops Chat, voice and AI assistants from switching it, and the dashboard asks you to confirm before switching it. Open **Settings → Devices**, select **Edit**, and tick **Don't let Chat or AI assistants switch this device**.

Garage doors, devices with "valve" in their name, and devices used for automatic water shutoff are always protected. Protected devices can still be switched from their dashboard tile. Two safe directions are allowed by Chat and voice: closing a garage door, and resuming a paused camera.

## Backups

Open **Settings → Backups** and select **Back up now**, with an optional note such as "before moving to the Pi". HomeHub saves your devices, rooms, schedules, scenes, motion rules, users and logins as a JSON file in its `data/backups` folder. Energy history isn't included.

Each backup has three buttons: the pencil (**View / Edit**), the arrow (**Download**), and **⋯**, which holds **Email**, **Restore** and **Delete**.

- **View / Edit** opens the file. Passwords and keys show as `<hidden>`, and HomeHub keeps the real values when you save. Saving checks your changes against the current database first, so a mistake, such as two devices with the same name, is caught before you restore.
- **Email** sends the backup, encrypted, to the addresses your alerts go to. See [Email backups](#email-backups).
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

### Email backups

Backups are kept on the same computer as HomeHub, so they're lost if its disk fails. Emailing one keeps a copy in your inbox.

1. Set up email under **Settings → Integrations → Email alerts (SMTP)**, if you haven't already. Enter your email address first: for Gmail, Yahoo, iCloud and AOL, HomeHub fills in the server and says where to create an app password, which you use instead of your normal password. Outlook.com, Hotmail and Proton Mail addresses can't send from HomeHub, because those services don't accept passwords from apps; use one of the others to send, and your Outlook or Proton address as a recipient.
2. In **Settings → Backups**, under **Email backups**, choose a backup passphrase of at least 10 characters and type it twice. The eye button shows what you've typed. You can add a hint to help you remember it: the hint goes in each backup email, unencrypted, and shows when you restore, so HomeHub won't accept one that contains the passphrase.
3. Select **⋯ → Email** on any backup, or turn on **Email a backup every week, and after each HomeHub update**. Turning it on sends the first one straight away, so you can check it arrives.

Every emailed backup is encrypted with your passphrase, because a backup holds your device logins. HomeHub keeps only a key made from the passphrase, not the passphrase itself, and can't show it or recover it. Write it down somewhere other than HomeHub's computer: without it, an emailed backup can't be opened.

To restore an emailed backup, for example on a new computer after the old one failed:

1. Install HomeHub and open it.
2. Open **Settings → Backups**, select **Upload a backup** and choose the attached file.
3. Enter your backup passphrase, then select **Restore**.

An emailed backup has your devices, rooms, schedules, scenes, motion rules, users and device logins. It doesn't include energy history, the Wyze camera sign-in or Matter pairings, which you set up again after restoring.

Changing the passphrase doesn't change backups already emailed: they still open with the passphrase they were sent with. The passphrase and the email settings belong to this HomeHub: they aren't part of any backup, so restoring a backup never turns automatic emails on or off. Automatic emails don't send while automations are paused, so a development copy of HomeHub doesn't send its own. If an email fails, the reason shows under **Email backups**, and HomeHub tries again in 6 hours.

## More than one HomeHub

You can keep a second HomeHub, such as an old laptop, as a backup ready to take over if the main one fails. Only one HomeHub should be in charge at a time, or both run your schedules and compete for the cameras and voice speakers.

Choose each HomeHub's part in **Settings → Preferences → This server** (administrators only):

- **Active** runs everything. This is the default, so a single HomeHub needs no change.
- **Backup** is a standby copy. It runs no schedules, motion lights, timers or automatic water shutoff. Its voice and camera bridges wait, so the voice speaker and cameras stay with the active HomeHub. It answers to `homehub-backup.local` instead of `homehub.local`. It's read-only, because its settings are copied from the active HomeHub (see [Keeping the backup up to date](#keeping-the-backup-up-to-date)): you can switch devices on and off and run scenes by hand, but devices, rooms, schedules, scenes and settings are changed on the active HomeHub. Its own accounts, backups, and **This server** can still be changed, so it can always be made active. Once it's active, everything can be changed again.
- **Development** is the same as Backup, for a development copy. It answers to `homehub-dev.local`.

A banner on every page of a backup says so, with the active HomeHub's address when it can see it on your network. Your voice and camera choices, and your Wyze sign-in, are kept on a backup, ready for when it becomes active.

**To switch which HomeHub is in charge:** first make the active one a **Backup**, then make the other one **Active**. Then reconnect motion sensors on the new active HomeHub's **Sensors** page, and if the voice speaker doesn't connect within a minute, close and reopen its app. Timers that ran out while a HomeHub was a backup end without switching anything.

If two HomeHubs are active on the same network, both show a red banner with the other's address. Make one of them a backup.

### Keeping the backup up to date

A backup can copy the active HomeHub every hour, so it's ready to take over with your current devices, rooms, nicknames, schedules and scenes. You pair the two once:

1. Make the second HomeHub a **Backup**, as above.
2. On the **active** HomeHub, open **Settings → Backups** and select **Pair a backup HomeHub**. It shows a pairing code, once.
3. On the **backup**, open **Settings → Backups**, enter the code and select **Pair**. Leave the address empty if the backup has found the active HomeHub on your network; otherwise enter the active HomeHub's IP address, such as 192.168.1.20.

The backup copies straight away, then every hour when something has changed. **Settings → Backups** on the backup shows when it last copied, and why not if it couldn't; **Sync now** copies at once. The copy is restored like any backup: accounts already on the backup keep their passwords, and accounts only on the active HomeHub are added. Matter pairings, the Wyze sign-in and energy history aren't copied.

It's safe both ways. Only a backup copies, and only an active HomeHub hands out its settings, so an active HomeHub is never overwritten. If the active HomeHub is off or can't be reached, the backup keeps the copy it has, and it won't take a copy with no devices in it. The copy travels on your home network, from port 3000 on the active HomeHub, and only to a HomeHub with the code; ten wrong codes in a row make the active HomeHub refuse for ten minutes.

To stop, select **Stop syncing** on the backup, or **Unpair** on the active HomeHub. **New pairing code** on the active HomeHub replaces the old code, so a backup with the old one stops copying. When a backup becomes **Active**, it stops copying; make the other one a backup and pair them again the other way round.

The role isn't part of backups, so restoring a backup never changes which HomeHub is in charge.

## Pause automations

This is for developers. To keep a development copy out of the way for good, make it a **Development** server under [More than one HomeHub](#more-than-one-homehub) instead. If you run a development copy of HomeHub against the same devices as your main one, pause automations on it so the two don't undo each other. On the development copy, open **Settings → Preferences** and select **Pause automations** (administrators only). The option doesn't appear on HomeHubs installed from a release, unless one is already paused.

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

HomeHub checks its computer's temperature every minute, so Health also says how hot it got in the last day if that was hotter than now. On a Raspberry Pi, it also shows whether the Pi is getting enough power. Admins get a notification when the computer stays at 80 °C or more for 5 minutes, which is where a Raspberry Pi starts slowing itself down, or when a Pi reports low power. Each notification is sent at most once every 6 hours.

### Restart the voice bridge

If speakers stop answering, administrators can select **Restart voice bridge** under **Voice**. The bridge restarts when it next checks in, within a minute, and the page shows it restarting. You don't need it for new nicknames: the bridge picks those up by itself within a minute.

### Go back a version

If something stopped working after an update, open **Health**, and under **Version** select **Go back to** the version HomeHub ran before. HomeHub saves a copy of its database, switches back and restarts, which takes a minute or two. Your devices, schedules and settings stay. When a fixed version is out, the Update card on the Home page offers it as usual.

If Health says to run the installer once more, your HomeHub was installed before going back was possible: run the installer again on the HomeHub computer, and the option appears.

## Voice control

Say a command to a speaker or tablet, and HomeHub does it and answers, with no cloud. It needs a voice speaker on the same network, such as the Ava app on an Android tablet.

To turn it on, an administrator opens **Settings → Voice control**, ticks **Voice control** and saves. The first time, HomeHub downloads its speech models, about 200 MB, which takes a few minutes; the card says when it's running. Speakers on the network are found by themselves, and appear under **Health**. The [voice bridge](../packages/voice-bridge/README.md) that does this comes with HomeHub and updates with it. See the [voice control plan](./VOICE_CONTROL.md) for what's still to come.

If two speakers hear the same command, only the one that heard you loudest, usually the nearest, answers, and the command is carried out once. If a speaker wakes but hears no words, usually because something on TV or in a conversation sounded like the wake word, it stops listening without saying anything.

Voice also understands Cantonese, and answers in it. Tick **Cantonese** in **Settings → Voice control**, which downloads about 350 MB more, and give your devices Cantonese nicknames in **Settings → Devices**, such as 廚房燈. Say the verb, then the nickname: 開廚房燈, 熄廚房燈. Leave a short pause after the wake word, so the verb isn't cut off: if HomeHub hears only a light's nickname, it asks 你想開定熄廚房燈？ and switches nothing. Answer 開 or 熄 (or "on" or "off") within 15 seconds; a speaker that listens again by itself after a question needs no wake word for the answer. Otherwise, say the wake word and the whole command. See [Cantonese](../packages/voice-bridge/README.md#cantonese).

To turn a light on for a while, add how long, as you would in English with "for 10 minutes": 開廚房燈十分鐘, 開廚房燈半個鐘, 開廚房燈個半鐘 (an hour and a half), 開廚房燈兩個鐘, or 開廚房燈，十分鐘後熄. 三個字 (fifteen minutes) works too. HomeHub answers 開咗廚房燈，十分鐘後熄。 and turns it off when the time is up.

A Cantonese command HomeHub didn't understand is listed under **Settings → Teach HomeHub**, like an English one. **Teach** suggests the name without its verb, such as 主人房燈 from 開主人房燈. Choose its devices and save, and voice understands it within a minute.

Voice also understands Vietnamese, and answers in it. Tick **Vietnamese** in **Settings → Voice control**, which downloads about 150 MB more, and give your devices Vietnamese nicknames in **Settings → Devices**, such as đèn bếp. Add one for each way your household says it, such as đèn bếp and đèn nhà bếp, because a word more or less counts as a different name. Say the verb, then the nickname: bật đèn bếp, tắt đèn bếp, mở cửa ga-ra, đóng cửa ga-ra. Add how long to turn something on for a while: bật đèn bếp mười phút. If HomeHub isn't sure whether you said bật or tắt, it asks "Bật hay tắt đèn bếp?" and switches nothing until you answer. See [Vietnamese](../packages/voice-bridge/README.md#vietnamese).

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
