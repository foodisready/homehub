import fs from 'fs';
import path from 'path';
import { getDb } from '../db';
import { logger } from '../logger';
import { emitCameraSnapshot } from '../socket';
import * as bridge from './bridge';

/**
 * Camera snapshots, saved as JPEG files under data/snapshots/<camera>/<date>/,
 * with a row in camera_snapshots for each one. They're history, so JSON
 * backups leave them out.
 */

export function snapshotDir(): string {
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'db.sqlite');
  return path.join(path.dirname(dbPath), 'snapshots');
}

// ── Settings ──────────────────────────────────────────────────────

export interface CameraSettings {
  /** Save a snapshot when a camera reports motion. */
  motionSnapshots: boolean;
  /** Send a phone notification with each motion snapshot. */
  notify: boolean;
  /** Days to keep snapshots before deleting them. */
  keepDays: number;
  /** Minimum seconds between motion snapshots from one camera. */
  cooldownSeconds: number;
}

const DEFAULTS: CameraSettings = { motionSnapshots: true, notify: false, keepDays: 30, cooldownSeconds: 30 };
const KEYS: Record<keyof CameraSettings, string> = {
  motionSnapshots: 'camera_motion_snapshots',
  notify: 'camera_motion_notify',
  keepDays: 'camera_snapshot_keep_days',
  cooldownSeconds: 'camera_motion_cooldown_seconds',
};
export const LIMITS = { keepDays: [1, 365], cooldownSeconds: [5, 3600] } as const;

export function getSettings(): CameraSettings {
  const rows = getDb().prepare(`SELECT key, value FROM settings WHERE key IN (${Object.values(KEYS).map(() => '?').join(', ')})`)
    .all(...Object.values(KEYS)) as { key: string; value: string }[];
  const get = (k: keyof CameraSettings) => rows.find((r) => r.key === KEYS[k])?.value;
  const num = (k: 'keepDays' | 'cooldownSeconds') => {
    const n = Number(get(k));
    const [min, max] = LIMITS[k];
    return Number.isInteger(n) && n >= min && n <= max ? n : DEFAULTS[k];
  };
  const bool = (k: 'motionSnapshots' | 'notify') => (get(k) === undefined ? DEFAULTS[k] : get(k) === '1');
  return { motionSnapshots: bool('motionSnapshots'), notify: bool('notify'), keepDays: num('keepDays'), cooldownSeconds: num('cooldownSeconds') };
}

export function saveSettings(patch: Partial<CameraSettings>): CameraSettings {
  const upsert = getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch) as [keyof CameraSettings, unknown][]) {
    if (!(k in KEYS)) continue;
    if (k === 'motionSnapshots' || k === 'notify') {
      if (typeof v !== 'boolean') throw new Error(`${k} must be true or false`);
      upsert.run(KEYS[k], v ? '1' : '0');
    } else {
      const [min, max] = LIMITS[k];
      if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new Error(`${k} must be a whole number from ${min} to ${max}`);
      upsert.run(KEYS[k], String(v));
    }
  }
  return getSettings();
}

// ── Capture ───────────────────────────────────────────────────────

export interface Snapshot {
  id: number;
  deviceId: number | null;
  camera: string;
  cameraName: string;
  trigger: 'motion' | 'manual';
  sizeBytes: number;
  takenAt: string;   // ISO, UTC
}

interface SnapshotRow {
  id: number; device_id: number | null; camera: string; camera_name: string;
  file: string; trigger: 'motion' | 'manual'; size_bytes: number; taken_at: string;
}

const toSnapshot = (r: SnapshotRow): Snapshot => ({
  id: r.id, deviceId: r.device_id, camera: r.camera, cameraName: r.camera_name,
  trigger: r.trigger, sizeBytes: r.size_bytes, takenAt: r.taken_at.replace(' ', 'T') + 'Z',
});

/** Safe as one path segment: the bridge's names are already URI-safe, but don't trust that. */
const segment = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'camera';

