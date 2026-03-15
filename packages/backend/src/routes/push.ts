import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { vapidPublicKey } from '../push/push.service';
import type { TokenPayload } from '../auth/auth.service';

export const pushRouter = Router();

// GET /api/push/vapid-public-key — frontend needs this to subscribe
pushRouter.get('/vapid-public-key', (_req: Request, res: Response) => {
  const key = vapidPublicKey();
  if (!key) return res.status(503).json({ error: 'Push notifications not configured', code: 'PUSH_DISABLED' });
  res.json({ key });
});

// POST /api/push/subscribe
pushRouter.post('/subscribe', (req: Request, res: Response) => {
  const user = (req as any).user as TokenPayload;
  const { endpoint, keys } = req.body as { endpoint: string; keys: { p256dh: string; auth: string } };

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription object', code: 'VALIDATION_ERROR' });
  }

  const db = getDb();
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
  `).run(user.sub, endpoint, keys.p256dh, keys.auth);

  res.status(201).json({ ok: true });
});

// DELETE /api/push/subscribe
pushRouter.delete('/subscribe', (req: Request, res: Response) => {
  const { endpoint } = req.body as { endpoint: string };
  if (!endpoint) return res.status(400).json({ error: 'endpoint required', code: 'VALIDATION_ERROR' });

  const db = getDb();
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  res.status(204).send();
});
