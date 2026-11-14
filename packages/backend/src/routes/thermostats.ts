import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { changeThermostat, getThermostat, listThermostats, saveRanges, ThermostatError } from '../thermostat/thermostat';

/** Thermostats, mounted at /api/thermostats. Every temperature is °C; `unit` says how the home shows them. */
export const thermostatsRouter = Router();

const fail = (res: Response, err: unknown) => {
  if (err instanceof ThermostatError) return res.status(err.status).json({ error: err.message, code: 'THERMOSTAT' });
  throw err;
};

// GET /api/thermostats
thermostatsRouter.get('/', async (_req: Request, res: Response) => {
  res.json({ thermostats: await listThermostats() });
});

// GET /api/thermostats/:id
thermostatsRouter.get('/:id', async (req: Request, res: Response) => {
  try { res.json(await getThermostat(Number(req.params.id))); } catch (err) { fail(res, err); }
});

// PATCH /api/thermostats/:id  { mode?, heat?, cool? } — from the card, so only the thermostat's own limits apply
thermostatsRouter.patch('/:id', async (req: Request, res: Response) => {
  try { res.json(await changeThermostat(Number(req.params.id), req.body ?? {}, 'app')); } catch (err) { fail(res, err); }
});

// PUT /api/thermostats/:id/ranges  { comfort: { low, high }, allowed: { low, high } } — admin
thermostatsRouter.put('/:id/ranges', requireAdmin, (req: Request, res: Response) => {
  try { res.json(saveRanges(Number(req.params.id), req.body)); } catch (err) { fail(res, err); }
});
