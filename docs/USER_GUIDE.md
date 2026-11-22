# HomeHub User Guide

This guide covers everyday use, from adding devices to automating your lights. To install HomeHub first, see the [install guide](./INSTALL.md).

## Find a setting

**Settings** (**More** on a phone) shows its sections as tiles, grouped into Your home, Talking to HomeHub, Connections and More. Each tile says how that part is doing, such as "24 devices · 7 offline" or "Last backup 5 hours ago", and a yellow **Look** badge means something there needs you: a device offline, an account to sign in to again, a backup that's late or a voice speaker that isn't answering. Tap a tile to open it; the arrow at the top, or your phone's Back button, goes back to the tiles. Search finds a setting by its name or what's in it, such as "password", "wake word" or "Honeywell"; press Enter when it finds just one to open it. **List** at the top shows the sections as one list instead, and HomeHub remembers your choice on each browser.

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
| **Any Matter brand** | Plugs, lights, switches and power strips (on and off), and thermostats | Shared from Google Home, Apple Home, Alexa or SmartThings. See [Matter devices](#matter-devices) |
| **Honeywell** | RedLINK thermostats, such as Prestige, through a RedLINK Internet Gateway | Through your Total Connect Comfort account. See [Honeywell thermostats](#honeywell-thermostats-redlink) |

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

**Wall switches with a Shelly behind them.** Wire the Shelly so it's the only thing powering the light: its output goes straight to the light, and the wall switch goes to its **SW** input as a signal. For a 3-way pair (two switches for one light), both switches feed **SW**. Then, in the Shelly's own page, open the channel's settings and set **Button type** to **Edge switch**, so every flip of either switch changes the light, whatever position the switches are in. **Toggle switch** follows the switch's position instead, so after HomeHub changes the light, a flip can seem to do nothing.

If a Shelly measures power, such as the Shelly 2.5 or 1PM, HomeHub notices when it has a light on but the light draws no power for about a minute. The light shows **On, but no power** in amber. That usually means a wall switch is still wired into the light's power after the Shelly and is off, so flip it. If it keeps happening, that switch needs rewiring as above. HomeHub only does this for lights it has seen draw power before, so an appliance resting at 0 W isn't flagged.

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

### Thermostats

A thermostat with the Matter logo, such as a Google Nest Thermostat, is added the same way, with **+ Add a Matter device**. It becomes one device. On **Home**, its row shows the room's temperature and what it's doing, such as "70° · Heating to 72°". Select it to see the temperature in large type, choose **Off**, **Heat**, **Cool** or **Auto**, and set the target with **−** and **+**. In **Auto** there are two targets: it heats below the first and cools above the second. Taps in a row are sent together once you stop. Changes made on the thermostat or in another app show up straight away. Temperatures are in °F or °C, depending on your home's time zone.

The switch on the row turns the thermostat off, and on again in the mode it was in. Off stops all heating and cooling until it's turned back on, so HomeHub asks first, whether you use the switch or **Off**; when it's below 40 °F (4 °C) outside, the question says so. Turning it on isn't asked. **All off** for a room leaves thermostats alone, and thermostats have no **Turn off after** timer. By Chat or voice, "turn off the 2nd floor thermostat" is asked back ("Should I turn off 2nd Floor Thermostat?") and done on a yes; a name that also covers lights turns the lights off and leaves the thermostat on. Scenes can still turn a thermostat off or on, as set up.

To set its temperature ranges, an administrator opens the thermostat with **Edit** in **Settings → Devices**:

- **Comfortable**, 68–76 °F at first: where you like it when you're home and awake. The thermostat's card points out a target outside it, and HomeHub's savings advice will keep to it.
- **Never beyond**, 60–82 °F at first: the furthest Chat, voice, schedules and scenes can ever set it, at night and while you're out too. You can still go further on the thermostat itself or with **−** and **+**, within the thermostat's own limits.

### Temperature schedule

Each thermostat has its own card at the top of **Schedules**: a list of changes, each setting the heating and cooling targets on some days, at a time or at sunrise or sunset. For example, "Weekdays · 6:30 AM: Heat 68°" and "Every day · 10:30 PM: Heat 61°". The thermostat's card on **Home** shows the next one, with a link to the schedule.

- **Use a suggested schedule** fills in a start: your lowest comfortable temperature from 6:30 AM, and 7 °F (4 °C) lower from 10:30 PM. The U.S. Department of Energy estimates that lowering the heat 7–10 °F for 8 hours a day saves up to about 10% a year. Change it afterwards as you like.
- A schedule only changes the targets. It never turns heating or cooling on or off, so a thermostat you've turned off for the summer stays off.
- A change made on the thermostat, its card, Chat or by voice holds until the next scheduled one.
- Every target has to be inside **Never beyond**. If you narrow that range later, scheduled changes stop at its edge.
- If HomeHub was off or restarting when a change came due, it makes the latest one it missed as soon as it's back, so the house isn't left at the night temperature all day. Changes that came due while automations were paused are skipped.
- Turn off the thermostat's own schedule and learning, such as Nest's Auto-Schedule. Otherwise it changes the targets back. A Honeywell thermostat's own schedule doesn't need turning off: HomeHub's schedule holds each target until its next change.

Matter thermostats share only the basics with other apps: temperatures, mode and targets. Features of the thermostat's own app, such as Nest's Eco mode and learning, stay in that app.

#### Heating and cooling history

The **Energy** page has a **Heating and cooling** card for each thermostat; **History and running hours** on the thermostat's card goes straight to it. HomeHub records it from the moment the thermostat is added:

- **This month so far**, **today**, and how this month compares with last month **for the weather**. A colder month needs more heating, so the comparison is in hours per degree-day: how much it ran for how cold (or hot) it was. Mild months, when there's too little to compare, say so.
- **By month**: heating and cooling hours for the last 12 months. **For the weather** shows hours per 100 degree-days instead, so a cold January and a mild March compare fairly. Hover over or tap a month for its numbers, or select **Table** to see them all. A month before HomeHub had the thermostat says **Not recorded**.
- **Temperatures**: one day's inside temperature, target and outside temperature, with shading while it heated or cooled. Move along the chart to read the values at any time, and use **‹** and **›** for other days. A gap in a line means HomeHub wasn't recording then.

Running hours come from the thermostat's own reports of starting and stopping. A thermostat that doesn't report when it's running can't have its hours counted, and the card says so; its temperatures are still recorded. Outside temperatures and degree-days need your home's location in **Settings → Home**. Degree-days are counted from 65 °F, the usual base for homes. Days and times are always your home's, even on a phone somewhere else.

HomeHub keeps 5-minute temperatures for 400 days, and running hours and outdoor temperatures for as long as it runs.

HomeHub keeps its Matter pairings in its database, so backups include them and a restore brings them back. Keep backups private: they hold HomeHub's Matter keys.

### Honeywell thermostats (RedLINK)

Honeywell RedLINK thermostats, such as the Prestige, work with HomeHub through a **RedLINK Internet Gateway** (THM6000R7001) and Honeywell's **Total Connect Comfort** service.

1. Connect the gateway to your router or a mesh Wi-Fi point with an Ethernet cable.
2. On each thermostat, open **Menu → Installer Options → Wireless Device Manager → Add Device**, then press **Connect** on the gateway. The thermostat says **Gateway added**; answer **No** to more accessories. Installer Options asks for a password, usually the thermostat's date code. In Wireless Device Manager, only add: removing a device can disconnect the thermostat from your heating and cooling.
3. Register the gateway at mytotalconnectcomfort.com or in the Total Connect Comfort app with the MAC ID and CRC on its sticker, and check you can see each thermostat there.
4. In HomeHub, open **Settings → Integrations → Honeywell**, enter your Total Connect Comfort email and password, and select **Sign in**. Each thermostat is added, named from Total Connect Comfort, such as "Basement Thermostat". Rename it or give it a room in **Settings → Devices**.

They then work like any thermostat in HomeHub: the card, Chat and voice, temperature schedules, Away mode, and the heating and cooling history. A few things differ:

- Changes go through Honeywell's servers, so they need the internet and take up to about a minute to reach the thermostat, and a minute or so to show as confirmed. The card shows a change as soon as you make it.
- HomeHub reads each thermostat once a minute, which is as often as Honeywell allows. A change made at the wall shows up within a minute.
- Total Connect Comfort asks for the password every time HomeHub signs in, so HomeHub keeps it, and never shows it again. Backups include it, hidden when a backup is viewed. If you change the password in the Total Connect Comfort app, HomeHub tries the old one once, stops, and **Settings → Integrations → Honeywell** asks you to sign in again. It doesn't keep retrying, so it can't lock your account.
- The thermostat keeps its own schedule. The card says whether it's following it. A change from the card, Chat or voice holds until the thermostat's next scheduled change, as a change at the wall does; **Back to its schedule** ends it sooner. A HomeHub temperature schedule or Away mode holds its target until it changes it. When Away mode ends, a thermostat that was following its own schedule goes back to it, unless it has a HomeHub schedule.
- Honeywell doesn't say this works with other software. It's how Honeywell's own Total Connect Comfort website talks to its servers, and Honeywell could change that.

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

The **Cameras** page shows every camera as a tile: its latest picture, whether it's **Watching**, **Paused** or **Offline**, and a bell on a doorbell. The counts at the top say how many are watching, paused and offline. **Rooms** groups the tiles by room (Ring and IP cameras each get their own group), and **All** shows one grid; HomeHub remembers your choice on each browser.

Tap a tile to open the camera full screen, with **Live**, **Snapshot** and, for Wyze cameras, **Pause** or **Resume**. Swipe, tap the arrows or press the arrow keys for the next camera. Admins also find **Edit** (IP cameras) and **Remove** (Ring and IP cameras) there; removing asks first. **Pause all** pauses every Wyze camera that's watching, after asking; Ring and IP cameras can't be paused, so they keep watching.

Select the picture or **Live** to watch. Live video can be a few seconds behind, and starts with the sound off; the 🔇 button turns it on.

To zoom, pinch or double-tap on a phone, or scroll, double-click or press **+** and **−** on a computer. Drag to look around while zoomed, and double-tap or press **0** to see the whole picture again. Zoom enlarges the picture, as in the Wyze app; it doesn't turn the camera.

A **Pan** camera, such as the Pan v3, also gets arrows to turn the camera itself. Hold an arrow to keep turning and let go to stop; a tap turns it a little. On a computer, the arrow keys do the same. On a phone held upright the arrows sit under the picture, and over it when the phone is turned sideways or in full screen. If you close live view or lose the connection while an arrow is held, HomeHub stops the camera within 2 seconds. The camera turns 0–355° across and stops by itself at either end. If its own motion tracking is on in the Wyze app, it may turn away again to follow movement.

Each camera shows **Watching** only while its pictures actually arrive. **No picture** means HomeHub couldn't get one twice in a row, with the likely reason: the camera isn't on HomeHub's network (it may have joined another Wi-Fi, or another device may be using its address), or it's on the network but not sending video. In that second case HomeHub reconnects to it by itself, at most every 10 minutes. This includes a camera you moved to another Wi-Fi or that got a new address: HomeHub notices it answering somewhere new, gets the new address from Wyze, and connects there. If Wyze hasn't caught up yet, it tries again 10 minutes later. **More → Health** also mentions a camera with no picture for 10 minutes.

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

Set up a timer in Chat by adding a time, such as "turn on my office lamp for an hour" or "porch light on for 10 minutes". It works typed in Vietnamese, Cantonese and Mandarin too, and HomeHub answers in the same language: "bật quạt 30 phút", 開門口燈十分鐘, 打开门口灯半小时. "In 10 minutes" (later, rather than for a while) goes to the AI model.

When Chat doesn't know the words for a device, such as a misspelling ("turn of ffice liights") or a name in another language ("tắt đèn phòng khách"), the AI model works out what you probably meant, and Chat asks first: "Should I turn off Office lights?" or "Có phải bạn muốn tắt Living room lamps, Living room statue và Woman statue không?". Reply **yes** or **no** (có / không, 係 / 唔係, 是 / 不是). A yes switches them and saves your words as their nickname, so next time the same words work straight away, with no question. A no changes nothing. Anything else is read as a new command. The question waits two minutes, and only for the person who was asked. On a Pi 4 the question takes about 15 seconds. To skip asking and send these commands to the AI model's chat as before, set `CHAT_ASK=off` in `.env`.

Ask what's on, such as "which devices are on?", "which lights are off?" or "is the kitchen light on?", in Chat or by voice. HomeHub answers these itself, straight away, from the states the dashboard shows. Cameras are left out of the lists. Anything HomeHub can't answer itself goes to the AI model, which runs on the HomeHub computer and can take a minute on an older one, unless you've chosen Claude Haiku (see [AI for Chat and voice](#ai-for-chat-and-voice)). Under each reply, Chat shows who answered, **HomeHub** or **the AI model**, and how long it took. If the AI model isn't answering, Chat says so, in the language you typed, and that simple commands still work; **Health** shows why.

Ask the time, the date or the weather the same way: "what time is it?", "what's the date?", "what's the weather?", "what's the weather tomorrow?" or "will it rain today?". In Chat or by voice you can also ask in Vietnamese ("Mấy giờ rồi?", "Thời tiết hôm nay thế nào?", "Ngày mai có mưa không?"), Cantonese ("幾點呀？", "今日天氣點？", "聽日會唔會落雨？") or Mandarin ("现在几点？", "明天会下雨吗？"), and the answer comes in the same language. The weather needs your home's location in **Settings → Home**. It comes from Open-Meteo, a free weather service: only the location leaves the house, rounded to about a kilometre, and at most every ten minutes.

Ask "what should I wear?", "what should I wear tomorrow?" or "do I need a jacket?" (in Cantonese "今日著咩衫？", "使唔使著外套？"; in Mandarin "明天穿什么？"; in Vietnamese "Hôm nay mặc gì?") and HomeHub suggests clothes from the forecast: a heavy coat, a warm coat, a jacket, a sweater or a T-shirt, by how warm it feels. It adds layers when it warms up a lot later, an umbrella when rain is likely, and boots for snow. Today's advice uses the feels-like temperature now; tomorrow's uses the cool part of the day, when people get dressed. The suggestion only comes when you ask about clothes, not with every weather answer.

With Claude Haiku chosen (your own Anthropic key; see [AI for Chat and voice](#ai-for-chat-and-voice)), HomeHub also understands questions worded in ways its rules don't, in all four languages ("ngày mai mình nên mang áo gì", "宜家出邊幾多度"), and questions about another city: "what's the weather in New York?", "紐約嘅氣溫係幾多", "what time is it in Tokyo?". A short follow-up carries on from your question just before it, in Chat for five minutes and at a speaker for two: after New York, "and tomorrow?" or "聽日呢" is still about New York, and the answer names the city. A full question that names no city, such as "will it rain tomorrow?" or "我應該着啲咩", is about your home. A question in another language starts afresh, since it's most likely someone else asking. Claude only works out what was asked; the answer still comes from the clock and Open-Meteo, so the weather is never made up. Only the city's name is sent to Open-Meteo to find it. Each question Claude reads costs about $0.0001, counted with Chat's use. The time and the date are always answered by the rules, straight away. Without a key, the rules answer as before, for home only. The model on your HomeHub isn't used for questions: in testing it mistook most commands and background talk for questions.

Choose °F or °C under **Temperatures** in **Settings → Home**. It's used for the weather, clothing suggestions and thermostats. Left on Automatic, it's °F in the United States and °C elsewhere, unless `TEMPERATURE_UNIT=C` or `F` is set in `.env`.

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

## Energy

The **Energy** page shows where your electricity goes, a month at a time; **‹** and **›** at the top choose the month.

At the top, **the month in numbers:** electricity in kWh, large, then gas in therms if you heat with gas, the cost once prices are set (with what the whole month will likely come to), and how this month compares with the same days of last month. The comparison only includes devices HomeHub recorded through both, so it never compares something with nothing.

Below that, a tile for each part says how it's doing this month. A yellow **Look** badge means something needs you, such as a device HomeHub can't count yet; a red **Fix** badge means the panel monitor isn't answering. Tap a tile to open it; the arrow at the top, or your phone's Back button, returns to the tiles. The month you choose applies inside each one too.

- **Where it goes:** each device, biggest first, with a sentence saying what stands out, such as "Heating is 98% of the estimated cost here." **Rooms** groups them by room. Under each, how many hours it was on and where its figure comes from. Devices HomeHub can't count yet are listed here, with a box to enter what they draw.
- **Heating and cooling:** each thermostat's running hours and temperatures, shown only if you have a thermostat. See [Heating and cooling history](#heating-and-cooling-history).
- **Whole home:** the panel monitor's measured total, or how to add one.
- **By month:** the last 12 months, in energy or cost. Tap a month to see it, or select **Table**.
- **Measured live:** power over time for plugs that measure it. **Energy** on such a plug, on the Home page, opens this.

**These are estimates, from how long each device was on and what it draws.** A device that measures its own power, such as some Kasa and Shelly models, is measured instead, and says so. HomeHub counts time on only while it was running and the device was online, so a lamp left on while HomeHub was off isn't counted as on. What a device draws comes from, in order:

1. What you set: **Power when on** in **Settings → Devices → Edit**, or the box on the Energy page.
2. What it measures, for a device that measures.
3. Typical for what its name says it is: 9 W for an LED lamp, 1,500 W for a space heater. For something that switches itself on and off, such as a heater, kettle or dehumidifier, time on is the most it could have used, and it says so.

A wall switch can control one bulb or twelve, and some names don't say what a device is, so those wait for you: they're listed under **Not counted yet** until you enter what they draw. The bulb or the device's label says; for a wall switch, add up its bulbs. Cameras, garage doors and water valves aren't counted: their time on doesn't say what they use.

**Prices:** an administrator selects **Add your energy prices** and enters the price of electricity per kWh, and of gas per therm if you heat with gas. Dividing a bill's total by the kWh it charges for is close enough.

**Heating and cooling** are usually the biggest part, and are estimated from the thermostat's running hours and the system's size. Set it in **Settings → Devices → Edit** on the thermostat, under **Heating and cooling system**: a gas furnace's size is its input in BTU/h, a heat pump or air conditioner's in tons, both on the unit's label. Left blank, a typical size is used. If two or more thermostats are zones on one unit, set the unit on one of them and choose **Same unit as** on the others under **Unit**: the unit's running time is then counted once, not once for each zone calling at the same time.

**It isn't your whole home.** The fridge, water heater and other appliances HomeHub doesn't control aren't included, and the page says so. A panel monitor in your electrical panel shows the real total: see **Whole home** on the Energy page.

HomeHub keeps each device's daily hours and measured energy for as long as it runs, so months can be compared a year later, though Activity itself is kept for 90 days. Backups keep what devices draw, the prices and thermostat settings; the history itself is in the daily database backup.

## Rooms

Rooms keep the dashboard short. Open **Settings → Devices**, select **Edit** on a device, and enter a room. Devices with no room appear under **Unassigned**.

Home shows your devices as **Rooms** at first, or as a **List**: switch at the top, and HomeHub remembers your choice on each browser.

- **Rooms:** a tile for each room, glowing warmer the more of its lights are on. Its chips show how many lights and plugs are on, the room's temperature if it has a thermostat (orange while heating, blue while cooling), a garage door left open, and anything offline, which also puts a red dot on the tile. **Camera** means a camera there is watching. Lights are recognized by their names, such as "lamp", "light" or "đèn".
- **A room:** tap a tile and it grows into the room. Its devices hang off the room as round bubbles; a line lights up when a device is on. Tap a bubble to switch it, and press and hold it for its controls: timers, a thermostat's temperature and mode, and recent activity. Thermostats turned off, garage doors, pausing a camera and protected devices ask first, as on the list. A room with more than 8 devices shows them as a grid instead. **‹** and **›** at the bottom move to the next room, and the arrow at the top goes back to the tiles. Searching and filtering work here too.
- **List:** each room folds open and shut. Offline devices move to their own group at the bottom.

**All off** turns off a room's lights and plugs, leaving protected devices and thermostats alone.

Search by device name, nickname or room, or use the **On** and **Offline** filters. The same search is in **Settings → Devices**. On a computer, press `/` to jump to search.

You can also use rooms in Chat and voice, such as "turn off the living room".

## Names and groups

Open **Settings → Devices** and select **Edit** to add nicknames. The device opens in a popup, with its name at the top; **Save** keeps the changes, and **✕**, **Cancel** or Esc closes it without saving. Type one and press **Add** or Enter; each becomes a tag, marked EN, VI or 中 for its language. A Chinese nickname (中) works in Cantonese and in Mandarin. Select **✕** on a tag to remove it (**Undo** brings it back), and **Save** to keep the changes. HomeHub recognizes nicknames in Chat and voice commands. A tag with a dashed edge is shared with another device, named under the tags.

With Vietnamese, Cantonese or Mandarin ticked in **Settings → Voice control**, HomeHub suggests nicknames in those languages under the tags, made from the device's English names: "Kitchen lights" gets đèn bếp and đèn nhà bếp. Mandarin suggestions are in simplified characters, and only where the words differ from Cantonese: "Garage door" gets 车库门 next to 車房門, but "Kitchen lights" gets only 廚房燈, which works in both. Tap one to add it. The next suggestion also shows, greyed, in the empty nickname box: press **Tab** on a keyboard, or **Add** on a phone, to add it. Start typing and the box finishes a suggestion that begins the same way, without the accents needed: type "den n" and press **Tab** for đèn nhà bếp. For a person's room, Cantonese and Mandarin need their Chinese name: tap the suggestion, type the name in front of it, such as 以信 before 房燈, and press **Add**. HomeHub then uses that name in its other suggestions. It knows the usual rooms (including a breakfast area, kitchen counter or island, and media room), lights, doors and appliances, and words such as corner, little and long. Names with other words, such as "Woman statue", get no suggestions.

To add suggestions for every device at once, open **Settings → Voice control** and select **Review** under **Suggested nicknames**. They're all ticked: tap any that aren't right to untick them, then select **Add**. Ones you untick aren't suggested there again.

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

## Away mode

For when everyone's out for a day or more. On **Home**, select **✈ Away mode…**, choose when you're back (or that you don't know yet), and **Start Away mode**. Anyone signed in can start and end it; an administrator chooses what it does, in the same window.

While it's on, a banner on **Home** says what it's doing, and:

- **Thermostats** go to their away temperatures: at first the edges of their **Never beyond** range, such as 60 °F heating and 82 °F cooling. Change them with **−** and **+**. Their temperature schedules wait. Heating or cooling isn't turned on or off. A thermostat that isn't connected is set when it connects.
- **Water:** with a water sensor, any water use that starts after you leave is treated as a leak (water already running then, such as the dishwasher, isn't). You're told at once, and a shutoff valve set up for the sensor closes. Turn this off if sprinklers, a water softener or an ice maker use water while you're away.
- **Cameras:** paused cameras resume when it starts.
- **Check-ins and spoken reminders** wait until the day and time you're back, including the warm-up hour. Days while away aren't checked, then or after you're back.
- **Lived-in lights:** lamps you choose go on 0–45 minutes after sunset and off between 10 and 11:30 PM, at different times each day.

With a day back, Away mode ends by itself an hour before (or the time you choose under **Back to normal**), so the house is warm or cool when you arrive, and everyone with notifications on is told. The day back has to be later than that warm-up time from now. Thermostats go back to what their schedule says for that time, or to what they were set to before. Lamps it turned on go off. **I'm back** ends it straight away. **Change** moves the day back.

The day back is in your home's time zone, even when you set it from a phone somewhere else. While automations are paused (**Pause automations**), Away mode changes no devices.

## Daily check-in

For someone who lives alone. Open **Family**, then **Daily check-in**, enter who it's for, a time to start looking and a time to check by, and the days. If nothing at home shows they're up by that time, everyone with HomeHub notifications on, and the email addresses for alerts, are told. They're told again at the first sign of activity after that.

Signs they're up: lights and plugs switched by a person (at the wall, by voice or in an app, not by schedules or timers), voice commands HomeHub understood, water used (with a water sensor) and motion sensors. The last two weeks show what the check-in would have done each day, so you can pick a time that wouldn't have raised a false alarm.

### Ask at home first

Tick **Ask at home first** and, at the check time, the speakers ask before anyone is told, such as "亞娘，你冇事吖嘛？冇事就講「冇事」。" The language comes from the name, or choose one under **Ask in**. It has to be on in **Settings → Voice control**.

- **"I'm OK"** in that language (冇事, 没事, không sao, "I'm fine") means nobody is told.
- **"I'm not OK"** (唔舒服, 不舒服, mệt, "I don't feel well") tells the family at once.
- **No answer:** it asks once more 5 minutes later, then tells the family. Any other sign meanwhile, such as a lamp switched or the kettle filled, counts too.
- If no speaker could say the question, the family is told straight away.

On a speaker that can listen straight after speaking, the person just answers. On others, they say the wake word first, then the answer.

### Make the alert hard to miss

A check-in alert, like a call for help, reaches a sleeping phone at once, buzzes longer and stays on screen until it's opened. To have it ring even when the phone is on Do Not Disturb:

- **Android:** open **Settings → Apps → HomeHub → Notifications** and turn on **Override Do Not Disturb**. If HomeHub isn't listed as an app, it's under Chrome's notifications, as the HomeHub site. Some phones call it **Priority** or **Allow interruptions**.
- **iPhone:** open **Settings → Focus → Do Not Disturb → Apps** and add **HomeHub** (from the Home Screen).

Then select **Send a test alert** on the check-in to see how it arrives.

## Scenes

A scene sets several devices at once, and each one can do something different. For example, "Goodnight" could turn off the living room but turn on the porch light.

1. Open **Scenes** and create a new scene.
2. Choose **On**, **Off** or **Skip** for each device. For a camera, the choices are **Resume** and **Pause**.
3. Save it.

Run it from the Scenes page, or in Chat or voice with "run Goodnight". Chat and voice skip protected devices.

To change a scene, select **Edit** on its card (administrators only). You can change its name, icon, and what each device does; the scene's devices are listed first. Select **Save Changes**. Other names HomeHub has learned for the scene, in **Teach HomeHub**, still work. After a rename, say the new name in Chat or voice. If you change a scene so it no longer pauses a camera, **Voice may pause cameras** turns off, and you tick it again if you later add a camera pause back.

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
2. Open **Sensors**, and under **Motion lights** select **+ Add motion light**.
3. Enter a name, choose a light and set the minutes, then select **Add**. The new motion light opens on its own page.
4. Press the sensor's button to wake it. A new rule searches for sensors straight away; for an existing one, select **Connect sensor**, then **Find sensors**.
5. Pick your sensor from the list. HomeHub fills in its address, and the username `admin` if it has a login. Enter its password if it has one, then select **Connect**. If the sensor isn't listed, press its button and search again, or type its address.

A sensor already used by another rule is marked. Picking it moves it to this rule.

**+ Discover on network** in Settings leaves sensors out, since they have nothing to switch.
6. Wave at the sensor to activate the rule.

A Ring doorbell or camera can be a rule's sensor instead of a Shelly Motion (a rule has one sensor, so choosing Ring replaces the Shelly): choose it under **Ring camera** on the rule's card, after adding it on the Cameras page. Its motion counts, and so does the doorbell ringing, so a porch light can come on for whoever's at the door. Ring sends no "motion over", so the rule hears it a minute after the last motion. Ring has no light reading, so **When the room is dark** needs a Shelly Motion; use **Between sunset and sunrise** instead.

Each motion light shows on the Sensors page as a card that reads as one line, such as "Hallway sensor → Hallway ceiling + Stair lamp", with how it works ("On with motion, off after 10 min without motion · between sunset and sunrise") and what it's doing now. Tap a card to change it on its own page; the arrow at the top, or your phone's Back button, goes back. **Remove** there asks first.

A rule does nothing until its sensor first reports. Its page shows what it's doing, including a countdown to when the light turns off. The countdown clears when the light goes off, within about a minute if you use a wall switch. Turning a light off at the wall also ends any timer it had, so motion can turn it back on. Motion leaves a light alone while you've chosen **Keep off for**, and while it's on with a timer, so the timer still turns it off. Clear **Turn on when motion starts** to only turn lights off. You can edit a rule's name, lights and minutes on its page, and test each light with the button next to it.

### Several lights from one sensor

One sensor can switch several lights, such as the kitchen lights and the cabinet strip. Add the rule with its first light, then choose more under **Add another light…** on its card. Select **✕** next to a light to take it out of the rule; a rule always keeps at least one.

- Motion turns on every light in the rule. **Only** (such as **When the room is dark**) applies to all of them.
- A light on a keep-on timer, or a protected one, is left alone, and the others still come on. So is one that can't be reached.
- Each light turns off on its own time: one switched on by hand later still gets the full minutes. The card shows each light's countdown.
- Use one rule for a sensor's lights, not a rule per light: a Shelly Motion reports to only one rule, so connecting it to a second rule takes it from the first.
- Deleting a device takes it out of its rules. A rule is deleted only along with its last light.

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
- **Backup** is a standby copy. It runs no schedules, motion lights, timers or automatic water shutoff. Its voice and camera bridges wait, so the voice speaker and cameras stay with the active HomeHub. It answers to `homehub-backup.local` instead of `homehub.local`. It doesn't check Tuya plugs on its own, because a Tuya plug takes one connection at a time and the active HomeHub would find it busy; their state there updates when you switch one. It's read-only, because its settings are copied from the active HomeHub (see [Keeping the backup up to date](#keeping-the-backup-up-to-date)): you can switch devices on and off and run scenes by hand, but devices, rooms, schedules, scenes and settings are changed on the active HomeHub. Its own accounts, backups, and **This server** can still be changed, so it can always be made active. Once it's active, everything can be changed again.
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
- **Location:** sunrise and sunset schedules use it, and so does the weather. In Google Maps, right-click your home and select the numbers at the top, then paste both into the first box. On an `https` address, such as through Tailscale, **Use this device's location** fills them in.

After you save, the page shows today's sunrise and sunset, so you can check they look right. Schedules change straight away, without a restart.

## AI for Chat and voice

When HomeHub's own rules don't understand a message typed in Chat, an AI model works out what was meant. In **Settings → AI for Chat and voice** (admins), choose which one:

- **This HomeHub (free):** the model runs on the HomeHub computer. It's private and works without the internet, but on a Pi 4 it's slow (about 15 seconds for a command, longer for a question) and less accurate. In a test of 166 real household commands in English, Cantonese and Vietnamese, it understood 121 and often asked about the wrong device.
- **Claude Haiku (your own Anthropic key):** understood 156 of the same 166, rarely asks about the wrong device, and answers in a second or two. It also answers questions HomeHub can't answer itself, such as energy use or setting up a schedule.

Either way, HomeHub answers what it can itself first, asks before switching anything the model picked ("Should I turn on Porch light?"), and never opens a garage door from Chat or voice.

**After an update or restart:** the model on this HomeHub takes a few minutes to load (about 4 on a Pi 4). Meanwhile a banner at the top of every page says **HomeHub is getting its AI ready**, with its step (of 4) and how long it's been. Lights, scenes and schedules work normally meanwhile, and voice as soon as its own banner says so (below); only Chat replies that need the model are slow. The banner says when the AI is ready, then goes away. If the model doesn't load, it says so; the **Chat model** line on the Health page has details. With Claude Haiku chosen, Chat doesn't wait for the model, so there's no banner. On a computer with less than 8 GB of memory, the model isn't loaded ahead of time, so there's no banner, and the first Chat message after a while is the slow one.

**Voice after an update or restart:** the voice bridge restarts too. For about a minute it loads its speech models and finds the speakers again, and the speakers can't hear anyone. Meanwhile everyone sees **Voice is starting**, with whether it's loading speech or finding speakers, and how long it's been; then **Voice is ready** for a few seconds. If no speaker has connected after 3 minutes, it says **No speaker has reconnected**: check that the speaker is on and on Wi-Fi (the Health page says which one and why). This shows only when voice is on and a speaker has connected before, and only after a start: a speaker unplugged later shows on the Health page instead. It's shown even with Claude Haiku chosen, since voice is out either way.

**Voice:** with Claude Haiku, a voice command HomeHub's rules don't understand goes to Claude too. If Claude can tell which device was meant, the speaker asks, such as "Should I turn on Porch light?", 係咪要開廚房燈？ or "Có phải bạn muốn bật Đèn bàn không?", in the language you spoke. It asks in words, so a question is never mistaken for HomeHub saying it did it. Answer within 15 seconds: "yes", 係, 是 or "có" switches it, and "no", 唔係, 不 or "không" leaves everything as it was. A speaker that listens again by itself after a question needs no wake word for the answer. Anything else is taken as a new command. Claude is told which wake word woke the speaker, since its end is sometimes heard at the start of the command (老友 heard as 冇有), and whether each device is on or off now: when the word for on or off was lost, as in 欧亮燈 for 熄啊亮燈, it asks about the change, 係咪要熄啊亮燈？ for a lamp that's on. If Claude can't tell, the speaker says it didn't understand, as before, or stays quiet if it sounded like talk in the room. With the model on this HomeHub, voice uses HomeHub's rules only: on heard speech, the small model asked about the wrong device too often.

To use Claude Haiku:

1. Make an API key at [console.anthropic.com](https://console.anthropic.com/settings/keys), and set a monthly spending limit there, such as $5.
2. In **Settings → AI for Chat and voice**, select **Claude Haiku**, paste the key, and select **Save and use Claude**. HomeHub checks the key with Anthropic before saving it, and never shows it again.

**What it costs:** about $0.0003 for each message Claude handles. Most messages never reach it, because HomeHub's rules answer them. A busy household spends a few cents a month. The card shows this month's requests and an estimate of the cost. Your Anthropic account shows the exact amount.

**Monthly limit:** under the saved key, select **Set a limit** and enter an amount from $0.10 to $100. Once this month's estimate reaches it, the model on this HomeHub answers until the 1st of next month, and the card says so. Set a spending limit in your Anthropic account too: HomeHub's figure is an estimate, and Anthropic's limit is exact.

**What's sent:** only Chat messages and voice commands the rules don't understand (as text, never the recording), the few messages before them in the same chat, and your device, room and scene names. When Claude looks something up, such as which devices are on or a device's energy use, that goes too. Anthropic's terms for API use apply.

**If Claude can't be reached** (the internet is down, the key was deleted, or the spending limit was reached), the model on this HomeHub answers instead, and the card shows the last problem. **Check key** asks Anthropic whether the saved key still works. **Remove** forgets the key and goes back to this HomeHub. Delete the key at console.anthropic.com too if you no longer need it.

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

Settings shows one section at a time. Select a section's name to open it, and the one that was open closes. Select it again to close it. Devices starts open, and each browser remembers the section open last.

## Remote access

To reach HomeHub away from home, set up [Remote Access](./REMOTE_ACCESS.md). Don't forward ports on your router.

**QR code** gives you a quick way to open HomeHub on your phone. On a computer, it's at the top right. On a phone, it's under **More**.

## Health

**More → Health** shows whether HomeHub is working, in plain words: its services, devices that aren't responding, voice speakers, the nightly backup, disk space and the computer's temperature. A ring at the top counts the checks that are fine and those that need a look, and **Check again** runs them all now. Below it, a tile for each area (HomeHub, Devices, Voice, Data, Computer and Settings) says how it's doing, with a yellow **Look** badge when something there needs a look, or a red **Fix** when something is wrong. Tap a tile for its checks, problems first, each with what to do about it; the arrow at the top, or your phone's Back button, goes back. Admins also see a notice on the Home page when something needs a look.

HomeHub checks its computer's temperature every minute, so Health also says how hot it got in the last day if that was hotter than now. On a Raspberry Pi, it also shows whether the Pi is getting enough power. Admins get a notification when the computer stays at 80 °C or more for 5 minutes, which is where a Raspberry Pi starts slowing itself down, or when a Pi reports low power. Each notification is sent at most once every 6 hours.

### Restart the voice bridge

If speakers stop answering, administrators can select **Restart voice bridge** under **Voice**, here or in **Settings → Voice control**, which also lists each speaker as Connected or Not connected. The bridge restarts when it next checks in, within a minute, and the page shows it restarting. You don't need it for new nicknames: the bridge picks those up by itself within a minute.

### Go back a version

If something stopped working after an update, open **Health → HomeHub**, and under **Version** select **Go back to** the version HomeHub ran before. HomeHub saves a copy of its database, switches back and restarts, which takes a minute or two. Your devices, schedules and settings stay. When a fixed version is out, the Update card on the Home page offers it as usual.

If Health says to run the installer once more, your HomeHub was installed before going back was possible: run the installer again on the HomeHub computer, and the option appears.

## Voice control

Say a command to a speaker or tablet, and HomeHub does it and answers, with no cloud. It needs a voice speaker on the same network, such as the Ava app on an Android tablet.

To turn it on, an administrator opens **Settings → Voice control**, ticks **Voice control** and saves. The first time, HomeHub downloads its speech models, about 200 MB, which takes a few minutes; the card says when it's running. Speakers on the network are found by themselves, and appear on the card and under **Health**. If one stops answering or shows Not connected, select **Restart voice bridge** on the card: speakers reconnect in about a minute. If one still doesn't, open the voice app on it again, or restart the tablet. The [voice bridge](../packages/voice-bridge/README.md) that does this comes with HomeHub and updates with it. See the [voice control plan](./VOICE_CONTROL.md) for what's still to come.

If two speakers hear the same command, only the one that heard you loudest, usually the nearest, answers, and the command is carried out once. If a speaker wakes but hears no words, usually because something on TV or in a conversation sounded like the wake word, it stops listening without saying anything. It also stays quiet when what it hears has nothing of a command in it, such as a line from a show ("I don't want to pay for your drink"): no on or off word, nothing that's part of a device's name, and more than a couple of words. A short miss, such as a command cut off, still gets an answer, so you know to say it again. It never takes its own reply, heard back as it listens again, for a command.

After a wake word in Cantonese, Mandarin or Vietnamese, such as 老友 or Xin Chào, the speaker also stays quiet when it hears English with no on or off word and no light or lamp in it, even if a device's name is in it. That is almost always the TV. An English command, such as "turn on the kitchen lights", is still answered, and so is a short miss.

If a TV, a video or a conversation keeps going while you speak, the speaker listens for its full eight seconds. It then answers only if it made out a few words with an on or off word or a thing like a light in them, such as "mở đèn của nhà vua" said over a video; longer talk is taken for the room and gets no answer. For the quickest answer, speak when the room is quiet.

When the speaker asks "Did you mean…?", it uses the name you'd say in your language: "Có phải bạn muốn bật đèn của nhà vua không?" rather than "…bật King's lamp…", when the device has a Vietnamese or Chinese nickname.

When a name you say is close to two devices, voice doesn't guess. For example, 開卓軒燈 sounds as close to 着氣燈 (one child's lamps) as to anything, but 卓軒 is exactly in 卓軒房邊燈 (the other child's lamp), so it answers that it didn't understand rather than switch the wrong light. Say the full nickname, or add the shorter one you use, such as 卓軒燈, to the right device.

A wake word named in Chinese characters, such as 老友, tells HomeHub to listen in Cantonese, or in Mandarin if that's the one on, and one with Vietnamese letters, such as Xin Chào, in Vietnamese, so a command isn't taken for another language. With Cantonese and Mandarin both on, a Chinese wake word could be either, so it doesn't decide. Other wake words, such as Okay Nabu, work in every language that's on. A Vietnamese wake word can go off on Cantonese, too: when the Vietnamese words aren't a command and the speech sounded Chinese, HomeHub listens to it again as Cantonese or Mandarin, about 2 seconds more, and answers it if it's a command.

Voice also understands Cantonese, and answers in it. Tick **Cantonese** in **Settings → Voice control**, which downloads about 350 MB more, and give your devices Cantonese nicknames in **Settings → Devices**, such as 廚房燈. Say the verb, then the nickname: 開廚房燈, 熄廚房燈. A nickname of five or more words can be said with one word from the middle left out: 開早餐細燈 or 開早餐區燈 for 早餐區細燈, unless another nickname shortens the same way. Leave a short pause after the wake word, so the verb isn't cut off: if HomeHub hears only a light's nickname, it asks 你想開定熄廚房燈？ and switches nothing. Answer 開 or 熄 (or "on" or "off") within 15 seconds; a speaker that listens again by itself after a question needs no wake word for the answer. Otherwise, say the wake word and the whole command. When a command isn't understood, such a speaker listens once more: say it again within 15 seconds, with no wake word, and it's heard in the same language. See [Cantonese](../packages/voice-bridge/README.md#cantonese).

To turn a light on for a while, add how long, as you would in English with "for 10 minutes": 開廚房燈十分鐘, 開廚房燈半個鐘, 開廚房燈個半鐘 (an hour and a half), 開廚房燈兩個鐘, or 開廚房燈，十分鐘後熄. 三個字 (fifteen minutes) works too. HomeHub answers 開咗廚房燈，十分鐘後熄。 and turns it off when the time is up.

A Cantonese command HomeHub didn't understand is listed under **Settings → Teach HomeHub**, like an English one. **Teach** suggests the name without its verb, such as 主人房燈 from 開主人房燈. Choose its devices and save, and voice understands it within seconds.

Voice also understands Vietnamese, and answers in it. Tick **Vietnamese** in **Settings → Voice control**, which downloads about 150 MB more, and give your devices Vietnamese nicknames in **Settings → Devices**, such as đèn bếp. Add one for each way your household says it, such as đèn bếp and đèn nhà bếp, because a word more or less counts as a different name. Say the verb, then the nickname: bật đèn bếp, tắt đèn bếp, mở cửa ga-ra, đóng cửa ga-ra. Add how long to turn something on for a while: bật đèn bếp mười phút. If HomeHub isn't sure whether you said bật or tắt, it asks "Bật hay tắt đèn bếp?" and switches nothing until you answer. See [Vietnamese](../packages/voice-bridge/README.md#vietnamese).

Voice also understands Mandarin, and answers in it, in simplified characters. Tick **Mandarin** in **Settings → Voice control**, which downloads about 300 MB more, or 60 MB if Cantonese is on. Mandarin uses your Chinese nicknames: a nickname such as 廚房燈 or 厨房灯 works in Cantonese and Mandarin alike, because HomeHub matches it by how it sounds in the language you speak. Say the verb, then the nickname, or the nickname first: 打开厨房灯, 关掉厨房灯, 把厨房灯打开, 厨房灯关了. Add how long to turn something on for a while: 打开厨房灯十分钟, 开厨房灯半小时. 现在几点？ and 今天天气怎么样？ are answered too. With Cantonese on as well, a command that's clearly Mandarin, such as 把客厅灯打开, is answered in Mandarin. Anything else is tried as Cantonese first. See [Mandarin](../packages/voice-bridge/README.md#mandarin).

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
