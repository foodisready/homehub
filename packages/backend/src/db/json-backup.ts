import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { getDb } from './index';
import { BackupError } from './backup-error';

/**
 * JSON backups of HomeHub's settings: devices, rooms, schedules, scenes,
 * motion rules, users and logins. History (energy readings, flow readings,
 * chat logs) is left out to keep files small enough to read and edit; the
 * daily SQLite backup in the same folder keeps that.
 *
 * Files sit next to the daily SQLite backups, in data/backups.
 */

export const BACKUP_TABLES = [
  'users',
  'devices',
  'sensors',
  'scenes',
  'scene_actions',
  'schedules',
  'motion_rules',
  'settings',
  'notification_preferences',
  'push_subscriptions',
] as const;
type TableName = typeof BACKUP_TABLES[number];

/** Columns holding JSON text, written into the backup as objects so they're easy to edit. */
const JSON_COLUMNS: Partial<Record<TableName, string[]>> = {
  devices: ['driver_config'],
  sensors: ['config'],
};

/** Shown in place of passwords and keys when a backup is viewed. */
export const HIDDEN = '<hidden>';

const SECRET_FIELD = /pass|secret|hash|token|^key$|localkey|^auth$|p256dh/i;
/** `settings` rows are key/value, so the row's key says whether its value is secret. */
const SECRET_SETTING = /pass|secret|auth|token|key/i;

const FORMAT = 'homehub-backup';
const VERSION = 1;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

type Row = Record<string, unknown>;
export interface BackupFile {
  format: string;
  version: number;
  created_at: string;
  note?: string;
  tables: Partial<Record<TableName, Row[]>>;
}
export interface BackupEntry {
  name: string;
  createdAt: string;
  note: string | null;
  size: number;
  counts: Record<string, number>;
}

export { BackupError };

function backupDir(): string {
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'db.sqlite');
  return path.join(path.dirname(dbPath), 'backups');
}

function filePath(name: string): string {
  if (!NAME_RE.test(name)) throw new BackupError('Invalid backup name');
  return path.join(backupDir(), name);
}

const pkOf = (table: string) => (table === 'settings' ? 'key' : 'id');

function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

// ── Create ────────────────────────────────────────────────────────

export function snapshot(note?: string): BackupFile {
  const db = getDb();
  const tables: BackupFile['tables'] = {};
  for (const t of BACKUP_TABLES) {
    let rows = db.prepare(`SELECT * FROM ${t} ORDER BY ${pkOf(t)}`).all() as Row[];
    if (t === 'settings') rows = rows.filter((r) => !THIS_HOMEHUB_ONLY.includes(r.key as string));
    for (const row of rows) {
      for (const col of JSON_COLUMNS[t] ?? []) {
        if (typeof row[col] === 'string') {
          try { row[col] = JSON.parse(row[col] as string); } catch { /* keep text */ }
        }
      }
    }
    tables[t] = rows;
  }
  return {
    format: FORMAT,
    version: VERSION,
    created_at: new Date().toISOString(),
    ...(note?.trim() ? { note: note.trim().slice(0, 200) } : {}),
    tables,
  };
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function createBackup(note?: string, prefix = 'homehub'): BackupEntry {
  const data = snapshot(note);
  fs.mkdirSync(backupDir(), { recursive: true });
  let name = `${prefix}-${stamp()}.json`;
  for (let i = 2; fs.existsSync(path.join(backupDir(), name)); i++) name = `${prefix}-${stamp()}-${i}.json`;
  writeFileAtomic(path.join(backupDir(), name), data);
  return entryFor(name);
}

function writeFileAtomic(dest: string, data: BackupFile): void {
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, dest);
}

// ── List / read ───────────────────────────────────────────────────

function entryFor(name: string): BackupEntry {
  const file = filePath(name);
  const stat = fs.statSync(file);
  let note: string | null = null;
  let createdAt = stat.mtime.toISOString();
  const counts: Record<string, number> = {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as BackupFile;
    note = typeof data.note === 'string' ? data.note : null;
    if (typeof data.created_at === 'string') createdAt = data.created_at;
    for (const [t, rows] of Object.entries(data.tables ?? {})) {
      if (Array.isArray(rows)) counts[t] = rows.length;
    }
  } catch { /* a file edited by hand outside HomeHub can still be listed */ }
  return { name, createdAt, note, size: stat.size, counts };
}

