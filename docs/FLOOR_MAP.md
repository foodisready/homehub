# Floor map

A third way to see the dashboard, beside **Rooms** and **List**: a picture of the home with each room
marked on it. Tap a room on the picture to go into it. Made for people who find their way by where
things are rather than by reading names, such as elders and family who don't read English.

## What it does

- **Any picture of the home.** An admin uploads a photo or screenshot: the iRobot app's map, the
  house's floor plan, or a sketch on paper photographed with the phone. One picture per floor, each
  with a name (Main floor, Upstairs).
- **Rooms placed by hand.** In **Edit map**, the rooms HomeHub knows (from its devices' rooms) are
  listed. Tap one, then tap where it is on the picture. Drag a marker to move it, or remove it.
- **The picture shows what's on.** A room's marker glows warm when its lights are on, and says how
  many things are on. A thermostat's temperature, an open door and offline devices show as on the
  room tiles.
- **Tap a room** and it opens just as in the Rooms view: its devices as large bubbles, tap to switch,
  press and hold for controls, **All off**. **Back** returns to the map.
- **Names people can read.** A marker shows the room's name as the room is called in HomeHub, so a
  room named 廚房 reads 廚房.
- **Each phone remembers its view**, as it does for Rooms and List, so a grandparent's phone can
  always open on the map.
- **Zoom** with + and − for a wide map on a phone; the picture scrolls.
- Everyone sees the map; only admins change it. Members with no map see that an admin can add one.

## How it's built

### Backend

- Table `floor_maps`: `id`, `name`, `position`, `image` (BLOB), `mime`, `updated_at`.
- Table `floor_pins`: `floor_id` (cascade on delete), `room`, `x`, `y` (0–1, a share of the picture's
  width and height, so a marker stays put however large the picture is shown). One marker per room per
  floor.
- The picture is kept in the database, so the daily backup and a restore include it with nothing more.
  The JSON settings backup leaves pictures out, as it does history.
- The phone shrinks the picture before sending it (longest side 2,000 px, JPEG): a phone photo is
  several MB; the shrunk one is a few hundred KB. The backend accepts JPEG, PNG and WebP up to 4 MB,
  checked by their first bytes, not the name.
- `/api/floors` (signed in):
  - `GET /` floors in order, with their markers, without pictures
  - `GET /:id/image` the picture, cached by the browser until it changes
  - `POST /` (admin) a new floor: multipart `image` and `name`
  - `PUT /:id` (admin) `{ name }`
  - `PUT /:id/image` (admin) a new picture; the markers stay
  - `PUT /:id/pins` (admin) `{ pins: [{ room, x, y }] }`, replacing the floor's markers
  - `DELETE /:id` (admin)
- A backup Pi refuses changes, as for every other setting (`backupReadOnly`).

### Frontend

- `FloorsService`: the floors, and the calls above.
- `FloorMapComponent` (dashboard): floor tabs when there's more than one, the picture with its markers,
  zoom, and the empty state. For admins, **Edit map**: add or replace a picture, name the floor, place,
  move and remove markers, delete the floor.
- The dashboard's view switch gets **Map**. Tapping a marker shows `RoomsViewComponent` opened on that
  room (a new `startRoom` input); its back button returns to the map.
- A marker whose room no longer has devices (renamed or emptied) isn't shown on the map; **Edit map**
  lists it so it can be moved to the new name or removed.

## Not in this version

- Drawing a floor plan in HomeHub. A sketch on paper, photographed, does the same job.
- Reading the robot's map automatically: the robot keeps only room numbers; the map is in iRobot's
  cloud.
- Room outlines (tapping anywhere in a room's area). Markers are easier to place and to hit with a
  finger.
- The wall display keeps its rooms view.
