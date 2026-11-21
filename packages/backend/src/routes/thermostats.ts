import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { changeThermostat, getThermostat, listThermostats, resumeOwnSchedule, saveRanges, ThermostatError } from '../thermostat/thermostat';
import { day, months, reportsRunning } from '../thermostat/history';
import { getHomeSettings } from '../home/home-settings';
import { DEFAULT_SIZE, hvacSystem, saveHvacSystem } from '../energy/usage';
import { nextDue, saveSchedule, schedulePoints } from '../thermostat/schedule';
import { temperatureUnit } from '../home/weather';
import { awayActive } from '../home/away-state';

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

// POST /api/thermostats/:id/resume — a thermostat with its own schedule (Honeywell) follows it again
thermostatsRouter.post('/:id/resume', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!(await resumeOwnSchedule(id))) return res.status(400).json({ error: 'That thermostat has no schedule of its own.', code: 'THERMOSTAT' });
    res.json(await getThermostat(id));
  } catch (err) { fail(res, err); }
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

// GET /api/thermostats/:id/system — the heating and cooling it runs, for estimates
thermostatsRouter.get('/:id/system', async (req: Request, res: Response) => {
  try { const t = await getThermostat(Number(req.params.id)); res.json({ ...hvacSystem(t.id), defaults: DEFAULT_SIZE }); } catch (err) { fail(res, err); }
});

// PUT /api/thermostats/:id/system  { heat, heatSize, cool, coolSize } — admin
thermostatsRouter.put('/:id/system', requireAdmin, async (req: Request, res: Response) => {
  try {
    const t = await getThermostat(Number(req.params.id));
    res.json(saveHvacSystem(t.id, req.body));
  } catch (err) {
    if (err instanceof ThermostatError) return fail(res, err);
    res.status(400).json({ error: (err as Error).message, code: 'VALIDATION_ERROR' });
  }
});

// PUT /api/thermostats/:id/ranges  { comfort: { low, high }, allowed: { low, high } } — admin
thermostatsRouter.put('/:id/ranges', requireAdmin, (req: Request, res: Response) => {
  try { res.json(saveRanges(Number(req.params.id), req.body)); } catch (err) { fail(res, err); }
});

/** A schedule and its next change, for the page. */
function scheduleView(id: number) {
  const points = schedulePoints(id);
  const next = nextDue(points, new Date());
  return {
    points,
    next: next ? { at: next.at.toISOString(), pointId: next.point.id, heat: next.point.heat, cool: next.point.cool } : null,
    unit: temperatureUnit(),
    timezone: getHomeSettings().timezone,
    /** Away mode holds the away temperature; the schedule picks up again after. */
    away: awayActive(),
  };
}

// GET /api/thermostats/:id/schedule — its weekly temperature changes and the next one
thermostatsRouter.get('/:id/schedule', async (req: Request, res: Response) => {
  try { const t = await getThermostat(Number(req.params.id)); res.json(scheduleView(t.id)); } catch (err) { fail(res, err); }
});

// PUT /api/thermostats/:id/schedule  { points: [{ days, time | sun, heat, cool, enabled }] } — admin; replaces the whole schedule
thermostatsRouter.put('/:id/schedule', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    await saveSchedule(id, req.body);
    res.json(scheduleView(id));
  } catch (err) { fail(res, err); }
});
