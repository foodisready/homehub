# Works with HomeHub

What to buy, and what each device needs. Everything marked **Tested** runs in a real home with HomeHub today. **Should work** means it talks to HomeHub the same way as a tested device, but nobody has tried that exact model yet: if you do, [tell us how it went](https://github.com/foodisready/homehub/issues).

**Local** devices are controlled over your home network and keep working when the internet is down. **Cloud sign-in** devices need their maker's account once, during setup, and some need it again later.

Links go to the maker's own page. HomeHub earns nothing from them.

## If you're starting from scratch

- **Plugs for lamps and small appliances:** [Kasa EP10](https://www.kasasmart.com/us/products/smart-plugs/kasa-smart-plug-mini-ep10). Local, cheap, found by Discover, and the most tested device in HomeHub.
- **Wall switches and wired lights:** a [Shelly](https://us.shelly.com/collections/all-products) relay behind the switch, fitted by an electrician if you're not comfortable with mains wiring. Local, with no account at all.
- **Motion-activated lights:** a [Shelly Motion 2](https://www.shelly.com/products/shelly-motion-2) and any plug or relay above.
- **Garage door:** [Meross MSG100](https://shop.meross.com/products/smart-wifi-garage-door-opener). Check your opener on Meross's compatibility list first.
- **Anything else with the Matter logo** on the box, added from Google Home, Apple Home, Alexa or SmartThings.

## Plugs, switches and lights

| Device | Status | Local or cloud | How it's added |
|---|---|---|---|
| [Kasa EP10](https://www.kasasmart.com/us/products/smart-plugs/kasa-smart-plug-mini-ep10) plug | ✅ Tested (10 in one home) | Local | Discover. Some newer plugs ask for your TP-Link login once. |
| Other Kasa plugs, such as EP25 and KP115 | 🟡 Should work | Local | Discover. Plugs that measure energy show it in Energy. |
| Shelly 1 and Shelly 2.5 (first generation) relays | ✅ Tested | Local | Discover. Enter its password if you set one. |
| [Shelly](https://us.shelly.com/collections/all-products) Plus, Pro, Gen3 and Gen4 relays, and Shelly Plug US Gen4 | 🟡 Should work | Local | Discover |
| Tuya-based Wi-Fi plugs, sold under many brand names | ✅ Tested (5 in one home) | Local after a cloud sign-in | Needs each plug's Local Key from a free Tuya developer account. Fiddly: buy Kasa or Shelly instead, and use this for plugs you already own. |
| Any plug, switch, light or power strip with the **Matter** logo | 🟡 Should work (tested with a simulated light) | Local | Add it to Google Home, Apple Home, Alexa or SmartThings, then share it with HomeHub using a pairing code. On and off only for now. |
| Tapo plugs without the Matter logo | ❌ Not yet | | Tapo models with the Matter logo, such as the P125M, go through Matter. |
| Zigbee and Z-Wave devices | ❌ No | | They need a hub HomeHub doesn't talk to. |

HomeHub switches lights on and off; dimming and colour aren't supported yet.

### Setting up a new plug: which need the maker's app

Before HomeHub can find a plug, the plug has to join your Wi-Fi. How it does that depends on the brand.

| Brand | App or account needed | How it joins your Wi-Fi |
|---|---|---|
| **Shelly** | None | The plug starts its own Wi-Fi network. Join it from a phone or laptop, open `http://192.168.33.1`, and enter your home Wi-Fi. Then run Discover in HomeHub. The Shelly app also works, but isn't needed. |
| **Kasa** | The Kasa app, and a TP-Link account | Set it up in the Kasa app, then run Discover in HomeHub. |
| **Matter** | A Matter app: Apple Home, Google Home, Alexa or SmartThings | Add it in that app first, which puts it on your Wi-Fi, then share it with HomeHub using a pairing code. On an iPhone, Apple Home is already installed. |
| **Tuya brands** | The maker's app, and a free Tuya developer account | Set it up in the maker's app, then get its Local Key from the developer account. |

To avoid the maker's app entirely, buy **Shelly**. The [Shelly Plug US Gen4](https://us.shelly.com/collections/all-products) is the plug to choose: it's marked **Should work** because HomeHub talks to it the same way as the tested Shelly relays, but that exact plug hasn't been tested yet.

Plugs sold with Tasmota or ESPHome already installed, such as Athom's, are also set up from a web page, but HomeHub can't control them yet.

## Sensors

| Device | Status | Local or cloud | How it's added |
|---|---|---|---|
| Shelly Motion (first version, SHMOS-01) | ✅ Tested | Local | **Sensors → Motion lights → Find sensors** |
| [Shelly Motion 2](https://www.shelly.com/products/shelly-motion-2) (SHMOS-02) | 🟡 Should work | Local | The same |

## Garage doors

| Device | Status | Local or cloud | How it's added |
|---|---|---|---|
| [Meross MSG100](https://shop.meross.com/products/smart-wifi-garage-door-opener) | ✅ Tested | Local after a cloud sign-in | Sign in to Meross once in **Settings → Integrations**, then Discover. |
| Meross MSG200 (two doors) | 🟡 Should work | Local after a cloud sign-in | The same |

Garage doors are always protected: HomeHub asks you to confirm, and Chat and voice can't open them.

## Cameras

| Device | Status | Local or cloud | How it's added |
|---|---|---|---|
| Wyze Cam Pan v3 | ✅ Tested (3 in one home) | Cloud sign-in, then local video | Sign in to Wyze on the **Cameras** page with a free Wyze API key. Live video, snapshots, motion snapshots, pause and resume, and turning the camera from live view. |
| Wyze Cam v2 | ⚠️ Untested on the same network | Cloud sign-in, then local video | The same. The one tested was on another network, where no camera connects. |
| Other Wyze cameras supported by the [camera bridge](https://github.com/IDisposable/docker-wyze-bridge) | 🟡 Should work | Cloud sign-in, then local video | The same. Check your model on the bridge's list. |

Wyze cameras need to be on the same network as the HomeHub computer.

## Voice

| Device | Status | Notes |
|---|---|---|
| Android tablet or old phone with the [Ava](https://github.com/brownard/Ava) app | ✅ Tested | Needs the [voice bridge](../packages/voice-bridge/README.md). Turn off battery optimisation for Ava, or Android stops it in the background. |
| [Home Assistant Voice Preview Edition](https://www.home-assistant.io/voice-pe/) | 🔜 Not yet | The best speaker hardware for this, but it expects Home Assistant to set it up. Connecting it to HomeHub directly is planned and untested. |
| Amazon Echo, Google Nest speakers | ❌ No | They only send voice to their own cloud. They can still switch Matter devices that you also share with HomeHub. |

## Computers to run HomeHub on

| Computer | Status | Notes |
|---|---|---|
| An old laptop or mini PC with Ubuntu (64-bit Intel or AMD) | ✅ Tested (2015 MacBook Pro) | Fast enough for voice. See [On an old laptop](./INSTALL.md#on-an-old-laptop). |
| Raspberry Pi 4 or 5 with 4 GB or more | ✅ Tested (Pi 4) | Fine for everything but voice, which takes about 10 seconds a command on a Pi 4. Use the official power supply. |

## Before you buy anything else

- "Works with Alexa" or "Works with Google" on a box doesn't mean it works with HomeHub. The **Matter** logo does.
- Devices that only work through their maker's app and cloud, with no Matter, can't be controlled by HomeHub.
- Wi-Fi devices need 2.4 GHz Wi-Fi, which nearly every home router provides.
