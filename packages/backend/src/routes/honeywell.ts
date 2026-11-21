import { Router, Request, Response } from 'express';
import * as honeywell from '../honeywell/honeywell';
import { TccError, type TccLocation } from '../honeywell/tcc';
import { logger } from '../logger';

/**
 * Admin-only Honeywell Total Connect Comfort sign-in, mounted at /api/honeywell.
 * The password is never sent back.
 */
export const honeywellRouter = Router();

/** The account's thermostats, and the HomeHub device each one is, if it is one. */
function listOf(locations: TccLocation[]) {
  const inHub = new Map(honeywell.honeywellRows().map((r) => [r.deviceId, r]));
  return locations.flatMap((loc) => loc.thermostats.map((t) => ({
    deviceId: t.id,
    name: t.name,
    location: loc.name,
    deviceIdInHomeHub: inHub.get(t.id)?.id ?? null,
    alias: inHub.get(t.id)?.alias ?? null,
  })));
}

const failure = (res: Response, err: unknown) => {
  if (err instanceof TccError) {
    const status = err.kind === 'rejected' ? 422 : err.kind === 'refused' ? 422 : 502;
    return res.status(status).json({ error: err.message, code: `HONEYWELL_${err.kind.toUpperCase()}` });
  }
  throw err;
};

// GET /api/honeywell/login
honeywellRouter.get('/login', (_req: Request, res: Response) => {
  res.json(honeywell.accountStatus());
});

// PUT /api/honeywell/login { email, password } — signs in, then adds the account's thermostats HomeHub doesn't have
honeywellRouter.put('/login', async (req: Request, res: Response) => {
  const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };
  if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Email and password are required', code: 'VALIDATION_ERROR' });
  }
  try {
    const { locations, listError } = await honeywell.signIn(email.trim(), password);
    const added = locations ? honeywell.addThermostats(locations) : [];
    void honeywell.pollAll();
    res.json({ ...honeywell.accountStatus(), added, thermostats: locations ? listOf(locations) : [], ...(listError ? { listError } : {}) });
  } catch (err) {
    if (err instanceof TccError) logger.warn({ kind: err.kind, reason: err.message }, 'Total Connect Comfort sign-in failed');
    failure(res, err);
  }
});

// DELETE /api/honeywell/login — forgets the account; its thermostats stay in HomeHub, offline
honeywellRouter.delete('/login', (_req: Request, res: Response) => {
  honeywell.signOut();
  res.status(204).end();
});

// GET /api/honeywell/thermostats — every thermostat on the account
honeywellRouter.get('/thermostats', async (_req: Request, res: Response) => {
  try { res.json(listOf(await honeywell.accountThermostats())); } catch (err) { failure(res, err); }
});

// POST /api/honeywell/thermostats/:deviceId — adds one the account has (one deleted from HomeHub, say)
honeywellRouter.post('/thermostats/:deviceId', async (req: Request, res: Response) => {
  const deviceId = Number(req.params.deviceId);
  if (!Number.isInteger(deviceId) || deviceId <= 0) return res.status(400).json({ error: 'Not a thermostat id', code: 'VALIDATION_ERROR' });
  try {
    const locations = await honeywell.accountThermostats();
    if (!locations.some((l) => l.thermostats.some((t) => t.id === deviceId))) {
      return res.status(404).json({ error: 'That thermostat isn’t on the Total Connect Comfort account.', code: 'NOT_FOUND' });
    }
    const added = honeywell.addThermostats(locations, deviceId);
    void honeywell.pollAll();
    res.json({ added, thermostats: listOf(locations) });
  } catch (err) { failure(res, err); }
});
