import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { AwayError, awayView, endAway, saveAwaySettings, startAway } from '../home/away';

/** Away mode, mounted at /api/away. Anyone signed in turns it on and off; admins choose what it does. */
export const awayRouter = Router();

const fail = (res: Response, err: unknown) => {
  if (err instanceof AwayError) return res.status(err.status).json({ error: err.message, code: 'AWAY' });
  throw err;
};

// GET /api/away
awayRouter.get('/', (_req: Request, res: Response) => { res.json(awayView()); });

// POST /api/away/start  { until?: ISO date-time } — also changes the day back while away
awayRouter.post('/start', async (req: Request, res: Response) => {
  try { res.json(await startAway(req.body ?? {}, req.user?.name ?? null)); } catch (err) { fail(res, err); }
});

// POST /api/away/end
awayRouter.post('/end', async (_req: Request, res: Response) => {
  try { res.json(await endAway('person')); } catch (err) { fail(res, err); }
});

// PUT /api/away/settings  { water?, cameras?, family?, lights?, warmUpMinutes?, thermostats? } — admin
awayRouter.put('/settings', requireAdmin, (req: Request, res: Response) => {
  try { saveAwaySettings(req.body); res.json(awayView()); } catch (err) { fail(res, err); }
});