function localStamp(d: Date): { day: string; time: string } {
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`,
  };
}

/** Takes a picture from the camera now and saves it. */
export async function capture(
  device: { id: number | null; alias: string; cam: string },
  trigger: 'motion' | 'manual',
  now = new Date(),
): Promise<Snapshot> {
  const jpeg = await bridge.snapshot(device.cam, true);
  const { day, time } = localStamp(now);
  const dir = path.join(snapshotDir(), segment(device.cam), day);
  fs.mkdirSync(dir, { recursive: true });
  let name = `${time}.jpg`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${time}-${i}.jpg`;
  const file = path.join(segment(device.cam), day, name);
  fs.writeFileSync(path.join(snapshotDir(), file), jpeg);

  const taken = now.toISOString().slice(0, 19).replace('T', ' ');
  const { lastInsertRowid } = getDb().prepare(
    'INSERT INTO camera_snapshots (device_id, camera, camera_name, file, trigger, size_bytes, taken_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(device.id, device.cam, device.alias, file, trigger, jpeg.length, taken);
  const snap = getSnapshot(Number(lastInsertRowid))!;
  emitCameraSnapshot({ id: snap.id, deviceId: snap.deviceId, cameraName: snap.cameraName, trigger, takenAt: snap.takenAt });
  return snap;
}

// ── Read / delete ─────────────────────────────────────────────────

export function getSnapshot(id: number): Snapshot | null {
  const row = getDb().prepare('SELECT * FROM camera_snapshots WHERE id = ?').get(id) as SnapshotRow | undefined;
  return row ? toSnapshot(row) : null;
}

/** The file on disk, checked to be inside the snapshots folder. */
export function snapshotFile(id: number): string | null {
  const row = getDb().prepare('SELECT file FROM camera_snapshots WHERE id = ?').get(id) as { file: string } | undefined;
  if (!row) return null;
  const root = path.resolve(snapshotDir());
  const full = path.resolve(root, row.file);
  return full.startsWith(root + path.sep) && fs.existsSync(full) ? full : null;
}

/** Newest first. `before` is a snapshot id, for paging. */
export function listSnapshots(opts: { deviceId?: number; before?: number; limit?: number } = {}): Snapshot[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.deviceId !== undefined) { where.push('device_id = ?'); args.push(opts.deviceId); }
  if (opts.before !== undefined) { where.push('id < ?'); args.push(opts.before); }
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  const rows = getDb().prepare(
    `SELECT * FROM camera_snapshots ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
  ).all(...args, limit) as SnapshotRow[];
  return rows.map(toSnapshot);
}

export function latestFor(deviceId: number): Snapshot | null {
  const row = getDb().prepare('SELECT * FROM camera_snapshots WHERE device_id = ? ORDER BY id DESC LIMIT 1').get(deviceId) as SnapshotRow | undefined;
  return row ? toSnapshot(row) : null;
}

export function deleteSnapshot(id: number): boolean {
  const file = snapshotFile(id);
  const { changes } = getDb().prepare('DELETE FROM camera_snapshots WHERE id = ?').run(id);
  if (file) fs.rmSync(file, { force: true });
  return changes > 0;
}

/** Deletes snapshots older than the keep setting, and the folders they leave empty. */
export function pruneSnapshots(now = Date.now()): number {
  const { keepDays } = getSettings();
  const cutoff = new Date(now - keepDays * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
  const old = getDb().prepare('SELECT id FROM camera_snapshots WHERE taken_at < ?').all(cutoff) as { id: number }[];
  for (const { id } of old) deleteSnapshot(id);
  removeEmptyDirs(snapshotDir());
  if (old.length) logger.info({ deleted: old.length, keepDays }, 'Pruned old camera snapshots');
  return old.length;
}

function removeEmptyDirs(dir: string, isRoot = true): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(path.join(dir, entry.name), false);
  }
  if (!isRoot && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}
