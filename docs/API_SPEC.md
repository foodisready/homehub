# HomeHub API Specification

Base URL: `http://<pi-ip>:3000`
Auth: `Authorization: Bearer <access_token>` on all routes except `/health` and `/api/auth/*`

---

## Health

### `GET /health`
Public. Returns service status.

**Response 200**
```json
{ "status": "ok", "version": "1.0.0" }
```

---

## Auth

### `POST /api/auth/login`
**Body**
```json
{ "username": "admin", "password": "secret" }
```
**Response 200**
```json
{
  "accessToken": "<jwt>",
  "user": { "id": 1, "name": "admin", "role": "admin" }
}
```
Sets `httpOnly` cookie: `refreshToken=<jwt>; Path=/api/auth/refresh; SameSite=Strict`

**Response 401**
```json
{ "error": "Invalid credentials" }
```

---

### `POST /api/auth/refresh`
Reads `refreshToken` cookie. Returns new access token.

**Response 200**
```json
{ "accessToken": "<new-jwt>" }
```

---

### `POST /api/auth/logout`
Clears refresh token cookie.

**Response 204** — no body

---

### `GET /api/auth/setup`
Public. Whether HomeHub still needs its first admin account.

**Response 200**
```json
{ "needed": true }
```

---

### `POST /api/auth/setup`
Public, and works only while there are no users. Creates the first admin and signs them in, like `/login`.

**Body**
```json
{ "username": "admin", "password": "at-least-8-characters" }
```

**Response 201** — same as `/login`. **400** for a missing username or a password under 8 characters. **409** `ALREADY_SET_UP` once any user exists.

With `ADMIN_PASSWORD` set in the environment, the backend creates that admin on first start instead, so setup is never needed.

---

### `POST /api/auth/invite`
Public. Whether a family invite code still works. The code is sent in the body, never the URL, so it stays out of logs.

**Body** `{ "code": "…" }`

**Response 200** `{ "expiresAt": "2026-11-05T14:57:00.000Z" }`. **404** `INVALID_INVITE` for an unknown code; **410** once it's cancelled, expired or used up. Failed checks count against the login rate limit (**429**).

---

### `POST /api/auth/join`
Public. Creates a family (member) login from an invite and signs it in, like `/login`.

**Body** `{ "code": "…", "username": "Mom", "password": "at-least-8-characters" }`

