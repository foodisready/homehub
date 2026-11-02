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

Zigbee and Philips Hue devices aren't supported. "Works with Google or Alexa" on a box doesn't mean it works with HomeHub, so check the brand first.

## Add a device

Set up every device in its own app first, so it's on your home Wi-Fi. Then:

1. Open **Settings → Devices**.
2. Select **+ Discover on network**.
3. Tick the devices you want, and give each a clear name.
4. Select **Register Selected**.

If a device isn't found, type its IP address in the add form, select **Probe**, then **Add**.

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

If a Shelly is password-protected, Discover shows **Username** and **Password** fields. To change them later, select **Edit** on the device. Shelly needs the real password, so it's stored unencrypted in HomeHub's database.

### Tuya plugs

Tuya plugs need a **Device ID** and **Local Key**. The easiest way to get them is from a free [Tuya IoT](https://iot.tuya.com) developer account:

1. Open **Settings → Integrations → Tuya Cloud** and enter your Access ID and secret.
2. Run **Discover on network**, then select **Auto-fill from Tuya Cloud**.

If you remove a plug and pair it again, its Local Key changes, so you'll need to update it in HomeHub.

## Control your devices

- **Dashboard:** tap a tile to switch a device.
- **Settings → Devices:** tap **On** or **Off** to test a light.
- **Chat:** type a command, such as "turn on the porch light".

Set up a timer in Chat by adding a time, such as "turn on my office lamp for an hour".

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

Marking a device as protected stops Chat, voice and AI assistants from switching it. Open **Settings → Devices**, select **Edit**, and tick **Don't let Chat or AI assistants switch this device**.

Devices with "valve" in their name, and devices used for automatic water shutoff, are always protected. Protected devices can still be switched from their dashboard tile.

## Household members

Open **Settings → Users** to add people. Administrators can change devices and settings.

## Remote access

To reach HomeHub away from home, set up [Remote Access](./REMOTE_ACCESS.md). Don't forward ports on your router.

The **QR code** button on the dashboard gives you a quick way to open HomeHub on your phone.

## Voice control

Voice control is experimental and isn't included in the install. The test setup works with the Ava app on an Android tablet, but its connection to HomeHub isn't packaged yet. See the [voice control plan](./VOICE_CONTROL.md).

## Troubleshooting

**A device shows as offline:** check that it has power and is on Wi-Fi. Its address may also have changed. Run **Discover on network**, and if it's listed as moved, select **Update address**. Don't add it as a new device, or you'll lose its schedules.

**Discover doesn't find a device:** run it again, because a scan can miss devices. Make sure HomeHub is on the same network as the device, then try adding it by IP address.

**A Kasa plug says the email or password was rejected:** see [Kasa plugs](#kasa-plugs). This can happen even with the right password.

**The motion sensor says it can't be reached:** press its button to wake it, then try again. It can take up to a minute to respond.

**A motion rule says it's waiting for the first report:** select **Connect sensor** and wait for "Sensor connected", then wave at it. It ignores new motion for a short time after each report.

**A schedule runs at the wrong time:** check that `TZ` in `.env` matches your time zone. Sun schedules also need the right `LATITUDE` and `LONGITUDE`. Restart HomeHub after changing them.

**Chat doesn't understand a command:** use a device's full name, or add a nickname. Commands that need the AI model can be slow on a Pi.
