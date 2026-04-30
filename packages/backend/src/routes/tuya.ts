import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { fetchTuyaCloudDevices, TuyaCloudCredentials } from '../tuya/TuyaCloudService';
import { logger } from '../logger';

export const tuyaRouter = Router();

/** Resolve credentials: DB rows take precedence, env vars are the fallback. */
function resolveCreds(): { accessId: string; accessSecret: string; region: TuyaCloudCredentials['region'] } {
  const db  = getDb();
  const get = (key: string) =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? '';

  const accessId     = get('tuya_access_id')     || process.env.TUYA_ACCESS_ID                                     || '';
  const accessSecret = get('tuya_access_secret') || process.env.TUYA_ACCESS_SECRET || process.env.TUYA_ACCESS_KEY  || '';
  const region       = (get('tuya_region')       || process.env.TUYA_REGION        || 'us') as TuyaCloudCredentials['region'];
  return { accessId, accessSecret, region };
}

// ── Credentials ─────────────────────────────────────────────────

// GET /api/tuya/credentials
tuyaRouter.get('/credentials', (_req: Request, res: Response) => {
  const { accessId, accessSecret, region } = resolveCreds();
  const fromEnv = !!(process.env.TUYA_ACCESS_ID && !accessId.startsWith(''));  // env-sourced if DB empty
  res.json({ accessId, region, hasSecret: !!accessSecret, fromEnv });
});

// PUT /api/tuya/credentials — save to DB (overrides env)
tuyaRouter.put('/credentials', (req: Request, res: Response) => {
  const { accessId, accessSecret, region } = req.body as {
    accessId?: string; accessSecret?: string; region?: string;
  };
  if (!accessId?.trim() || !accessSecret?.trim()) {
    return res.status(400).json({ error: 'accessId and accessSecret are required', code: 'VALIDATION_ERROR' });
  }

  const db     = getDb();
  const upsert = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  upsert.run('tuya_access_id',     accessId.trim());
  upsert.run('tuya_access_secret', accessSecret.trim());
  upsert.run('tuya_region',        (region ?? 'us').trim());
  res.json({ ok: true });
});

// ── Cloud sync ───────────────────────────────────────────────────

// POST /api/tuya/sync
tuyaRouter.post('/sync', async (_req: Request, res: Response) => {
  const { accessId, accessSecret, region } = resolveCreds();

  if (!accessId || !accessSecret) {
    return res.status(400).json({ error: 'Tuya cloud credentials not configured. Set TUYA_ACCESS_ID / TUYA_ACCESS_SECRET in .env or enter them in Settings → Integrations.', code: 'NOT_CONFIGURED' });
  }

  try {
    const devices = await fetchTuyaCloudDevices({ accessId, accessSecret, region });
    res.json(devices);
  } catch (err: any) {
    logger.error(err, 'Tuya cloud sync failed');
    res.status(502).json({ error: err.message ?? 'Tuya cloud sync failed', code: 'TUYA_CLOUD_ERROR' });
  }
});