**Response 201** — same as `/login`. **400** for a missing name or a short password, **409** `CONFLICT` when the name is taken (ignoring case), **404**/**410** as above.

---

### `POST /internal/service-token`
Requires `X-Internal-Key`. Returns `{ accessToken }` for the first admin account; the MCP server signs in with it. **503** `NOT_SET_UP` before any admin exists.

---

## Devices

Any signed-in user can list devices, switch them, and set or cancel timers. Adding, editing, deleting, probing and discovering devices is `admin` only.

Passwords and keys in `driverConfig`, such as a Shelly's `auth.pass` or a Tuya `key`, are never returned. `savedSecrets` lists which are saved, for example `["auth.pass"]`. A `PATCH` whose `driverConfig` leaves a saved secret out, or blank, keeps it. Removing the object that holds it, such as `auth`, removes it.

### `GET /api/devices`
Returns all configured devices with current state.

**Response 200**
```json
[
  {
    "id": 1,
    "alias": "living-room-lamp",
    "ip": "192.168.1.101",
    "model": "HS103",
    "state": true,
    "online": true,
    "wattage": 42.3
  }
]
```

---

### `GET /api/devices/:id`
`:id` is device alias (e.g. `living-room-lamp`) or numeric id.

**Response 200**
```json
{
  "id": 1,
  "alias": "living-room-lamp",
  "ip": "192.168.1.101",
  "model": "HS103",
  "state": true,
  "online": true,
  "wattage": 42.3
}
```
**Response 404**
```json
{ "error": "Device not found" }
```

---

### `POST /api/devices/:id/on`
Turns device on.

**Response 200**
```json
{ "alias": "living-room-lamp", "state": true }
```

---

### `POST /api/devices/:id/off`
Turns device off.

**Response 200**
```json
{ "alias": "living-room-lamp", "state": false }
```

Turning a device on or off by hand cancels any timer on it.

---

### `POST /api/devices/:id/override`
Sets a timer and blocks schedules until it ends. With `state: true`, the device turns off when the timer ends, even if the backend restarted in between. With `state: false`, it's only protected from schedules.

**Request**
```json
{ "state": true, "durationMinutes": 60 }
```

**Response 200:** the updated device, including `overrideState` and `overrideUntil`.

---

### `DELETE /api/devices/:id/override`
Cancels the timer and leaves the device as it is.

**Response 204**

---

### `GET /api/nlp/stats`
Shows how many of the last 1,000 Chat messages the rules answered, and the latest messages they passed to the model. `voice` covers the last 1,000 spoken commands and lists the latest misses as speech recognition heard them.

**Response 200**
```json
{
  "total": 12, "rules": 9, "model": 3,
  "recentModel": [{ "text": "lights out", "createdAt": "2026-11-01T01:00:00Z" }],
  "voice": {
    "total": 8, "understood": 7, "missed": 1,
    "recentMissed": [{ "text": "office lamp", "createdAt": "2026-11-01T13:05:46Z" }]
  }
}
```

---

### `GET /api/nlp/misses` — `admin` only
Commands neither the rules nor anyone has dealt with yet, newest first, one per wording: voice commands that weren't understood, and Chat messages the rules passed to the model. Each has `source` (`voice` or `chat`), `id`, `text`, `createdAt`, the suggested `phrase` to teach and its `kind` (`device` or `scene`).

### `POST /api/nlp/teach` — `admin` only
Body: `{ source, id, phrase, deviceIds }` or `{ source, id, phrase, sceneId }`. Saves `phrase` as a nickname on each device, or as another name for the scene, then checks HomeHub now reads it that way. If it wouldn't, for example because the phrase is another device's or a room's name, nothing is saved and the response is `400` with the reason. On success the miss, and any with the same wording, leave the list. Returns `{ phrase, devices }` or `{ phrase, scene }`.

### `POST /api/nlp/misses/dismiss` — `admin` only
Body: `{ source, id }`. Leaves that miss, and any with the same wording, out of the list. **Response 204**

### `GET /api/nlp/replies` — `admin` only
What voice and Chat say after a command. Returns `{ moments, builtIn, chosen, maxCustom, maxLength }`:
- `moments`: `on`, `off`, `timer`, `scene` and `not_understood`, each with its fill-ins (`{device}`, `{minutes}`, `{scene}`) and the one every reply must include.
- `builtIn`: the built-in lines, each `{ id, moment, style, text }`, where `style` is `plain`, `friendly` or `funny`.
- `chosen`: for each moment, `{ builtIn: [ids], custom: [text] }`. Until an admin saves, only the plain line is chosen.

HomeHub picks one chosen line at random each time; with none chosen it uses the plain line. Protected devices, failures and "which one?" questions always use plain wording.

### `PUT /api/nlp/replies` — `admin` only
Body: the `chosen` object. Up to `maxCustom` of your own lines per moment, each under `maxLength` characters, using only that moment's fill-ins and including its required one. Otherwise `400` with code `REPLY_ERROR`, and nothing is saved. Returns `{ chosen }`.

---

### `GET /api/devices/:id/energy`
Live energy metrics. Only available on HS110, KP115 models. Returns `null` values for non-energy models.

**Response 200**
```json
{
  "alias": "office-lamp",
  "wattage": 8.5,
  "voltage": 121.2,
  "current": 0.07,
  "totalKwh": 12.4,
  "recordedAt": "2026-03-12T18:00:00Z"
}
```

---

### `GET /api/devices/:id/energy/history`
**Query params:** `range=24h|7d|30d` (default: `24h`)

**Response 200**
```json
{
  "alias": "office-lamp",
  "range": "24h",
  "readings": [
    { "wattage": 8.5, "voltage": 121.2, "current": 0.07, "recordedAt": "2026-03-12T17:00:00Z" },
    { "wattage": 0.0, "voltage": 0.0, "current": 0.0, "recordedAt": "2026-03-12T18:00:00Z" }
  ]
}
```

---

### `POST /api/devices` — `admin` only
Register a device manually (for when discovery is not used).

**Body**
```json
{ "alias": "office-lamp", "ip": "192.168.1.102", "model": "KP115" }
```
**Response 201**
```json
{ "id": 2, "alias": "office-lamp", "ip": "192.168.1.102", "model": "KP115" }
```

---

### `PATCH /api/devices/:id` — `admin` only
Update alias, IP or MAC address.

**Body** (all fields optional)
```json
{ "alias": "new-alias", "ip": "192.168.1.103", "mac": "74FECE3576FD" }
```
**Response 200** — updated device object

**Response 409** — another device already uses that alias or IP

---

### `DELETE /api/devices/:id` — `admin` only
**Response 204** — no body

---

Devices also have a `room`, a name or `null`, which can be set on `POST /api/devices` and `PATCH /api/devices/:id`. An empty value clears it.

### `POST /api/devices/discover` — `admin` only
Triggers subnet broadcast discovery. Returns found devices (not yet saved). Kasa results include `mac`. A result for a registered device now at a different IP includes `moved`; apply it with `PATCH /api/devices/:id`. Registered Kasa devices found at their stored IP under the same name have their MAC saved automatically.

A device HomeHub found but can't log in to includes `needsLogin: true`. Newer Kasa plugs need the TP-Link account they were set up with, saved with `PUT /api/kasa/login`. Their results include `driverConfig: { "protocol": "klap" }`, which must be sent when registering them. Until the login works they're listed as `Kasa plug` plus the last four MAC characters. A Shelly login is stored per device in `driverConfig.auth`.

### `POST /api/matter/pair` — `admin` only
Pairs a Matter device that another Matter app has just shared, and adds each part that switches on and off as a device with `driverType: "matter"`.

**Body** `{ "code": "3497-011-2332" }`: the 11-digit manual code (spaces and dashes allowed), or QR code text starting `MT:`.

**Response 201** `{ "devices": [{ "id": 12, "alias": "Eve Energy" }] }`. Errors use code `MATTER_PAIRING_FAILED`: **400** for a malformed code or one the device refused, **404** when no device is waiting with that code, **409** while another pairing is running, **422** when the device has nothing HomeHub can switch (it's unpaired again), **502** for other failures. Pairing can take up to a minute.

Matter devices store `ip` as `matter:<node>:<endpoint>`, and `driverConfig` as `{ nodeId, endpoint, vendor, product }`. Deleting the last device of a node unpairs the node.

---

### `GET /api/kasa/login` — `admin` only
Returns `{ "username": string | null }`. The password is never returned.

### `PUT /api/kasa/login` — `admin` only
Body: `{ "username": string, "password": string }`. Checks the login on a plug, then saves it for every Kasa plug that needs a login. Returns `{ username, verified }`, where `verified` is false if no plug answered. Returns `422` with `KASA_LOGIN_REJECTED` if a plug refuses it, and nothing is saved. HomeHub stores hashes of the login, not the password.

### `DELETE /api/kasa/login` — `admin` only
Forgets the saved login.

### `/api/motion` — `admin` only
Motion rules turn a light off after a room has had no motion for `offAfterMinutes`, and turn it on when motion starts if `turnOnWithMotion` is true. A rule does nothing until its sensor first reports.

- `GET /api/motion` lists rules.
- `POST /api/motion` takes `{ name, deviceId, offAfterMinutes, turnOnWithMotion }`. Protected devices are refused.
- `PATCH /api/motion/:id` takes any of `{ name, deviceId, offAfterMinutes, turnOnWithMotion }`. The sensor doesn't need reconnecting.
- `DELETE /api/motion/:id` removes a rule.
- `POST /api/motion/:id/connect` takes `{ sensorIp, username, password }` and sets a Gen 1 Shelly Motion's `motion_on` and `motion_off` actions. The login is saved unless the sensor rejects it, a blank password reuses the saved one, and the password is never returned.

### `POST /api/motion/discover` — `admin` only
Searches the network for Shelly Motion sensors. **200** `[{ "ip": "192.168.1.60", "name": "shellymotionsensor-60A423", "model": "SHMOS-01", "needsLogin": true, "usedBy": "Kitchen" }]`, where `usedBy` is the rule already using that sensor, or `null`. Sleeping sensors answer only after their button is pressed.

`POST /api/devices/discover` leaves out Shelly sensor-only models (motion, H&T, door/window, flood, smoke, button) and any address a motion rule uses as its sensor.

### `GET /motion/:token/on` and `GET /motion/:token/off`
Called by the sensor. The token is the auth, so these need no login. Returns `204`, or `404` for an unknown token.

**Response 200**
```json
[
  { "ip": "192.168.1.105", "alias": "TP-LINK_PLUG_A2B3", "model": "HS103", "mac": "74FECE3576FD" },
  {
    "ip": "192.168.1.106", "alias": "office-lamp", "model": "KP115", "mac": "4822542F336F",
    "moved": { "deviceId": 2, "alias": "office-lamp", "previousIp": "192.168.1.102" }
  }
]
```

---

## Schedules

### `GET /api/schedules`
**Response 200**
```json
[
  {
    "id": 1,
    "deviceAlias": "porch-light",
    "label": "Porch on at sunset",
    "triggerType": "solar",
    "solarEvent": "sunset",
    "solarOffsetMinutes": 0,
    "stayOnMinutes": 180,
    "state": true,
    "enabled": true,
    "nextRun": "2026-03-12T19:42:00Z"
  },
  {
    "id": 2,
    "deviceAlias": "porch-light",
    "label": "Porch off at midnight",
    "triggerType": "cron",
    "cronExpression": "0 0 * * *",
    "state": false,
    "enabled": true,
    "nextRun": "2026-03-13T00:00:00Z",
    "problem": null
  }
]
```

`problem` is set, in words, on a cron schedule the scheduler can't read, such as `0 30 * * *` (hour 30). Such a schedule never runs.

---

### `POST /api/schedules` — `admin` only
**Body (cron type)**
```json
{
  "deviceAlias": "office-lamp",
  "label": "Office off at 11pm",
  "triggerType": "cron",
  "cronExpression": "0 23 * * *",
  "state": false
}
```

The minute comes first. An expression the scheduler can't run is refused with `400` and code `INVALID_CRON`, with the reason in `error`. `PUT /api/schedules/:id` checks the same way.

**Body (solar type)**
```json
{
  "deviceAlias": "porch-light",
  "label": "Porch on at sunset",
  "triggerType": "solar",
  "solarEvent": "sunset",
  "solarOffsetMinutes": -15,
  "state": true
}
```

Valid `solarEvent` values: `sunrise` · `sunset` · `dawn` · `dusk` · `goldenHour` · `solarNoon`

`stayOnMinutes` (optional, on a cron or solar schedule with `state: true`): a whole number of minutes from 1 to 1440. When the schedule runs, the device's timer is set to turn it off that much later, named after the schedule, so `GET /api/devices/auto-off` reports it with `cause: "schedule"` and Activity records the turn-off as the schedule. It doesn't hold off the device's other schedules. Switching the device by hand, in Chat or by voice cancels it, and a Turn OFF schedule clears it. `null` or left out: the device stays on. It's ignored on Turn OFF and `auto_off` schedules, and anything else is refused with `400`.

**Response 201** — created schedule object

---

### `PATCH /api/schedules/:id/toggle` — `admin` only
Enable or disable a schedule.

**Body**
```json
{ "enabled": false }
```
**Response 200** — updated schedule object

---

### `DELETE /api/schedules/:id` — `admin` only
**Response 204** — no body

---

## Natural Language (NLP)

### `POST /api/nlp`
Sends a natural language command to Ollama. Response is streamed via Server-Sent Events.

**Body**
```json
{
  "message": "Turn off the office lamp if it has been on for more than 2 hours",
  "history": [
    { "role": "user", "content": "What lights are on?" },
    { "role": "assistant", "content": "The office lamp and living room lamp are on." }
  ]
}
```

**Response** — `Content-Type: text/event-stream`
```
data: {"type":"token","content":"I'll"}
data: {"type":"token","content":" check"}
data: {"type":"tool_call","tool":"get_energy_metrics","args":{"device_alias":"office-lamp"}}
data: {"type":"tool_result","tool":"get_energy_metrics","result":{"wattage":8.5}}
data: {"type":"token","content":" The office lamp has been on for 3h 12m."}
data: {"type":"action","summary":"Turned off: office-lamp"}
data: {"type":"done"}
```

---

## Energy Summary

### `GET /api/energy/summary`
Total live wattage across all online devices.

**Response 200**
```json
{
  "totalWattage": 127.4,
  "deviceCount": 5,
  "onlineCount": 4,
  "readings": [
    { "alias": "office-lamp", "wattage": 8.5 },
    { "alias": "living-room-lamp", "wattage": 42.3 }
  ]
}
```

---

## Users — `admin` only

### `GET /api/users`
**Response 200**
```json
[
  { "id": 1, "name": "admin", "role": "admin", "createdAt": "2026-03-01T00:00:00Z" },
  { "id": 2, "name": "jeff", "role": "member", "createdAt": "2026-03-10T00:00:00Z" }
]
```

---

### `POST /api/users`
**Body**
```json
{ "name": "jeff", "password": "secure-password", "role": "member" }
```
**Response 201**
```json
{ "id": 2, "name": "jeff", "role": "member" }
```

---

### `PATCH /api/users/:id/password`
User can change their own password. Admin can change any user's password.

**Body**
```json
{ "currentPassword": "old", "newPassword": "new-secure" }
```
**Response 204** — no body

---

### `DELETE /api/users/:id` — `admin` only
Cannot delete your own account.

**Response 204** — no body

---

## Home settings

The home's location and time zone. Saved in the `settings` table (`home_latitude`, `home_longitude`, `home_timezone`); until then, `LATITUDE`, `LONGITUDE` and `TIMEZONE` or `TZ` from the environment apply. `.env.example`'s San Francisco location and a `TZ` of `UTC` count as unset.

### `GET /api/home-settings`
Any signed-in user.

**Response 200**
```json
{
  "latitude": 40.7128,
  "longitude": -74.006,
  "timezone": "America/New_York",
  "located": true,
  "source": { "location": "settings", "timezone": "settings" },
  "today": { "sunrise": "2026-11-02T11:28:00.000Z", "sunset": "2026-11-02T21:53:00.000Z" }
}
```
`latitude` and `longitude` are `null`, and `today` is `null`, until a location is known. `source` is `settings`, `env`, or `none` / `default`.

---

### `PUT /api/home-settings` — `admin` only
**Body** (each part optional; latitude and longitude go together)
```json
{ "latitude": 40.7128, "longitude": -74.006, "timezone": "America/New_York" }
```
**Response 200** — the settings, as for `GET`. **400** for a latitude outside -90 to 90, a longitude outside -180 to 180, or an unknown IANA time zone. The backend switches its own time zone straight away and tells the scheduler to reload.

---

### `GET /api/home-settings/mcp` — `admin` only
**Response 200** — `{ "secret": "<MCP_SECRET>", "port": 3001 }`, for connecting an AI app.

---

## First-run setup — `admin` only

The guided setup after the first admin account is made. Mounted at `/api/setup`.

### `GET /api/setup`
```json
{ "finished": false, "step": "devices", "starters": [{ "id": "evening", "title": "Evening lights", "description": "…" }] }
```
`step` is one of `home`, `devices`, `rooms`, `starters`, `family`, `done`. A home with devices but no saved progress (set up before the wizard existed) reports `finished: true`.

### `PUT /api/setup`
Body `{ "step"?: "rooms", "finished"?: true }`. **400** for an unknown step.

### `GET /api/setup/places?q=springfield, il&tz=America/Chicago`
Up to 8 towns, best first: whole-name matches, then towns in `tz`, then bigger towns. Text after a comma narrows by region or country; US state abbreviations work. The town list ships with HomeHub (GeoNames, CC BY 4.0), so nothing leaves the house.
```json
[{ "name": "Springfield", "region": "Illinois", "country": "United States", "latitude": 39.8, "longitude": -89.64, "timezone": "America/Chicago", "label": "Springfield, Illinois, United States" }]
```

### `GET /api/setup/places/guess?tz=America/New_York`
The biggest town in that time zone, or `null`.

### `POST /api/setup/starters`
Creates starter automations, all or none.
```json
{ "starters": [
  { "id": "evening", "deviceIds": [3, 4], "offTime": "22:30" },
  { "id": "outdoor", "deviceIds": [5] },
  { "id": "goodnight", "deviceIds": [3, 4, 5] }
] }
```
`evening`: on at sunset, off at `offTime` (24-hour, default `23:00`). `outdoor`: on at sunset, off at sunrise. `goodnight`: a scene named Goodnight (or Goodnight 2, …) that turns the devices off.

**Response 201** `{ "schedules": 6, "scenes": ["Goodnight"] }`. **400** for an unknown starter, no devices, a bad time, or a protected device.

### `GET /api/setup/invites`
Invites that still work: `[{ "id": 1, "expiresAt": "…", "uses": 2, "maxUses": 10 }]`.

### `POST /api/setup/invites`
A new invite for up to 10 people, valid 24 hours. **201** with the same fields plus `code`, returned only this once; only its hash is stored. The join link is `<HomeHub address>/join#<code>`.

### `DELETE /api/setup/invites/:id`
Cancels an invite. **204**, or **404**.

---

## Activity

Every device change and its cause. Anyone signed in can read it.

| Method | Path | Does |
|---|---|---|
| `GET` | `/api/activity` | Newest first. Query: `deviceId`, `room` (empty for no room), `source`, `kind` (`power` or `online`), `before` (an id, for paging), `limit` (max 200). Each entry: `{ id, deviceId, deviceName, driverType, room, kind, state, source, detail, via, userName, at, onForSeconds }`. `onForSeconds` is set on a power-off that followed a power-on. |
| `GET` / `PUT` | `/api/activity/settings` | `{ keepDays }`, 7–730, default 90. `PUT` is admin only. |

`source` is one of `app`, `scene`, `schedule`, `timer`, `motion`, `chat`, `voice`, `assistant`, `shutoff`, `outside` or `homehub`. `detail` names the scene, schedule or motion rule. `via` says what started a scene, such as `chat`. Repeating a device's current state isn't recorded.

`GET /api/devices` also includes `autoOff`: when a device that's on will turn itself off, as `{ at, cause, detail, afterMinutes? }`. `cause` is `timer`, `motion` or `schedule`; `detail` names the motion rule or schedule. `at` is null while a motion rule waits for the room to empty, with `afterMinutes` set. The earliest applies. `GET /api/devices/auto-off` returns just these, keyed by device id, and a `motion` socket event (`{ deviceId, occupied }`) signals that one may have moved.

`GET /api/devices` includes `lastChange`: each device's latest on/off entry. Requests with the header `x-homehub-client: mcp` are recorded as `assistant`; the MCP server sends it. The scheduler sends the schedule's `label` to `/internal/devices/:id/execute`.

---

## Cameras (Wyze)

Cameras are devices with `driverType: "wyze"` and `driverConfig: { cam: "<bridge name>" }`. `POST /api/devices/:id/on` resumes one and `/off` pauses it, through the Wyze cloud (`run_action` `power_on`/`power_off`); its state is Wyze's property `P3`, cached for 5 minutes. A Wyze problem answers with its status and `code: "CAMERA_ERROR"`, such as `409` when signed out. A camera the bridge lacks reads as offline. They're always protected; Chat and voice may resume them but not pause them. Cameras added under another bridge name are relinked by `mac`.

| Method | Path | Who | Does |
|---|---|---|---|
| `GET` | `/api/cameras/bridge` | any | `{ state }`: `off` (turned off in Settings), `not-configured` (`HOMEHUB_CAMERA_BRIDGE=0`), `signed-out`, `starting` (restarting with a new sign-in), `sign-in-failed` (with `detail`), `unreachable`, `unauthorized` or `ready` (with `cameras`) |
| `POST` | `/api/cameras/bridge/login` | admin | Body: `{ email, password, keyId, apiKey }`. Saved in the data volume's `wyze` folder (mode 0600) for the bridge, which restarts with it. HomeHub uses it too, for pausing, keeping its Wyze token there as `homehub-auth.json`. Waits up to 90 s, then returns the new state; `422` if Wyze turns it down. |
| `DELETE` | `/api/cameras/bridge/login` | admin | Signs out: deletes the saved sign-in and HomeHub's Wyze token, and the bridge stops. Returns the new state. |
| `GET` | `/api/cameras/bridge/cameras` | admin | Cameras on the Wyze account: `[{ cam, name, model, ip, mac, streaming, added }]` |
| `GET` | `/api/cameras` | any | Added cameras: `{ bridgeError, cameras: [{ deviceId, name, room, cam, model, canPan, watching, online, streaming, picture, lastPictureAt, noPictureSince, noPictureHint, lastMotionAt, latestSnapshot }] }`. `picture` is `ok`, `failing` (two failed pictures in a row) or `unknown`, from every picture HomeHub asks the bridge for, plus one every 5 minutes for a camera nobody is watching; `streaming` is the bridge's own claim, which it makes for every camera. `canPan` is true for Pan cameras (`HL_PAN2`, `HL_PAN3`, `HL_PANP`, `WYZECP1_JEF`). `noPictureHint` says whether the camera's hardware address is on HomeHub's network (`/proc/net/arp`). A failing camera that is on the network gets its bridge stream restarted, at most every 10 minutes, and every resumed camera does 15 s after resuming. |
| `GET` | `/api/cameras/:deviceId/live.jpg` | any | A picture now, tried twice. `?cached=1` (for thumbnails) tries once. `404` when the camera gives none. |
| `POST` | `/api/cameras/:deviceId/snapshots` | any | Saves a picture now. Returns the snapshot. |
| `POST` | `/api/cameras/:deviceId/ptz` | any | Turns a Pan camera. Body: `{ action }`, one of `left`, `right`, `up`, `down` or `stop`. A move keeps going until `stop`, another move, or the end of the camera's range; repeat it at least once a second while the arrow is held, or HomeHub sends `stop` after 1.5 s (`WYZE_PTZ_HOLD_MS`). Repeats of the move under way don't reach the camera. `204` when sent; `409` for a camera that doesn't turn; `501` when the bridge image predates pan and tilt; `502` when the camera doesn't answer. |
| `GET` | `/api/cameras/:deviceId/hls/<file>` | any | Live HLS video relayed from the bridge's go2rtc, starting at `index.m3u8`, then `hls/playlist.m3u8` and `hls/segment.ts` |
| `GET` | `/api/cameras/snapshots` | any | Newest first. Query: `deviceId`, `before` (an id, for paging), `limit` (max 200) |
| `GET` | `/api/cameras/snapshots/:id/image` | any | The JPEG |
| `DELETE` | `/api/cameras/snapshots/:id` | admin | Deletes it. Returns `204`. |
| `GET` / `PUT` | `/api/cameras/settings` | any / admin | `{ enabled, motionSnapshots, notify, keepDays (1–365), cooldownSeconds (5–3600) }`. `enabled: false` hides Cameras from the menu and stops the motion watch. The motion watch asks the Wyze cloud for new events (`/v4/device/get_event_list`, signed) every 10 s, looking back 3 minutes, and saves a frame from the bridge for each motion event (Wyze's own picture is tried first, but its links need a login HomeHub doesn't have). Sound-only events are skipped. Wyze allows an account 300 of these per 5 minutes, shared with the Wyze app; the watch checks every 30 s when fewer than 100 are left, and waits 5 minutes after a `429`. `lastMotionAt` on `GET /api/cameras` is the last motion Wyze reported since HomeHub started. Responses add `bridgeInstalled` (false with `HOMEHUB_CAMERA_BRIDGE=0`). |

A `camera:snapshot` socket event announces each new snapshot. The backend reaches the bridge's API at `WYZE_BRIDGE_URL` (default `http://127.0.0.1:5080`), sending `WYZE_BRIDGE_API_KEY` as a Bearer token, and its go2rtc at `WYZE_GO2RTC_URL` (default `http://127.0.0.1:1984`). Pan and tilt use `POST /api/wyze/ptz?src=<cam>&action=…` on that go2rtc, which HomeHub's bridge image adds ([packages/wyze-bridge](../packages/wyze-bridge/README.md)).

---

## Discovery networks

| Method | Path | Does |
|---|---|---|
| `GET` | `/api/devices/discover/networks` | `{ own, extra, suggested, max }`, each a list like `"192.168.1.x"` |
| `PUT` | `/api/devices/discover/networks` | `admin` only. Body: `{ networks: ["192.168.1.x"] }`. Accepts `192.168.1.x`, `192.168.1.0/24` or `192.168.1`. Private /24s only, up to `max`. HomeHub's own networks are dropped. |

`POST /api/devices/discover` searches HomeHub's own networks and these. Kasa, Shelly, Tuya and Meross devices are found there by asking each address directly, since broadcasts don't cross routers.

---

## Meross — `admin` only

| Method | Path | Does |
|---|---|---|
| `GET` | `/api/meross/login` | `{ email, signedIn }` |
| `PUT` | `/api/meross/login` | Body: `{ email, password, code? }`. Signs in to the Meross cloud and stores only the account key (`settings.meross_key`). Returns `{ email, signedIn, rejectedBy }`, where `rejectedBy` lists registered Meross devices that refused the key. `422` with code `MEROSS_CODE_REQUIRED` when Meross wants a verification code, or `MEROSS_LOGIN_REJECTED`. `502` if Meross can't be reached. |
| `DELETE` | `/api/meross/login` | Forgets the key and token. Returns `204`. |
| `GET` | `/api/meross/devices` | Garage door openers on the Meross account: `[{ uuid, name, type, online, registered }]`. Empty without a token from a recent sign-in. |

`GET /api/meross/login` and `PUT` also return `hasNames`, which is true when HomeHub has the token it uses to read device names.

Meross garage doors use `driverType: "meross"`. `state: true` means open. They're always protected.

---

## Backups — `admin` only

JSON backups of settings tables (users, devices, sensors, scenes, scene_actions, schedules, motion_rules, settings, notification_preferences, push_subscriptions), stored in `data/backups`. History tables aren't included.

| Method | Path | Does |
|---|---|---|
| `GET` | `/api/backups` | Lists backups, newest first: `{ name, createdAt, note, size, counts }` |
| `POST` | `/api/backups` | Creates one. Body: `{ note? }`. Returns `201` with the entry. |
| `POST` | `/api/backups/upload` | Adds a backup file from another HomeHub. Body: `{ content }`. It's checked with a test restore, and refused if it has `"<hidden>"` values. Returns `201` with the entry, named `uploaded-*.json`. Restoring is a separate call. |
| `GET` | `/api/backups/:name/download` | The whole file as an attachment, passwords and keys included |
| `GET` | `/api/backups/:name` | `{ name, content }`, where secrets in `content` are `"<hidden>"` |
| `PUT` | `/api/backups/:name` | Saves edited text. Body: `{ content }`. `"<hidden>"` values are filled back in from the saved file by row id. The edit is test-restored and rolled back first; a failure returns `400` with the reason. |
| `POST` | `/api/backups/:name/restore` | Saves the current state as `before-restore-*.json`, then replaces each table present in the file, except that `users` are merged: accounts already here are kept as they are, and backup accounts with a new name are added (with their `push_subscriptions` and `notification_preferences`). `home_latitude`, `home_longitude` and `home_timezone` stay if set here. Returns `{ counts, removed, accounts: { added, kept }, safetyBackup }`. |
| `DELETE` | `/api/backups/:name` | Deletes it. Returns `204`. |

Names must match `^[A-Za-z0-9][A-Za-z0-9._-]*\.json$`. A restore removes history rows whose device, sensor or user isn't in the backup.

---

## Pausing automations

| Method | Path | Who | Notes |
|---|---|---|---|
| `GET` | `/api/system/automations` | any | `{ paused }` |
| `PUT` | `/api/system/automations` | admin | Body: `{ paused }`. While paused, this HomeHub runs no schedules (`/internal/devices/:id/execute` answers `{ skipped: true, paused: true }`), motion rules, timers, camera motion snapshots or automatic water shutoff. Resuming drops timers that ran out while paused, without switching anything. The setting is left out of backups, and a restore keeps this HomeHub's value. |

## Health and versions

| Method | Path | Who | Notes |
|---|---|---|---|
| `GET` | `/api/system/health` | any | `{ status: 'ok' \| 'attention' \| 'problem', checkedAt, version, items }`. Each item is `{ id, group, label, level: 'ok' \| 'warn' \| 'error' \| 'info', detail, link? }`, where `detail` says what to do in plain words. Services are probed at their health or root addresses only. |
| `GET` | `/api/system/version` | any | Also returns `canSwitch` (the updater service answers) and `previous`, the older release that ran before this one, or `null`. |
| `POST` | `/api/system/switch` | admin | Body: `{ version }`. Only `previous` or the latest release. Saves `backups/before-version-<from>-to-<to>.sqlite`, then asks the updater; **202** once it has started. `400` `VERSION_NOT_OFFERED` or `ALREADY_RUNNING`; `409` `BUSY`; `503` `UPDATER_OFFLINE`. |
| `GET` | `/api/system/switch-status` | admin | The updater's last switch: `{ busy, current, last: { version, from, ok, step, finished } }`, where a failed `step` of `download` means nothing changed. `null` without the updater. |
| `POST` | `/internal/voice/status` | internal key | The voice bridge checks in every minute: `{ version, speakers: [{ name, address, connected }] }`. |

`POST /api/system/update` uses the updater when it answers, switching to the latest release, and Watchtower otherwise.

## WebSocket Events (Socket.io)

Connect to `ws://<pi-ip>:3000` with a valid JWT:
```js
const socket = io('http://pi-ip:3000', {
  auth: { token: accessToken }
});
```

### Events from server → client

| Event | Payload | Description |
|---|---|---|
| `device:state` | `{ id, alias, state, wattage }` | A plug was toggled |
| `device:energy` | `{ id, alias, wattage, voltage, current }` | Periodic energy poll |
| `device:online` | `{ id, alias, online }` | Device came online or went offline |
| `schedule:fired` | `{ scheduleId, label, deviceAlias, state }` | A schedule just executed |
| `nlp:action` | `{ summary, deviceAlias, state }` | NLP command took an action |

---

## Error Format

All error responses use a consistent shape:

```json
{
  "error": "Human-readable message",
  "code": "DEVICE_NOT_FOUND"
}
```

Common HTTP status codes:
- `400` — bad request / validation error
- `401` — missing or invalid JWT
- `403` — valid JWT but insufficient role
- `404` — resource not found
- `409` — conflict (e.g. alias already exists)
- `503` — device unreachable / Kasa TCP timeout
