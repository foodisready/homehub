import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { getPrices, monthTotals, monthUsage, savePrices } from '../energy/usage';
import { getHomeSettings } from '../home/home-settings';

/** Where the electricity goes, mounted at /api/energy. */
export const energyUsageRouter = Router();

const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

// GET /api/energy/usage?month=YYYY-MM — each device's estimate or measurement for a month, and 12 months of totals
energyUsageRouter.get('/usage', (req: Request, res: Response) => {
  const month = typeof req.query.month === 'string' && req.query.month ? req.query.month : thisMonth();
  if (!/^\d{4}-\d{2}$/.test(month) || month > thisMonth()) {
    return res.status(400).json({ error: 'month must be YYYY-MM, this month or earlier', code: 'VALIDATION_ERROR' });
  }
  res.json({ ...monthUsage(month), months: monthTotals(12), thisMonth: thisMonth(), timezone: getHomeSettings().timezone });
});

// GET /api/energy/prices
energyUsageRouter.get('/prices', (_req: Request, res: Response) => { res.json(getPrices()); });

// PUT /api/energy/prices  { electricity: per kWh | null, gas: per therm | null, currency? } — admin
energyUsageRouter.put('/prices', requireAdmin, (req: Request, res: Response) => {
  try { res.json(savePrices(req.body)); } catch (err) { res.status(400).json({ error: (err as Error).message, code: 'VALIDATION_ERROR' }); }
});