export function listBackups(): BackupEntry[] {
  if (!fs.existsSync(backupDir())) return [];
  return fs.readdirSync(backupDir())
    .filter((f) => NAME_RE.test(f))
    .map(entryFor)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function readBackup(name: string): BackupFile {
  const file = filePath(name);
  if (!fs.existsSync(file)) throw new BackupError('Backup not found', 404);
  return parseBackup(fs.readFileSync(file, 'utf8'));
}

/** The backup as text to show, with passwords and keys replaced by HIDDEN. */
export function readMasked(name: string): string {
  return JSON.stringify(mask(readBackup(name)), null, 2);
}

/**
 * The saved file exactly as it is, passwords and keys included, for moving to
 * another HomeHub. Admin only, like every backup route.
 */
export function readFull(name: string): string {
  const file = filePath(name);
  if (!fs.existsSync(file)) throw new BackupError('Backup not found', 404);
  return fs.readFileSync(file, 'utf8');
}

/**
 * Save a backup file brought from another HomeHub (or this one) into the
 * backups folder, after checking it would restore cleanly. Nothing changes
 * until it is restored.
 */
export function importBackup(text: string): BackupEntry {
  const data = parseBackup(text);
  if (JSON.stringify(data).includes(JSON.stringify(HIDDEN))) {
    throw new BackupError(
      `This file has ${HIDDEN} in place of passwords and keys, so it can't be restored. ` +
      'Use Download on the other HomeHub, not text copied from View / Edit.',
    );
  }
  applyBackup(data, { dryRun: true });
  fs.mkdirSync(backupDir(), { recursive: true });
  let name = `uploaded-${stamp()}.json`;
  for (let i = 2; fs.existsSync(path.join(backupDir(), name)); i++) name = `uploaded-${stamp()}-${i}.json`;
  writeFileAtomic(path.join(backupDir(), name), data);
  return entryFor(name);
}

export function deleteBackup(name: string): void {
  const file = filePath(name);
  if (!fs.existsSync(file)) throw new BackupError('Backup not found', 404);
  fs.unlinkSync(file);
}

// ── Hiding secrets ────────────────────────────────────────────────

function maskValue(value: unknown, key: string): unknown {
  if (typeof value === 'string' && value !== '' && SECRET_FIELD.test(key)) return HIDDEN;
  if (Array.isArray(value)) return value.map((v) => maskValue(v, ''));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskValue(v, k)]));
  }
  return value;
}

function mask(data: BackupFile): BackupFile {
  const tables: BackupFile['tables'] = {};
  for (const [t, rows] of Object.entries(data.tables) as [TableName, Row[]][]) {
    tables[t] = rows.map((row) => {
      if (t === 'settings') {
        const secret = typeof row.key === 'string' && SECRET_SETTING.test(row.key) && row.value !== '';
        return secret ? { ...row, value: HIDDEN } : row;
      }
      return maskValue(row, '') as Row;
    });
  }
  return { ...data, tables };
}

/** Put back each HIDDEN value from the saved file, matching rows by id. */
function unmask(edited: BackupFile, original: BackupFile): BackupFile {
  const fill = (value: unknown, orig: unknown, where: string): unknown => {
    if (value === HIDDEN) {
      if (orig === undefined || orig === HIDDEN) {
        throw new BackupError(`${where} is ${HIDDEN}, but the saved backup has no value for it. Enter the real value or remove the field.`);
      }
      return orig;
    }
    if (Array.isArray(value)) {
      return value.map((v, i) => fill(v, Array.isArray(orig) ? orig[i] : undefined, `${where}[${i}]`));
    }
    if (value && typeof value === 'object') {
      const o = orig && typeof orig === 'object' ? (orig as Row) : {};
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, o[k], `${where}.${k}`)]));
    }
    return value;
  };

  const tables: BackupFile['tables'] = {};
  for (const [t, rows] of Object.entries(edited.tables) as [TableName, Row[]][]) {
    const pk = pkOf(t);
    const before = new Map((original.tables[t] ?? []).map((r) => [r[pk], r]));
    tables[t] = rows.map((row) => fill(row, before.get(row[pk]), `${t} ${pk} ${String(row[pk])}`) as Row);
  }
  return { ...edited, tables };
}

// ── Validate / save edits ─────────────────────────────────────────

