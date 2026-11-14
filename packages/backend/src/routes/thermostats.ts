import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { changeThermostat, getThermostat, listThermostats, saveRanges, ThermostatError } from '../thermostat/thermostat';
import { day, months, reportsRunning } from '../thermostat/history';
import { getHomeSettings } from '../home/home-settings';

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

// GET /api/thermostats/:id/months?count=12 — running hours and degree-days by month, oldest first
thermostatsRouter.get('/:id/months', async (req: Request, res: Response) => {
  try {
    const t = await getThermostat(Number(req.params.id));
    const count = Math.min(Math.max(Number(req.query.count) || 12, 1), 25);
    const now = Date.now();
    const local = new Date(now);
    const today = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
    const d = day(t.id, today, now);
    res.json({
      months: months(t.id, count, now),
      today: { heatHours: d.heatHours, coolHours: d.coolHours },
      reportsRunning: t.running !== null || reportsRunning(t.id),
      unit: t.unit,
      // Days and months are the home's: a phone elsewhere labels times in this zone.
      timezone: getHomeSettings().timezone,
      todayDate: today,
    });
  } catch (err) { fail(res, err); }
});

// GET /api/thermostats/:id/day?date=YYYY-MM-DD — one local day: samples, runs, outdoor temperatures
thermostatsRouter.get('/:id/day', async (req: Request, res: Response) => {
  try {
    const t = await getThermostat(Number(req.params.id));
    const date = typeof req.query.date === 'string' ? req.query.date : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD', code: 'VALIDATION_ERROR' });
    res.json({ ...day(t.id, date), unit: t.unit, timezone: getHomeSettings().timezone });
  } catch (err) { fail(res, err); }
});

// PUT /api/thermostats/:id/ranges  { comfort: { low, high }, allowed: { low, high } } — admin
thermostatsRouter.put('/:id/ranges', requireAdmin, (req: Request, res: Response) => {
  try { res.json(saveRanges(Number(req.params.id), req.body)); } catch (err) { fail(res, err); }
});
