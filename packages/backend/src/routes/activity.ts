import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { KEEP_DAYS, keepDays, listActivity, setKeepDays, type ActivitySource } from '../activity/activity';

/** Activity: device changes and their causes. Anyone signed in can read it. */
export const activityRouter = Router();

const SOURCES: ActivitySource[] = ['app', 'scene', 'schedule', 'timer', 'motion', 'chat', 'voice', 'assistant', 'shutoff', 'outside', 'homehub'];

// GET /api/activity?deviceId=&room=&source=&kind=&before=&limit=
activityRouter.get('/', (req: Request, res: Response) => {
  const q = req.query;
  const int = (v: unknown) => (v === undefined || v === '' ? undefined : Number(v));
  const deviceId = int(q.deviceId), before = int(q.before), limit = int(q.limit);
  if ([deviceId, before, limit].some((v) => v !== undefined && !Number.isInteger(v))) {
    return res.status(400).json({ error: 'deviceId, before and limit must be whole numbers', code: 'VALIDATION_ERROR' });
  }
  const source = typeof q.source === 'string' && q.source ? q.source as ActivitySource : undefined;
  if (source && !SOURCES.includes(source)) return res.status(400).json({ error: 'Unknown source', code: 'VALIDATION_ERROR' });
  const kind = q.kind === 'power' || q.kind === 'online' ? q.kind : undefined;
  // room= with no value means devices without a room
  const room = typeof q.room === 'string' ? q.room : undefined;
  res.json(listActivity({ deviceId, room, source, kind, before, limit }));
});

activityRouter.get('/settings', (_req: Request, res: Response) => {
  res.json({ keepDays: keepDays(), limits: KEEP_DAYS });
});

activityRouter.put('/settings', requireAdmin, (req: Request, res: Response) => {
  try {
    res.json({ keepDays: setKeepDays(req.body?.keepDays), limits: KEEP_DAYS });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message, code: 'VALIDATION_ERROR' });
  }
});