export function parseBackup(text: string): BackupFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new BackupError(`Not valid JSON: ${(err as Error).message}`);
  }
  const d = data as BackupFile;
  if (!d || typeof d !== 'object' || d.format !== FORMAT) {
    throw new BackupError(`Not a HomeHub backup (expected "format": "${FORMAT}")`);
  }
  if (typeof d.version !== 'number' || d.version > VERSION) {
    throw new BackupError('This backup is from a newer version of HomeHub');
  }
  if (!d.tables || typeof d.tables !== 'object' || Array.isArray(d.tables)) {
    throw new BackupError('"tables" must be an object');
  }
  for (const [t, rows] of Object.entries(d.tables)) {
    if (!(BACKUP_TABLES as readonly string[]).includes(t)) {
      throw new BackupError(`Unknown table "${t}". Allowed: ${BACKUP_TABLES.join(', ')}`);
    }
    if (!Array.isArray(rows) || rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) {
      throw new BackupError(`"${t}" must be a list of objects`);
    }
  }
  return d;
}

/**
 * Save an edited backup. HIDDEN values are filled back in from the saved file,
 * and the result is test-restored and rolled back, so a bad edit is caught now
 * rather than at restore time.
 */
export function saveEdited(name: string, text: string): BackupEntry {
  const original = readBackup(name);
  const data = unmask(parseBackup(text), original);
  applyBackup(data, { dryRun: true });
  writeFileAtomic(filePath(name), data);
  return entryFor(name);
}

// ── Restore ───────────────────────────────────────────────────────

export interface RestoreResult {
  counts: Record<string, number>;
  /** History rows removed because their device, sensor or user is gone. */
  removed: number;
  /** Accounts the backup brought in, and backup accounts already here (kept as they are). */
  accounts: { added: string[]; kept: string[] };
}

/** Tables whose rows belong to one account: they follow that account in or stay out. */
const PER_USER_TABLES = new Set<string>(['push_subscriptions', 'notification_preferences']);

/**
 * Settings that describe this HomeHub, not the home: never backed up, and a
 * restore leaves them as they are. The backup email key in particular must
 * never travel inside a backup, encrypted or not.
 */
export const THIS_HOMEHUB_ONLY = [
  'automations_paused', 'server_role', 'server_active_since',
  'backup_email_key', 'backup_email_hint', 'backup_email_auto', 'backup_email_last', 'backup_email_sent',
];

/** Settings this HomeHub keeps when it already has them: the backup fills them in only if unset. */
const LOCAL_SETTINGS = [['home_latitude', 'home_longitude'], ['home_timezone']];

