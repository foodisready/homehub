import { Router, Request, Response } from 'express';
import SunCalc from 'suncalc';
import { requireAdmin } from '../middleware/auth';
import { getHomeSettings, saveHomeSettings, HomeSettingsError, type HomeSettings } from '../home/home-settings';
import { notifyScheduler } from './schedules';
import { logger } from '../logger';

/** Settings → Home: the home's location and time zone, and the AI assistant connection. */
export const homeSettingsRouter = Router();

/** The settings plus today's sunrise and sunset, so the page can show they're right. */
function withToday(s: HomeSettings) {
  if (s.latitude === null || s.longitude === null) return { ...s, today: null };
  const t = SunCalc.getTimes(new Date(), s.latitude, s.longitude);
  const iso = (d: Date) => (Number.isNaN(d.getTime()) ? null : d.toISOString());   // none near the poles
  return { ...s, today: { sunrise: iso(t.sunrise), sunset: iso(t.sunset) } };
}

// Anyone signed in may read these; the MCP server's sunrise tool does too.
homeSettingsRouter.get('/', (_req: Request, res: Response) => {
  res.json(withToday(getHomeSettings()));
});

homeSettingsRouter.put('/', requireAdmin, (req: Request, res: Response) => {
  try {
    const before = getHomeSettings();
    const after = saveHomeSettings(req.body ?? {});
    logger.info({ timezone: after.timezone, located: after.located, by: req.user?.name }, 'Home settings saved');
    // The scheduler reads them from the database; reload so sunrise and clock times move now.
    if (before.timezone !== after.timezone || before.latitude !== after.latitude || before.longitude !== after.longitude) {
      notifyScheduler();
    }
    res.json(withToday(after));
  } catch (err) {
    if (err instanceof HomeSettingsError) {
      res.status(400).json({ error: err.message, code: 'VALIDATION_ERROR' });
      return;
    }
    throw err;
  }
});

// What an AI app needs to connect to HomeHub's MCP server. Admin only: the secret controls every device.
homeSettingsRouter.get('/mcp', requireAdmin, (_req: Request, res: Response) => {
  res.json({ secret: process.env.MCP_SECRET ?? null, port: 3001 });
});
