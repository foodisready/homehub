import Database from 'better-sqlite3';
import path from 'path';
import { logger } from '../logger';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'db.sqlite');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    migrate(_db);
    logger.info({ path: DB_PATH }, 'Database initialized');
  }
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      alias      TEXT    NOT NULL UNIQUE,
      ip         TEXT    NOT NULL UNIQUE,
      model      TEXT,
      has_emeter INTEGER NOT NULL DEFAULT 0,
      icon       TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS energy_readings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      wattage     REAL,
      voltage     REAL,
      current     REAL,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_energy_device_recorded
      ON energy_readings(device_id, recorded_at);

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL CHECK(role IN ('admin', 'member')) DEFAULT 'member',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id            INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      label                TEXT    NOT NULL,
      trigger_type         TEXT    NOT NULL CHECK(trigger_type IN ('cron', 'solar')),
      cron_expression      TEXT,
      solar_event          TEXT,
      solar_offset_minutes INTEGER NOT NULL DEFAULT 0,
      state                INTEGER NOT NULL CHECK(state IN (0, 1)),
      enabled              INTEGER NOT NULL DEFAULT 1,
      created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint   TEXT    NOT NULL UNIQUE,
      p256dh     TEXT    NOT NULL,
      auth       TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scenes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL UNIQUE,
      icon       TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scene_actions (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      scene_id  INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
      device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      state     INTEGER NOT NULL CHECK(state IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS chat_commands (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      text       TEXT NOT NULL,
      handled_by TEXT NOT NULL CHECK(handled_by IN ('rules', 'model')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS voice_commands (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      text       TEXT NOT NULL,
      understood INTEGER NOT NULL CHECK(understood IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS motion_rules (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT    NOT NULL UNIQUE,
      token             TEXT    NOT NULL UNIQUE,
      device_id         INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      off_after_minutes INTEGER NOT NULL,
      occupied          INTEGER NOT NULL DEFAULT 0 CHECK(occupied IN (0, 1)),
      last_motion_at    TEXT,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Additive migrations — safe to re-run (SQLite ignores duplicate column errors)
  try { db.exec('ALTER TABLE motion_rules ADD COLUMN turn_on_with_motion INTEGER NOT NULL DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE motion_rules ADD COLUMN sensor_ip TEXT'); } catch {}
  try { db.exec('ALTER TABLE motion_rules ADD COLUMN sensor_username TEXT'); } catch {}
  try { db.exec('ALTER TABLE motion_rules ADD COLUMN sensor_password TEXT'); } catch {}
  // When motion may turn the light on: 'always', 'dark' (sensor's light reading), 'sun' or 'hours'.
  try { db.exec("ALTER TABLE motion_rules ADD COLUMN turn_on_when TEXT NOT NULL DEFAULT 'always'"); } catch {}
  try { db.exec('ALTER TABLE motion_rules ADD COLUMN dark_below_lux INTEGER NOT NULL DEFAULT 100'); } catch {}
  try { db.exec('ALTER TABLE motion_rules ADD COLUMN sun_offset_minutes INTEGER NOT NULL DEFAULT 0'); } catch {}
  try { db.exec("ALTER TABLE motion_rules ADD COLUMN hours_from TEXT NOT NULL DEFAULT '17:00'"); } catch {}
  try { db.exec("ALTER TABLE motion_rules ADD COLUMN hours_to TEXT NOT NULL DEFAULT '08:00'"); } catch {}
  try { db.exec('ALTER TABLE motion_rules ADD COLUMN last_lux INTEGER'); } catch {}
  try { db.exec('ALTER TABLE motion_rules ADD COLUMN last_lux_at TEXT'); } catch {}
  try { db.exec('ALTER TABLE motion_rules ADD COLUMN skipped_at TEXT'); } catch {}
  try { db.exec('ALTER TABLE motion_rules ADD COLUMN skipped_reason TEXT'); } catch {}
  // A Ring camera whose motion and doorbell presses count as motion for the rule. Ring's own id: Ring cameras aren't devices.
  try { db.exec('ALTER TABLE motion_rules ADD COLUMN ring_camera_id INTEGER'); } catch {}
  // A rule's lights. motion_rules.device_id stays its first light, so older backups and code still
  // find one; the view reads both, so a rule with no rows here still has that light.
  db.exec(`
    CREATE TABLE IF NOT EXISTS motion_rule_devices (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id   INTEGER NOT NULL REFERENCES motion_rules(id) ON DELETE CASCADE,
      device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      UNIQUE (rule_id, device_id)
    );
    CREATE INDEX IF NOT EXISTS idx_motion_rule_devices_device ON motion_rule_devices(device_id);
    INSERT OR IGNORE INTO motion_rule_devices (rule_id, device_id) SELECT id, device_id FROM motion_rules;
    CREATE VIEW IF NOT EXISTS motion_rule_lights AS
      SELECT id AS rule_id, device_id FROM motion_rules
      UNION SELECT rule_id, device_id FROM motion_rule_devices;
    -- Deleting a rule's first light would delete the rule: when it has another light, that one becomes first.
    CREATE TRIGGER IF NOT EXISTS motion_rule_keeps_lights BEFORE DELETE ON devices
    BEGIN
      UPDATE motion_rules
         SET device_id = (SELECT device_id FROM motion_rule_devices
                           WHERE rule_id = motion_rules.id AND device_id <> OLD.id ORDER BY id LIMIT 1)
       WHERE device_id = OLD.id
         AND EXISTS (SELECT 1 FROM motion_rule_devices WHERE rule_id = motion_rules.id AND device_id <> OLD.id);
    END;
  `);
  try { db.exec('ALTER TABLE devices ADD COLUMN override_state INTEGER'); } catch {}
  try { db.exec('ALTER TABLE devices ADD COLUMN override_until TEXT'); } catch {}
  try { db.exec('ALTER TABLE devices ADD COLUMN timer_off_at TEXT'); } catch {}
  // The schedule that set the timer, when one did ("Turn off after" on a Turn ON schedule).
  try { db.exec('ALTER TABLE devices ADD COLUMN timer_label TEXT'); } catch {}
  try { db.exec('ALTER TABLE devices ADD COLUMN nicknames TEXT'); } catch {}
  try { db.exec('ALTER TABLE scenes ADD COLUMN nicknames TEXT'); } catch {}
  // An admin's choice: this scene may pause cameras when run by voice or Chat.
  try { db.exec('ALTER TABLE scenes ADD COLUMN voice_may_pause INTEGER NOT NULL DEFAULT 0'); } catch {}
  // A scene's Sonos action: the favorite or Sonos playlist it starts, as JSON { id, title }. Null: Play carries on.
  try { db.exec('ALTER TABLE scene_actions ADD COLUMN play TEXT'); } catch {}
  // A scene's Sonos Play action: the volume it sets on that speaker first. Null: left as it is.
  try { db.exec('ALTER TABLE scene_actions ADD COLUMN volume INTEGER'); } catch {}
  // What the Sonos speakers played recently, to play again: what HomeHub started, and stations seen playing.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sonos_recent (
      key       TEXT PRIMARY KEY,
      kind      TEXT NOT NULL,
      title     TEXT NOT NULL,
      note      TEXT,
      art       TEXT,
      payload   TEXT NOT NULL,
      played_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Set when someone teaches HomeHub what a missed command meant, or dismisses it.
  try { db.exec('ALTER TABLE chat_commands ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE voice_commands ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE devices ADD COLUMN room TEXT'); } catch {}
  try { db.exec('ALTER TABLE devices ADD COLUMN is_protected INTEGER NOT NULL DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE devices ADD COLUMN turned_on_at TEXT'); } catch {}
  try { db.exec("ALTER TABLE devices ADD COLUMN driver_type TEXT NOT NULL DEFAULT 'kasa'"); } catch {}
  // What it draws when on, set by a person, for energy estimates. Null: typical for its name, or measured.
  try { db.exec('ALTER TABLE devices ADD COLUMN watts REAL'); } catch {}
  try { db.exec('ALTER TABLE devices ADD COLUMN driver_config TEXT'); } catch {}
  try { db.exec('ALTER TABLE devices ADD COLUMN mac TEXT'); } catch {}
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_mac ON devices(driver_type, mac) WHERE mac IS NOT NULL');

  // Recreate schedules to add auto_off trigger type + duration_minutes column
  const schedCols = db.prepare("PRAGMA table_info(schedules)").all() as { name: string }[];
  if (!schedCols.some((c) => c.name === 'duration_minutes')) {
    db.exec(`
      BEGIN;
      CREATE TABLE schedules_v2 (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id            INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        label                TEXT    NOT NULL,
        trigger_type         TEXT    NOT NULL CHECK(trigger_type IN ('cron', 'solar', 'auto_off')),
        cron_expression      TEXT,
        solar_event          TEXT,
        solar_offset_minutes INTEGER NOT NULL DEFAULT 0,
        duration_minutes     INTEGER,
        state                INTEGER NOT NULL CHECK(state IN (0, 1)),
        enabled              INTEGER NOT NULL DEFAULT 1,
        created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schedules_v2
        (id, device_id, label, trigger_type, cron_expression, solar_event, solar_offset_minutes, state, enabled, created_at)
        SELECT id, device_id, label, trigger_type, cron_expression, solar_event, solar_offset_minutes, state, enabled, created_at
        FROM schedules;
      DROP TABLE schedules;
      ALTER TABLE schedules_v2 RENAME TO schedules;
      COMMIT;
    `);
  }
  // A Turn ON schedule's "Turn off after": the device's timer it sets when it runs.
  // After the rebuild above, which would drop it.
  try { db.exec('ALTER TABLE schedules ADD COLUMN stay_on_minutes INTEGER'); } catch {}
  // A robot vacuum's Clean schedule: the rooms it cleans, as a JSON list of room keys. Null: the whole house.
  try { db.exec('ALTER TABLE schedules ADD COLUMN rooms TEXT'); } catch {}
  // A Sonos Play schedule: the favorite or Sonos playlist it starts, as JSON { id, title }. Null: carry on with what was playing.
  try { db.exec('ALTER TABLE schedules ADD COLUMN play TEXT'); } catch {}

  // ── AuraFlow / sensor subsystem ────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS sensors (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      sensor_id           TEXT    NOT NULL UNIQUE,
      type                TEXT    NOT NULL,
      alias               TEXT    NOT NULL,
      config              TEXT,
      first_seen_mac      TEXT,
      last_seen_at        TEXT,
      last_rssi           INTEGER,
      last_uptime_sec     INTEGER,
      last_signal_quality INTEGER,
      firmware_version    TEXT,
      pending_state       TEXT    NOT NULL DEFAULT 'idle' CHECK(pending_state IN ('idle','flowing')),
      pending_count       INTEGER NOT NULL DEFAULT 0,
      snoozed_until       TEXT,
      created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS flow_readings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sensor_id       INTEGER NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
      rate_m3h        REAL    NOT NULL,
      total_m3        REAL,
      signal_quality  INTEGER,
      t_offset_ms     INTEGER NOT NULL DEFAULT 0,
      recorded_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_flow_readings_sensor_time
      ON flow_readings(sensor_id, recorded_at);

    CREATE TABLE IF NOT EXISTS flow_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      sensor_id    INTEGER NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
      start_time   TEXT    NOT NULL DEFAULT (datetime('now')),
      end_time     TEXT,
      peak_rate    REAL    NOT NULL DEFAULT 0,
      avg_rate     REAL,
      total_m3     REAL,
      total_m3_start REAL,
      status       TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),
      alert_level  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_flow_events_active
      ON flow_events(sensor_id, status);

    CREATE TABLE IF NOT EXISTS flow_event_acks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id    INTEGER NOT NULL REFERENCES flow_events(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      acked_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      reason      TEXT
    );

    CREATE TABLE IF NOT EXISTS notification_preferences (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel           TEXT    NOT NULL CHECK(channel IN ('push','email','sms','voice')),
      min_level         INTEGER NOT NULL DEFAULT 1,
      quiet_hours_from  TEXT,
      quiet_hours_to    TEXT,
      enabled           INTEGER NOT NULL DEFAULT 1,
      destination       TEXT,
      UNIQUE(user_id, channel)
    );

    CREATE TABLE IF NOT EXISTS notification_dispatches (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id      INTEGER NOT NULL REFERENCES flow_events(id) ON DELETE CASCADE,
      user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      channel       TEXT    NOT NULL,
      level         INTEGER NOT NULL,
      sent_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      acked_at      TEXT,
      ack_token     TEXT    UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_notif_dispatches_event
      ON notification_dispatches(event_id);

    CREATE TABLE IF NOT EXISTS subscription (
      license_key   TEXT PRIMARY KEY,
      tier          TEXT NOT NULL DEFAULT 'free',
      features_json TEXT NOT NULL DEFAULT '[]',
      cached_at     TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at    TEXT,
      grace_until   TEXT
    );
  `);

  // ── AuraFlow Phase 6: shutoff tracking on flow_events ─────────
  // Additive — safe to re-run.
  try { db.exec("ALTER TABLE flow_events ADD COLUMN shutoff_status TEXT NOT NULL DEFAULT 'not_fired'"); } catch {}
  try { db.exec('ALTER TABLE flow_events ADD COLUMN shutoff_fired_at TEXT'); } catch {}
  try { db.exec('ALTER TABLE flow_events ADD COLUMN shutoff_completed_at TEXT'); } catch {}
  try { db.exec('ALTER TABLE flow_events ADD COLUMN shutoff_rate_at_fire REAL'); } catch {}

  // ── AuraFlow stale-sensor detection ────────────────────────────
  try { db.exec('ALTER TABLE sensors ADD COLUMN stale_since TEXT'); } catch {}

  // ── AuraFlow firmware releases (admin-uploaded .bin store) ─────
  // Captured on every successful ingestion so HomeHub knows where to POST
  // /ota when an admin clicks "Update". DHCP-friendly — refreshes on each
  // reading. Static-IP devices never change.
  try { db.exec('ALTER TABLE sensors ADD COLUMN last_ip TEXT'); } catch {}
  // Last-known meter reachability — set on every ingestion. NULL until the
  // first reading from firmware that emits the field. 1=reachable,
  // 0=unreachable (Modbus read failed; device is alive and posting
  // diagnostic heartbeats).
  try { db.exec('ALTER TABLE sensors ADD COLUMN last_meter_reachable INTEGER'); } catch {}

  // ── Activity: device changes and their causes ─────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id    INTEGER REFERENCES devices(id) ON DELETE SET NULL,
      device_alias TEXT    NOT NULL,
      kind         TEXT    NOT NULL CHECK(kind IN ('power', 'online')),
      state        INTEGER NOT NULL CHECK(state IN (0, 1)),
      source       TEXT    NOT NULL,
      detail       TEXT,
      via          TEXT,
      user_name    TEXT,             -- kept as text, so it survives the user being removed
      at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_device_events_device ON device_events(device_id, kind, id);
    CREATE INDEX IF NOT EXISTS idx_device_events_at ON device_events(at);
  `);

  // ── The alarm system's history (alarmcom/alarmcom.ts): arming, disarming and sensors ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS alarm_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT    NOT NULL CHECK(kind IN ('arm', 'sensor')),
      name       TEXT    NOT NULL,   -- the partition or sensor, as Alarm.com names it
      state      TEXT    NOT NULL,   -- 'armed-away', 'disarmed', 'open', 'closed', …
      source     TEXT    NOT NULL,   -- 'app': from HomeHub; 'outside': the keypad, the Alarm.com app, a door
      user_name  TEXT,               -- who, from HomeHub
      detail     TEXT,
      at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_alarm_events_at ON alarm_events(at);
  `);
  // Alarm.com's own id for an event read from its history, so a read twice is saved once.
  try { db.exec('ALTER TABLE alarm_events ADD COLUMN ext_id TEXT'); } catch {}
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_alarm_events_ext ON alarm_events(ext_id) WHERE ext_id IS NOT NULL');

  // ── Camera snapshots (files under data/snapshots) ──────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS camera_snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id   INTEGER REFERENCES devices(id) ON DELETE SET NULL,
      camera      TEXT    NOT NULL,
      camera_name TEXT    NOT NULL,
      file        TEXT    NOT NULL UNIQUE,
      trigger     TEXT    NOT NULL CHECK(trigger IN ('motion', 'manual')),
      size_bytes  INTEGER NOT NULL,
      taken_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_camera_snapshots_taken ON camera_snapshots(taken_at);
    CREATE INDEX IF NOT EXISTS idx_camera_snapshots_device ON camera_snapshots(device_id, taken_at);
  `);
  // 'doorbell' for a snapshot taken when a Ring doorbell was pressed (its trigger is 'motion').
  try { db.exec('ALTER TABLE camera_snapshots ADD COLUMN detail TEXT'); } catch {}
  db.exec('CREATE INDEX IF NOT EXISTS idx_camera_snapshots_camera ON camera_snapshots(camera, id)');

  // ── IP cameras reached directly on the home network (ONVIF / RTSP) ──
  // URLs are kept without the login, which has its own columns.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ip_cameras (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      host         TEXT    NOT NULL,
      onvif_port   INTEGER,                 -- NULL: added by its RTSP address, no ONVIF
      username     TEXT    NOT NULL DEFAULT '',
      password     TEXT    NOT NULL DEFAULT '',
      main_url     TEXT    NOT NULL,
      sub_url      TEXT,
      snapshot_url TEXT,
      quality      TEXT    NOT NULL DEFAULT 'main' CHECK(quality IN ('main', 'sub')),
      maker        TEXT,
      model        TEXT,
      can_pan      INTEGER NOT NULL DEFAULT 0,
      motion       INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS firmware_releases (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      target      TEXT    NOT NULL DEFAULT 'auraflow-mainline',
      version     TEXT    NOT NULL,
      filename    TEXT    NOT NULL UNIQUE,
      sha256      TEXT    NOT NULL,
      size_bytes  INTEGER NOT NULL,
      notes       TEXT,
      uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      uploaded_at TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(target, version)
    );
    CREATE INDEX IF NOT EXISTS idx_firmware_target_uploaded
      ON firmware_releases(target, uploaded_at DESC);
  `);

  // ── Matter: HomeHub's own Matter identity and its paired devices ──
  // Kept here rather than in files, so backups and restores carry it: losing
  // it means pairing every Matter device again. It holds private keys.
  db.exec(`
    CREATE TABLE IF NOT EXISTS matter_storage (
      namespace TEXT NOT NULL,
      context   TEXT NOT NULL,
      key       TEXT NOT NULL,
      value     TEXT NOT NULL,
      PRIMARY KEY (namespace, context, key)
    );
  `);

  // ── Thermostats: each one's comfort range and limits, in °C ──
  // comfort: where the home should be when people are in and awake, for advice and the card.
  // allowed: the most that Chat, voice, schedules and scenes may ever set, for nights and time away too.
  db.exec(`
    CREATE TABLE IF NOT EXISTS thermostats (
      device_id     INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      comfort_low   REAL    NOT NULL,
      comfort_high  REAL    NOT NULL,
      allowed_low   REAL    NOT NULL,
      allowed_high  REAL    NOT NULL,
      last_mode     TEXT
    );
  `);
  // When the temperature schedule last looked for changes due, so one missed while HomeHub was down is made when it's back.
  try { db.exec('ALTER TABLE thermostats ADD COLUMN schedule_checked_at TEXT'); } catch {}
  // A thermostat's temperature schedule: on these days (bit 0 Sunday … bit 6 Saturday), at a time
  // or at sunrise or sunset, set the heating and cooling targets (°C). The mode is left alone.
  db.exec(`
    CREATE TABLE IF NOT EXISTS thermostat_schedule (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id     INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      days          INTEGER NOT NULL CHECK(days BETWEEN 1 AND 127),
      at_minute     INTEGER CHECK(at_minute BETWEEN 0 AND 1439),
      solar_event   TEXT    CHECK(solar_event IN ('sunrise', 'sunset')),
      solar_offset  INTEGER NOT NULL DEFAULT 0,
      heat          REAL,
      cool          REAL,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      CHECK ((at_minute IS NULL) <> (solar_event IS NULL)),
      CHECK (heat IS NOT NULL OR cool IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_thermostat_schedule ON thermostat_schedule(device_id);
  `);

  // ── Thermostat history ──
  // samples: every 5 minutes, for the day chart. runs: each time heating or cooling ran,
  // from the thermostat's own reports, for running hours. outdoor_hours: the outdoor
  // temperature each hour of the home's local time, for degree-days.
  db.exec(`
    CREATE TABLE IF NOT EXISTS thermostat_samples (
      device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      at          TEXT    NOT NULL,
      temperature REAL,
      heat        REAL,
      cool        REAL,
      mode        TEXT,
      running     TEXT,
      PRIMARY KEY (device_id, at)
    );
    CREATE TABLE IF NOT EXISTS thermostat_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      kind        TEXT    NOT NULL,
      started_at  TEXT    NOT NULL,
      ended_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_thermostat_runs ON thermostat_runs(device_id, started_at);
    CREATE TABLE IF NOT EXISTS outdoor_hours (
      hour    TEXT PRIMARY KEY,
      temp_c  REAL NOT NULL
    );
  `);

  // ── Energy ──
  // homehub_uptime: when HomeHub was running, so time it wasn't watching isn't counted as on.
  // device_energy_days: each device's hours on and measured energy per local day, kept for
  // good: the activity they're made from is only kept for a while.
  db.exec(`
    CREATE TABLE IF NOT EXISTS homehub_uptime (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at  TEXT NOT NULL,
      last_seen   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS device_energy_days (
      device_id     INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      day           TEXT    NOT NULL,
      on_seconds    REAL    NOT NULL,
      known_seconds REAL    NOT NULL,
      measured_wh   REAL,
      PRIMARY KEY (device_id, day)
    );
  `);
  // A thermostat's heating and cooling system, for estimating what its running hours cost.
  try { db.exec('ALTER TABLE thermostats ADD COLUMN heat_system TEXT'); } catch {}
  try { db.exec('ALTER TABLE thermostats ADD COLUMN heat_size REAL'); } catch {}
  try { db.exec('ALTER TABLE thermostats ADD COLUMN cool_system TEXT'); } catch {}
  try { db.exec('ALTER TABLE thermostats ADD COLUMN cool_size REAL'); } catch {}
  // Zones on one heating and cooling unit: the thermostat whose system this one shares, so the unit is counted once.
  try { db.exec('ALTER TABLE thermostats ADD COLUMN shares_system_with INTEGER'); } catch {}

  // ── Family invites: a QR code that lets someone make their own login ──
  // Only a hash of the code is kept, so a copy of the DB can't be used to join.
  db.exec(`
    CREATE TABLE IF NOT EXISTS invites (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code_hash   TEXT    NOT NULL UNIQUE,
      created_by  INTEGER REFERENCES users(id) ON DELETE CASCADE,
      expires_at  TEXT    NOT NULL,
      max_uses    INTEGER NOT NULL,
      uses        INTEGER NOT NULL DEFAULT 0,
      cancelled   INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  // ── Family: daily check-ins and spoken reminders ───────────────
  // Times are the home's local "HH:MM"; days are local weekdays, 0 = Sunday.
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkins (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      enabled       INTEGER NOT NULL DEFAULT 1,
      from_time     TEXT    NOT NULL DEFAULT '05:00',
      by_time       TEXT    NOT NULL DEFAULT '11:00',
      days          TEXT    NOT NULL DEFAULT '0123456',
      devices       TEXT,              -- JSON list of device ids that count; null: all
      motion        TEXT,              -- JSON list of motion rule ids; null: all but Ring cameras
      app_users     TEXT,              -- JSON list of user names whose app use counts; null: everyone
      voice         INTEGER NOT NULL DEFAULT 1,
      water         INTEGER NOT NULL DEFAULT 1,
      paused_until  TEXT,              -- a local day, YYYY-MM-DD, last day paused
      last_day      TEXT,              -- the local day last checked
      last_result   TEXT,              -- ok | alerted | all-clear | missed | away
      last_sign_at  TEXT,
      last_sign     TEXT,
      alerted_at    TEXT,
      created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      text          TEXT    NOT NULL,
      language      TEXT    NOT NULL DEFAULT 'auto',
      at_time       TEXT    NOT NULL,
      days          TEXT    NOT NULL DEFAULT '0123456',
      enabled       INTEGER NOT NULL DEFAULT 1,
      last_day      TEXT,
      last_status   TEXT,
      last_said_at  TEXT,
      created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- Motion a sensor reported, so a check-in can count it: kept as long as Activity.
    CREATE TABLE IF NOT EXISTS motion_seen (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id  INTEGER NOT NULL,
      at       TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_motion_seen_at ON motion_seen(at);

    -- Calls for help (SOS): by voice, a button or the app. Times are ISO.
    CREATE TABLE IF NOT EXISTS sos_alerts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at     TEXT    NOT NULL,
      via            TEXT    NOT NULL CHECK(via IN ('voice', 'button', 'app')),
      place          TEXT,
      who            TEXT,
      lang           TEXT,
      heard          TEXT,
      rounds         INTEGER NOT NULL DEFAULT 0,
      last_round_at  TEXT,
      told           TEXT,
      acked_at       TEXT,
      acked_by       TEXT,
      cancelled_at   TEXT,
      cancelled_by   TEXT,
      ended_at       TEXT
    );

    -- A reminder that asks back ("食咗藥未呀？"): one row a day, with the answer.
    CREATE TABLE IF NOT EXISTS reminder_asks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      reminder_id  INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
      day          TEXT    NOT NULL,
      first_at     TEXT    NOT NULL,
      last_at      TEXT    NOT NULL,
      asks         INTEGER NOT NULL DEFAULT 1,
      answer       TEXT,
      answered_at  TEXT,
      answered_by  TEXT,
      told_at      TEXT,
      UNIQUE(reminder_id, day)
    );

    -- A panel monitor's energy by hour (local "YYYY-MM-DDTHH") and clamp, from its running totals.
    CREATE TABLE IF NOT EXISTS panel_hours (
      hour     TEXT NOT NULL,
      channel  TEXT NOT NULL,
      wh       REAL NOT NULL,
      PRIMARY KEY (hour, channel)
    );
    -- The last running total read from each clamp, so time HomeHub was off is still counted.
    CREATE TABLE IF NOT EXISTS panel_counters (
      channel  TEXT PRIMARY KEY,
      wh       REAL NOT NULL,
      at       TEXT NOT NULL
    );

    -- Buttons that call for help: a press visits /sos/<token>/help, a double press /sos/<token>/cancel.
    CREATE TABLE IF NOT EXISTS sos_buttons (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      token       TEXT    NOT NULL UNIQUE,
      last_used_at TEXT,
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  try { db.exec('ALTER TABLE reminders ADD COLUMN ask INTEGER NOT NULL DEFAULT 0'); } catch {}
  // A one-time reminder's day ("remind me at 3 to call the doctor"); null repeats on its days.
  try { db.exec('ALTER TABLE reminders ADD COLUMN on_day TEXT'); } catch {}
  // A PIN that unlocks a shared screen (the wall display) signed in as this person; hashed like passwords.
  try { db.exec('ALTER TABLE users ADD COLUMN lock_pin TEXT'); } catch {}

  // A check-in can ask at home before telling the family: "亞娘，你冇事吖嘛？"
  try { db.exec('ALTER TABLE checkins ADD COLUMN ask_first INTEGER NOT NULL DEFAULT 0'); } catch {}
  try { db.exec("ALTER TABLE checkins ADD COLUMN ask_lang TEXT NOT NULL DEFAULT 'auto'"); } catch {}
  db.exec(`
    -- A check-in's question at home, one row a day: answer 'yes' (I'm OK) or 'no' (I'm not).
    CREATE TABLE IF NOT EXISTS checkin_asks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      checkin_id   INTEGER NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
      day          TEXT    NOT NULL,
      lang         TEXT    NOT NULL,
      first_at     TEXT    NOT NULL,
      last_at      TEXT    NOT NULL,
      asks         INTEGER NOT NULL DEFAULT 1,
      said         INTEGER NOT NULL DEFAULT 0,   -- how many of the asks a speaker said
      answer       TEXT,
      answered_at  TEXT,
      closed_at    TEXT,
      UNIQUE(checkin_id, day)
    );
  `);
}