function insertRow(
  db: Database.Database, t: TableName, row: Row, i: number,
  opts: { omit?: string[]; set?: Row; orIgnore?: boolean } = {},
): Database.RunResult {
  const cols = columns(db, t);
  const jsonCols = new Set(JSON_COLUMNS[t] ?? []);
  const merged: Row = { ...row, ...opts.set };
  const keys = Object.keys(merged).filter((k) => cols.has(k) && !opts.omit?.includes(k));
  if (keys.length === 0) throw new BackupError(`${t} row ${i + 1} has no known fields`);
  const values = keys.map((k) => {
    const v = merged[k];
    if (v === HIDDEN) throw new BackupError(`${t} row ${i + 1}: ${k} is still ${HIDDEN}`);
    if (jsonCols.has(k) && v !== null && typeof v === 'object') return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v !== null && typeof v === 'object') {
      throw new BackupError(`${t} row ${i + 1}: ${k} must be text, a number or null`);
    }
    return v;
  });
  try {
    return db.prepare(
      `INSERT ${opts.orIgnore ? 'OR IGNORE ' : ''}INTO ${t} (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    ).run(...values);
  } catch (err) {
    throw new BackupError(`${t} row ${i + 1}: ${(err as Error).message}`);
  }
}

/**
 * Restore the backup's devices, rooms, schedules and settings, keeping this
 * HomeHub's accounts. Runs in one transaction; tables left out of the file
 * are untouched.
 *
 * - Most tables are replaced with the backup's rows.
 * - Accounts are merged: every account here stays as it is, password
 *   included, so whoever restores can still sign in. A backup account whose
 *   name isn't here is added with its password; one whose name is here is
 *   skipped. Push subscriptions and notification choices come along only for
 *   added accounts.
 * - The home's location and time zone stay if this HomeHub has them set.
 *
 * Foreign keys are off during the swap so deleting devices doesn't cascade
 * into the history tables. Afterwards, settings rows that point at something
 * missing fail the restore; history rows that do are removed.
 */
export function applyBackup(data: BackupFile, opts: { dryRun?: boolean } = {}): RestoreResult {
  const db = getDb();
  const tables = BACKUP_TABLES.filter((t) => data.tables[t]);
  const result: RestoreResult = { counts: {}, removed: 0, accounts: { added: [], kept: [] } };
  const ROLLBACK = Symbol('rollback');
  /** Backup user id → id of an account added from the backup. */
  const addedIds = new Map<unknown, number>();

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const t of tables) {
        const rows = data.tables[t]!;

        if (t === 'users') {
          const here = new Set((db.prepare('SELECT name FROM users').all() as { name: string }[]).map((u) => u.name));
          rows.forEach((row, i) => {
            if (typeof row.name !== 'string' || !row.name.trim()) throw new BackupError(`users row ${i + 1} has no name`);
            if (here.has(row.name)) { result.accounts.kept.push(row.name); return; }
            const { lastInsertRowid } = insertRow(db, t, row, i, { omit: ['id'] });
            addedIds.set(row.id, Number(lastInsertRowid));
            here.add(row.name);
            result.accounts.added.push(row.name);
          });
          result.counts[t] = result.accounts.added.length;
          continue;
        }

        if (PER_USER_TABLES.has(t)) {
          let n = 0;
          rows.forEach((row, i) => {
            const userId = addedIds.get(row.user_id);
            if (userId === undefined) return;
            n += insertRow(db, t, row, i, { omit: ['id'], set: { user_id: userId }, orIgnore: true }).changes;
          });
          result.counts[t] = n;
          continue;
        }

        if (t === 'settings') {
          const isSetHere = (k: string) =>
            !!(db.prepare("SELECT 1 FROM settings WHERE key = ? AND value <> ''").get(k));
          const keep = [...LOCAL_SETTINGS.filter((group) => isSetHere(group[0])).flat(), ...THIS_HOMEHUB_ONLY];
          db.prepare(`DELETE FROM settings WHERE key NOT IN (${keep.map(() => '?').join(', ') || "''"})`).run(...keep);
          let n = 0;
          rows.forEach((row, i) => {
            if (keep.includes(row.key as string)) return;
            insertRow(db, t, row, i);
            n++;
          });
          result.counts[t] = n;
          continue;
        }

        db.prepare(`DELETE FROM ${t}`).run();
        rows.forEach((row, i) => insertRow(db, t, row, i));
        result.counts[t] = rows.length;
      }

      result.removed = fixReferences(db, new Set(tables));
      if (opts.dryRun) throw ROLLBACK;
    })();
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return result;
}

interface FkViolation { table: string; rowid: number; parent: string; fkid: number }
interface FkInfo { id: number; from: string; on_delete: string }

function fixReferences(db: Database.Database, restored: Set<string>): number {
  let removed = 0;
  // Removing a flow event can orphan its acknowledgements, so repeat.
  for (let pass = 0; pass < 5; pass++) {
    const violations = db.prepare('PRAGMA foreign_key_check').all() as FkViolation[];
    if (violations.length === 0) return removed;

    const bad = violations.find((v) => restored.has(v.table));
    if (bad) {
      const fk = (db.prepare(`PRAGMA foreign_key_list(${bad.table})`).all() as FkInfo[]).find((f) => f.id === bad.fkid);
      const row = db.prepare(`SELECT * FROM ${bad.table} WHERE rowid = ?`).get(bad.rowid) as Row | undefined;
      const id = row?.[pkOf(bad.table)];
      throw new BackupError(
        `${bad.table} ${pkOf(bad.table)} ${String(id)} refers to ${bad.parent} ${String(row?.[fk?.from ?? ''])}, which isn't in the backup`,
      );
    }

    for (const v of violations) {
      const fk = (db.prepare(`PRAGMA foreign_key_list(${v.table})`).all() as FkInfo[]).find((f) => f.id === v.fkid);
      if (fk?.on_delete === 'SET NULL') {
        db.prepare(`UPDATE ${v.table} SET "${fk.from}" = NULL WHERE rowid = ?`).run(v.rowid);
      } else {
        removed += db.prepare(`DELETE FROM ${v.table} WHERE rowid = ?`).run(v.rowid).changes;
      }
    }
  }
  throw new BackupError('Could not tidy up references after restoring');
}

/** Restore a saved backup, saving the current state first so it can be undone. */
export function restoreBackup(name: string): RestoreResult & { safetyBackup: string } {
  const data = readBackup(name);
  applyBackup(data, { dryRun: true });   // fail before writing anything
  const safety = createBackup(`Automatic, before restoring ${name}`, 'before-restore');
  const result = applyBackup(data);
  return { ...result, safetyBackup: safety.name };
}
