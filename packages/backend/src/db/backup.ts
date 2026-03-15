import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

const DB_PATH    = process.env.DB_PATH || path.join(process.cwd(), 'data', 'db.sqlite');
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
const KEEP_DAYS  = 7;

export function runBackup(): void {
  if (!fs.existsSync(DB_PATH)) {
    logger.warn({ path: DB_PATH }, 'DB backup skipped — file not found');
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD
  const dest = path.join(BACKUP_DIR, `db-${date}.sqlite`);

  fs.copyFileSync(DB_PATH, dest);
  logger.info({ dest }, 'DB backup written');

  // Prune: keep only the most recent KEEP_DAYS backup files
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('db-') && f.endsWith('.sqlite'))
    .sort();

  const toDelete = files.slice(0, Math.max(0, files.length - KEEP_DAYS));
  for (const f of toDelete) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    logger.info({ file: f }, 'Old backup removed');
  }
}
