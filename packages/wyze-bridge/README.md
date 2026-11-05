# Wyze camera bridge

HomeHub's camera bridge image is [IDisposable's wyze-bridge](https://hub.docker.com/r/idisposablegithub365/wyze-bridge) 4.5.0, with one change: its [go2rtc](https://github.com/AlexxIT/go2rtc) 1.9.14 is rebuilt from source with `go2rtc-wyze-ptz.patch`, which adds pan and tilt for Wyze Pan cameras. Everything else in the image is upstream's, unchanged.

The release workflow builds it for arm64 and amd64 as `ghcr.io/foodisready/homehub-wyze-bridge`, tagged with the HomeHub version. The build checks out go2rtc's tag, checks its commit matches the one the upstream image ships, applies the patch and runs its tests.

## What the patch adds

`POST /api/wyze/ptz` and `GET /api/wyze/ptz` on go2rtc's API, which HomeHub's backend uses to turn a camera:

| Request | Does |
|---|---|
| `GET ?src=<stream>` | `{ "position": { "horizontal", "vertical" }, "motion_tracking" }` |
| `POST ?src=<stream>&action=left\|right\|up\|down[&speed=1-9]` | Starts the lens turning |
| `POST ?src=<stream>&action=stop` | Stops it |
| `POST ?src=<stream>&action=goto&h=<0-360>&v=<0-180>` | Turns to an angle |
| `POST ?src=<stream>&action=tracking&on=true\|false` | The camera's own motion tracking |

The commands are the camera's own, sent on the stream's command channel: K11002 to turn or stop, K11006 and K11018 to read and set the position, K11020 and K11022 for motion tracking. Their byte layout follows the old docker-wyze-bridge's encoder, and the tests check it byte for byte.

A command goes over the stream's connection when someone is watching. Otherwise one connection is opened for commands and kept for 30 seconds after the last one: each press sends a move and a stop, and the camera refuses some connections opened in quick succession.

## Tested on a Pan v3

On firmware 4.50.17.25, in one home:

- `left` and `right` start the lens turning, at about 75° a second, until `stop` or the end of its range (0° and 355° across). `left` lowers the angle. One `left` with no `stop` runs all the way to the end.
- `up` and `down` work the same way, at a similar speed. One second of `down` took the vertical angle from 83 to 0, and one second of `up` took it back to 77.
- `stop` holds it where it is.
- The position reads back as it changes. The vertical angle read 83, so the Pan v3's scale differs from the 0–40 the old bridge described for older Pans.

`goto` and `tracking` follow the same commands but haven't been tried on a real camera yet. HomeHub uses only the moves and `stop`.

## Updating

When the upstream image moves to a new go2rtc, update `GO2RTC_VERSION` and `GO2RTC_COMMIT` in the Dockerfile to the go2rtc it ships (`go2rtc -version` inside it) and check the patch still applies. If go2rtc adds pan and tilt for Wyze itself, HomeHub can go back to the upstream image.
