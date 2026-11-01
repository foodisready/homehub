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

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);

  // Additive migrations — safe to re-run (SQLite ignores duplicate column errors)
  try { db.exec('ALTER TABLE devices ADD COLUMN override_state INTEGER'); } catch {}
  try { db.exec('ALTER TABLE devices ADD COLUMN override_until TEXT'); } catch {}
  try { db.exec('ALTER TABLE devices ADD COLUMN timer_off_at TEXT'); } catch {}
  try { db.exec('ALTER TABLE devices ADD COLUMN nicknames TEXT'); } catch {}
  try { db.exec('ALTER TABLE devices ADD COLUMN is_protected INTEGER NOT NULL DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE devices ADD COLUMN turned_on_at TEXT'); } catch {}
  try { db.exec("ALTER TABLE devices ADD COLUMN driver_type TEXT NOT NULL DEFAULT 'kasa'"); } catch {}
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
}
