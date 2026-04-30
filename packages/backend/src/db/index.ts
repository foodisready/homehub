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

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);

  // Additive migrations — safe to re-run (SQLite ignores duplicate column errors)
  try { db.exec('ALTER TABLE devices ADD COLUMN override_state INTEGER'); } catch {}
  try { db.exec('ALTER TABLE devices ADD COLUMN override_until TEXT'); } catch {}
  try { db.exec('ALTER TABLE devices ADD COLUMN turned_on_at TEXT'); } catch {}
  try { db.exec("ALTER TABLE devices ADD COLUMN driver_type TEXT NOT NULL DEFAULT 'kasa'"); } catch {}
  try { db.exec('ALTER TABLE devices ADD COLUMN driver_config TEXT'); } catch {}

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
}
