import { Router, Request, Response } from 'express';
import { logger } from '../logger';
import {
  BackupError, createBackup, deleteBackup, importBackup, listBackups, readFull, readMasked, restoreBackup, saveEdited,
} from '../db/json-backup';
import { refreshDevices } from '../kasa/device.cache';
import { notifyScheduler } from './schedules';

/** Admin-only JSON backups. Mounted behind requireAdmin. */
export const backupsRouter = Router();

function fail(res: Response, err: unknown): void {
  if (err instanceof BackupError) {
    res.status(err.status).json({ error: err.message, code: 'BACKUP_ERROR' });
    return;
  }
  logger.error({ err }, 'Backup request failed');
  res.status(500).json({ error: (err as Error).message || 'Backup failed', code: 'INTERNAL_ERROR' });
}

backupsRouter.get('/', (_req: Request, res: Response) => {
  try { res.json(listBackups()); } catch (err) { fail(res, err); }
});

backupsRouter.post('/', (req: Request, res: Response) => {
  try {
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
    const entry = createBackup(note);
    logger.info({ name: entry.name }, 'JSON backup created');
    res.status(201).json(entry);
  } catch (err) { fail(res, err); }
});

// A backup file from another HomeHub, sent as text. Saved to the list; restoring is a separate step.
backupsRouter.post('/upload', (req: Request, res: Response) => {
  try {
    if (typeof req.body?.content !== 'string') throw new BackupError('"content" must be the backup file as text');
    const entry = importBackup(req.body.content);
    logger.info({ name: entry.name }, 'JSON backup uploaded');
    res.status(201).json(entry);
  } catch (err) { fail(res, err); }
});

// The whole file, passwords and keys included, to move to another HomeHub.
backupsRouter.get('/:name/download', (req: Request, res: Response) => {
  try {
    const name = String(req.params.name);
    const content = readFull(name);
    logger.info({ name }, 'JSON backup downloaded');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(content);
  } catch (err) { fail(res, err); }
});

backupsRouter.get('/:name', (req: Request, res: Response) => {
  try { res.json({ name: String(req.params.name), content: readMasked(String(req.params.name)) }); } catch (err) { fail(res, err); }
});

backupsRouter.put('/:name', (req: Request, res: Response) => {
  try {
    if (typeof req.body?.content !== 'string') throw new BackupError('"content" must be the backup as text');
    const entry = saveEdited(String(req.params.name), req.body.content);
    logger.info({ name: entry.name }, 'JSON backup edited');
    res.json(entry);
  } catch (err) { fail(res, err); }
});

backupsRouter.post('/:name/restore', (req: Request, res: Response) => {
  try {
    const result = restoreBackup(String(req.params.name));
    logger.info({ name: String(req.params.name), ...result }, 'JSON backup restored');
    notifyScheduler();
    refreshDevices().catch((err) => logger.warn({ err }, 'Device refresh after restore failed'));
    res.json(result);
  } catch (err) { fail(res, err); }
});

backupsRouter.delete('/:name', (req: Request, res: Response) => {
  try {
    deleteBackup(String(req.params.name));
    res.status(204).send();
  } catch (err) { fail(res, err); }
});
