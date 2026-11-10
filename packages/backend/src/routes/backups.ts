import { Router, Request, Response } from 'express';
import { logger } from '../logger';
import {
  BackupError, createBackup, deleteBackup, importBackup, listBackups, readFull, readMasked, restoreBackup, saveEdited,
} from '../db/json-backup';
import { asEncrypted, decryptBackup } from '../db/backup-crypto';
import { backupEmailStatus, checkBackupEmail, emailBackup, setAutoEmail, setBackupPassphrase } from '../db/backup-email';
import { follow, makePairingCode, serveSnapshot, stopFollowing, syncNow, syncStatus, unpair } from '../db/backup-sync';
import { refreshDevices } from '../kasa/device.cache';
import { notifyScheduler } from './schedules';

/** Admin-only JSON backups. Mounted behind requireAdmin. */
export const backupsRouter = Router();

function fail(res: Response, err: unknown): void {
  if (err instanceof BackupError) {
    res.status(err.status).json({ ...err.extra, error: err.message, code: err.code });
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
// An encrypted file (from a backup email) needs "passphrase"; it's saved decrypted, like any other backup.
backupsRouter.post('/upload', async (req: Request, res: Response) => {
  try {
    if (typeof req.body?.content !== 'string') throw new BackupError('"content" must be the backup file as text');
    const encrypted = asEncrypted(req.body.content);
    const passphrase = typeof req.body.passphrase === 'string' ? req.body.passphrase : undefined;
    const text = encrypted ? await decryptBackup(encrypted, passphrase) : req.body.content;
    const entry = importBackup(text);
    logger.info({ name: entry.name, encrypted: !!encrypted }, 'JSON backup uploaded');
    res.status(201).json(entry);
  } catch (err) { fail(res, err); }
});

// ── Keeping a backup HomeHub in step (backup-sync.ts) ──────────────
// Before the /:name routes, so "sync" is never taken for a backup name.

backupsRouter.get('/sync', (_req: Request, res: Response) => {
  try { res.json(syncStatus()); } catch (err) { fail(res, err); }
});

/** On the active HomeHub: a new pairing code for the backup. Shown once. */
backupsRouter.post('/sync/code', (_req: Request, res: Response) => {
  try { res.status(201).json({ ...makePairingCode(), status: syncStatus() }); } catch (err) { fail(res, err); }
});

backupsRouter.delete('/sync/code', (_req: Request, res: Response) => {
  try { unpair(); res.json(syncStatus()); } catch (err) { fail(res, err); }
});

/** On a backup: { code, address? }. Pairs with the active HomeHub and copies it straight away. */
backupsRouter.put('/sync/follow', async (req: Request, res: Response) => {
  try {
    const { code, address } = req.body ?? {};
    if (typeof code !== 'string') throw new BackupError('"code" must be the pairing code from the active HomeHub');
    if (address !== undefined && address !== null && typeof address !== 'string') throw new BackupError('"address" must be text');
    await follow(code, address ?? undefined);
    res.json(syncStatus());
  } catch (err) { fail(res, err); }
});

backupsRouter.post('/sync/now', async (_req: Request, res: Response) => {
  try { await syncNow(); res.json(syncStatus()); } catch (err) { fail(res, err); }
});

backupsRouter.delete('/sync/follow', (_req: Request, res: Response) => {
  try { stopFollowing(); res.json(syncStatus()); } catch (err) { fail(res, err); }
});

/**
 * The active HomeHub's settings, for its paired backup on the home network. Not
 * behind a login: the pairing code, sent as "Authorization: Bearer <code>", is
 * the key. Mounted at /sync.
 */
export const backupSyncPublicRouter = Router();

backupSyncPublicRouter.get('/snapshot', (req: Request, res: Response) => {
  const auth = req.headers.authorization;
  const key = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
  const { status, body } = serveSnapshot(key, req.ip ?? 'unknown');
  if (status === 200) logger.info({ from: req.ip }, 'Backup sync: settings copied to the backup HomeHub');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
});

// ── Emailing backups ────────────────────────────────────────────────
// Before the /:name routes, so "email" is never taken for a backup name.

backupsRouter.get('/email', (_req: Request, res: Response) => {
  try { res.json(backupEmailStatus()); } catch (err) { fail(res, err); }
});

/** { passphrase?: string, hint?: string, auto?: boolean }. The hint goes with a new passphrase. */
backupsRouter.put('/email', async (req: Request, res: Response) => {
  try {
    const { passphrase, hint, auto } = req.body ?? {};
    if (passphrase !== undefined) {
      if (typeof passphrase !== 'string') throw new BackupError('"passphrase" must be text');
      if (hint !== undefined && typeof hint !== 'string') throw new BackupError('"hint" must be text');
      await setBackupPassphrase(passphrase, hint);
    }
    if (auto !== undefined) {
      if (typeof auto !== 'boolean') throw new BackupError('"auto" must be true or false');
      setAutoEmail(auto);
      // Turning it on sends the first one straight away, so a mistake in the email settings shows now.
      if (auto) await checkBackupEmail();
    }
    res.json(backupEmailStatus());
  } catch (err) { fail(res, err); }
});

backupsRouter.post('/:name/email', async (req: Request, res: Response) => {
  try { res.json(await emailBackup({ name: String(req.params.name), reason: 'manual' })); } catch (err) { fail(res, err); }
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
