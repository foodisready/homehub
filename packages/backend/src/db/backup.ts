import fs from 'fs';
import path from 'path';
import { getDb } from './index';
import { logger } from '../logger';

const DB_PATH    = process.env.DB_PATH || path.join(process.cwd(), 'data', 'db.sqlite');
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
const KEEP_DAYS  = 7;

/**
 * Write today's backup, then prune old ones. Never throws: it runs on a timer,
 * and a failed backup must not take the backend down.
 *
 * Uses VACUUM INTO rather than copying the file. The DB runs in WAL mode, so
 * recent writes live in db.sqlite-wal and a plain copy of db.sqlite misses them.
 */
export function runBackup(): void {
  const date = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD
  const dest = path.join(BACKUP_DIR, `db-${date}.sqlite`);
  const tmp  = `${dest}.tmp`;

  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.rmSync(tmp, { force: true });

    // VACUUM INTO refuses to overwrite, and renaming only once it finishes
    // means a failure leaves any earlier backup from today intact.
    getDb().prepare('VACUUM INTO ?').run(tmp);
    fs.renameSync(tmp, dest);
    logger.info({ dest }, 'DB backup written');

    pruneBackups();
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    logger.error({ err, dest }, 'DB backup failed');
  }
}

/**
 * A one-off copy before a change that's hard to undo, such as matter.js
 * upgrading its stored data. Named for the change, and never pruned.
 */
export function backupBefore(label: string): string | null {
  const dest = path.join(BACKUP_DIR, `before-${label.replace(/[^\w.-]+/g, '_')}.sqlite`);
  const tmp = `${dest}.tmp`;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.rmSync(tmp, { force: true });
    getDb().prepare('VACUUM INTO ?').run(tmp);
    fs.renameSync(tmp, dest);
    logger.info({ dest }, 'Backup written before an upgrade');
    return dest;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    logger.error({ err, dest }, 'Backup before an upgrade failed');
    return null;
  }
}

/** Keep only the most recent KEEP_DAYS backup files. */
function pruneBackups(): void {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('db-') && f.endsWith('.sqlite'))
    .sort();

  const toDelete = files.slice(0, Math.max(0, files.length - KEEP_DAYS));
  for (const f of toDelete) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    logger.info({ file: f }, 'Old backup removed');
  }
}
