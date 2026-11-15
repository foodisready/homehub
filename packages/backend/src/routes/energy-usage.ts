import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { getPrices, monthTotals, monthUsage, savePrices } from '../energy/usage';
import { getHomeSettings } from '../home/home-settings';
import { getPanel, panelLive, panelMonth, PanelError, pollPanel, readPanel, savePanel, channelSetting } from '../energy/panel';

/** Where the electricity goes, mounted at /api/energy. */
export const energyUsageRouter = Router();

const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

// GET /api/energy/usage?month=YYYY-MM — each device's estimate or measurement for a month, and 12 months of totals
energyUsageRouter.get('/usage', (req: Request, res: Response) => {
  const month = typeof req.query.month === 'string' && req.query.month ? req.query.month : thisMonth();
  if (!/^\d{4}-\d{2}$/.test(month) || month > thisMonth()) {
    return res.status(400).json({ error: 'month must be YYYY-MM, this month or earlier', code: 'VALIDATION_ERROR' });
  }
  res.json({ ...monthUsage(month), months: monthTotals(12), thisMonth: thisMonth(), timezone: getHomeSettings().timezone, panel: panelMonth(month) });
});

// GET /api/energy/prices
energyUsageRouter.get('/prices', (_req: Request, res: Response) => { res.json(getPrices()); });

// PUT /api/energy/prices  { electricity: per kWh | null, gas: per therm | null, currency? } — admin
energyUsageRouter.put('/prices', requireAdmin, (req: Request, res: Response) => {
  try { res.json(savePrices(req.body)); } catch (err) { res.status(400).json({ error: (err as Error).message, code: 'VALIDATION_ERROR' }); }
});

// ── Panel monitor ───────────────────────────────────────────────

/** The settings without the password, and how each clamp reads now. */
function panelView() {
  const s = getPanel();
  if (!s) return { set: false as const };
  const { read, error } = panelLive();
  return {
    set: true as const, ip: s.ip, hasPassword: !!s.password, error,
    model: read?.model ?? null, profile: read?.profile ?? null, at: read?.at ?? null, problems: read?.errors ?? [],
    channels: (read?.channels ?? []).map((c) => ({ ...c, ...channelSetting(s, c.key) })),
  };
}

// GET /api/energy/panel: the panel monitor, if one is set up, and what it reads now
energyUsageRouter.get('/panel', (_req: Request, res: Response) => { res.json(panelView()); });

// POST /api/energy/panel/test  { ip, password? }: reads a meter before it's saved (admin)
energyUsageRouter.post('/panel/test', requireAdmin, async (req: Request, res: Response) => {
  const { ip, password } = (req.body ?? {}) as { ip?: unknown; password?: unknown };
  const saved = getPanel();
  const pass = typeof password === 'string' && password ? password : saved && saved.ip === ip ? saved.password : null;
  try {
    if (typeof ip !== 'string' || !ip.trim()) throw new PanelError('Enter the meter’s address');
    res.json(await readPanel(ip.trim(), pass));
  } catch (err) {
    res.status(400).json({ error: err instanceof PanelError ? err.message : 'The meter couldn’t be read', code: 'PANEL_ERROR' });
  }
});

// PUT /api/energy/panel  { ip, password?, channels?: { a: { name, role } } }; { ip: null } removes it (admin)
energyUsageRouter.put('/panel', requireAdmin, async (req: Request, res: Response) => {
  try {
    savePanel(req.body);
    await pollPanel();
    res.json(panelView());
  } catch (err) {
    if (err instanceof PanelError) return res.status(400).json({ error: err.message, code: 'VALIDATION_ERROR' });
    throw err;
  }
});
