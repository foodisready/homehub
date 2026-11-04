import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { logger } from '../logger';
import {
  getSetupState, saveSetupState, SetupStateError,
  STARTERS, createStarters, StarterError,
} from '../home/setup';
import { searchPlaces, biggestPlaceIn } from '../home/places';
import { createInvite, activeInvites, cancelInvite } from '../auth/invites';
import { notifyScheduler } from './schedules';

/** First-run setup, all admin only. Mounted at /api/setup. */
export const setupRouter = Router();
setupRouter.use(requireAdmin);

// GET /api/setup — where setup is, and the starters it can offer
setupRouter.get('/', (_req: Request, res: Response) => {
  res.json({ ...getSetupState(), starters: STARTERS });
});

// PUT /api/setup { step?, finished? }
setupRouter.put('/', (req: Request, res: Response) => {
  try {
    res.json(saveSetupState(req.body ?? {}));
  } catch (err) {
    if (err instanceof SetupStateError) return res.status(400).json({ error: err.message, code: 'VALIDATION_ERROR' });
    throw err;
  }
});

// GET /api/setup/places?q=marietta&tz=America/New_York — towns, searched on HomeHub itself
setupRouter.get('/places', (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
  const tz = typeof req.query.tz === 'string' ? req.query.tz : undefined;
  res.json(searchPlaces(q, { timezone: tz }));
});

// GET /api/setup/places/guess?tz=America/New_York — the biggest town in that time zone
setupRouter.get('/places/guess', (req: Request, res: Response) => {
  const tz = typeof req.query.tz === 'string' ? req.query.tz : '';
  res.json(biggestPlaceIn(tz));
});

// POST /api/setup/starters { starters: [{ id, deviceIds, offTime? }] }
setupRouter.post('/starters', (req: Request, res: Response) => {
  try {
    const result = createStarters(req.body?.starters);
    if (result.schedules) notifyScheduler();
    logger.info({ ...result, by: req.user?.name }, 'Starter automations created');
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof StarterError) return res.status(400).json({ error: err.message, code: 'VALIDATION_ERROR' });
    throw err;
  }
});

// ── Family invites ───────────────────────────────────────────────

// GET /api/setup/invites — invites that still work
setupRouter.get('/invites', (_req: Request, res: Response) => {
  res.json(activeInvites());
});

// POST /api/setup/invites — a new invite; the code comes back only this once
setupRouter.post('/invites', (req: Request, res: Response) => {
  const invite = createInvite(req.user!.sub);
  logger.info({ inviteId: invite.id, by: req.user?.name }, 'Family invite created');
  res.status(201).json(invite);
});

// DELETE /api/setup/invites/:id
setupRouter.delete('/invites/:id', (req: Request, res: Response) => {
  if (!cancelInvite(Number(req.params.id))) return res.status(404).json({ error: 'Invite not found', code: 'NOT_FOUND' });
  logger.info({ inviteId: Number(req.params.id), by: req.user?.name }, 'Family invite cancelled');
  res.status(204).send();
});
