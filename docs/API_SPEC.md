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
    "nextRun": "2026-03-13T00:00:00Z"
  }
]
```

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

## Settings — `admin` only

### `GET /api/settings`
**Response 200**
```json
{
  "latitude": 37.7749,
  "longitude": -122.4194,
  "timezone": "America/Los_Angeles",
  "ollamaModel": "llama3.2:3b",
  "energyRatePerKwh": 0.15,
  "pollingIntervalSeconds": 30
}
```

---

### `PATCH /api/settings`
**Body** (all fields optional)
```json
{
  "latitude": 37.7749,
  "longitude": -122.4194,
  "timezone": "America/Los_Angeles",
  "energyRatePerKwh": 0.18
}
```
**Response 200** — updated settings object

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

Cameras are devices with `driverType: "wyze"` and `driverConfig: { cam: "<bridge name>" }`. `POST /api/devices/:id/on` resumes one and `/off` pauses it. They're always protected; Chat and voice may resume them but not pause them.

| Method | Path | Who | Does |
|---|---|---|---|
| `GET` | `/api/cameras/bridge` | any | `{ state }`: `not-configured`, `unreachable`, `signed-out`, `unauthorized` or `ready` (with `cameras`) |
| `POST` | `/api/cameras/bridge/login` | admin | Body: `{ email, password, keyId, apiKey }`. Passed to the bridge's `/login`, not stored. Returns the new state. |
| `GET` | `/api/cameras/bridge/cameras` | admin | Cameras on the Wyze account: `[{ cam, name, model, ip, mac, streaming, added }]` |
| `GET` | `/api/cameras` | any | Added cameras: `{ bridgeError, cameras: [{ deviceId, name, room, cam, model, watching, online, streaming, lastMotionAt, latestSnapshot }] }` |
| `GET` | `/api/cameras/:deviceId/live.jpg` | any | A picture now. `?cached=1` allows one up to a minute old. `404` when paused or offline. |
| `POST` | `/api/cameras/:deviceId/snapshots` | any | Saves a picture now. Returns the snapshot. |
| `GET` | `/api/cameras/:deviceId/hls/<file>` | any | Live HLS video relayed from the bridge, starting at `index.m3u8` |
| `GET` | `/api/cameras/snapshots` | any | Newest first. Query: `deviceId`, `before` (an id, for paging), `limit` (max 200) |
| `GET` | `/api/cameras/snapshots/:id/image` | any | The JPEG |
| `DELETE` | `/api/cameras/snapshots/:id` | admin | Deletes it. Returns `204`. |
| `GET` / `PUT` | `/api/cameras/settings` | any / admin | `{ motionSnapshots, notify, keepDays (1–365), cooldownSeconds (5–3600) }` |

A `camera:snapshot` socket event announces each new snapshot. The backend reaches the bridge at `WYZE_BRIDGE_URL` and `WYZE_BRIDGE_HLS_URL`, sending `WYZE_BRIDGE_API_KEY` in the `api` header.

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
| `GET` | `/api/backups/:name` | `{ name, content }`, where secrets in `content` are `"<hidden>"` |
| `PUT` | `/api/backups/:name` | Saves edited text. Body: `{ content }`. `"<hidden>"` values are filled back in from the saved file by row id. The edit is test-restored and rolled back first; a failure returns `400` with the reason. |
| `POST` | `/api/backups/:name/restore` | Saves the current state as `before-restore-*.json`, then replaces each table present in the file. Returns `{ counts, removed, safetyBackup }`. |
| `DELETE` | `/api/backups/:name` | Deletes it. Returns `204`. |

Names must match `^[A-Za-z0-9][A-Za-z0-9._-]*\.json$`. A restore removes history rows whose device, sensor or user isn't in the backup.

---

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
