import { NextFunction, Request, Response } from 'express';
import { serverRole } from '../system/role';
import { otherAnswering } from '../discovery/local-name';

/**
 * A backup HomeHub is read-only: its devices, rooms, schedules, scenes and
 * settings are copied from the active HomeHub every hour (db/backup-sync.ts),
 * so a change made here would be lost at the next copy. Changes are made on
 * the active HomeHub instead.
 *
 * Still allowed on a backup, because they change nothing that's copied:
 * switching devices on and off and running scenes by hand, chat commands, this
 * HomeHub's own accounts, notifications on this browser, backups and syncing,
 * and everything under /system: becoming active, updating, restarting voice.
 *
 * Checked on each request, so it ends the moment this HomeHub becomes active.
 * A development copy isn't locked: it's for trying changes.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** [method or '*', path under /api]. */
const ALLOWED: [string, RegExp][] = [
  ['POST', /^\/devices\/[^/]+\/(on|off)$/],
  ['POST', /^\/scenes\/[^/]+\/run$/],
  ['POST', /^\/nlp(\/stream)?$/],                       // chat: "turn on the kitchen lights"
  ['*', /^\/system(\/|$)/],
  ['*', /^\/backups(\/|$)/],
  ['*', /^\/users(\/|$)/],                              // accounts are this HomeHub's own: a copy never changes them
  ['*', /^\/push(\/|$)/],
  ['PUT', /^\/setup$/],                                 // where the welcome steps are up to
  ['POST', /^\/sensors\/[^/]+\/events\/[^/]+\/ack$/],
  ['POST', /^\/cameras\/[^/]+\/(ptz|snapshots)$/],
];

export function allowedOnBackup(method: string, path: string): boolean {
  if (SAFE_METHODS.has(method)) return true;
  const p = path.replace(/\/+$/, '') || '/';
  return ALLOWED.some(([m, re]) => (m === '*' || m === method) && re.test(p));
}

export const READ_ONLY_CODE = 'BACKUP_READ_ONLY';

/** Mounted at /api, after sign-in is checked. */
export function backupReadOnly(req: Request, res: Response, next: NextFunction): void {
  if (allowedOnBackup(req.method, req.path) || serverRole() !== 'backup') return next();
  const active = otherAnswering()?.address;
  res.status(409).json({
    error: `This HomeHub is a backup, so it's read-only. Make changes on the active HomeHub${active ? ` at ${active}` : ''}; they're copied here every hour.`,
    code: READ_ONLY_CODE,
  });
}
