import { Router, Request, Response } from 'express';
import SunCalc from 'suncalc';
import { requireAdmin } from '../middleware/auth';
import { getHomeSettings, saveHomeSettings, unitForTimezone, HomeSettingsError, type HomeSettings } from '../home/home-settings';
import { notifyScheduler } from './schedules';
import { logger } from '../logger';
import { describeWeather, getWeather, WeatherError } from '../home/weather';

/** Settings → Home: the home's location and time zone, and the AI assistant connection. */
export const homeSettingsRouter = Router();

/**
 * The settings plus today's sunrise and sunset, so the page can show they're right, and the unit
 * "Automatic" would give: .env's TEMPERATURE_UNIT, or the time zone's.
 */
function withToday(settings: HomeSettings) {
  const env = process.env.TEMPERATURE_UNIT?.trim().toUpperCase();
  const fromEnv = env === 'C' || env === 'F';
  const s = {
    ...settings,
    autoTemperature: { unit: fromEnv ? env : unitForTimezone(settings.timezone), from: fromEnv ? 'env' : 'timezone' },
  };
  if (s.latitude === null || s.longitude === null) return { ...s, today: null };
  const t = SunCalc.getTimes(new Date(), s.latitude, s.longitude);
  const iso = (d: Date) => (Number.isNaN(d.getTime()) ? null : d.toISOString());   // none near the poles
  return { ...s, today: { sunrise: iso(t.sunrise), sunset: iso(t.sunset) } };
}

// Anyone signed in may read these; the MCP server's sunrise tool does too.
homeSettingsRouter.get('/', (_req: Request, res: Response) => {
  res.json(withToday(getHomeSettings()));
});

// GET /api/home-settings/weather — now and today, for the wall display. Cached by getWeather.
homeSettingsRouter.get('/weather', async (_req: Request, res: Response) => {
  try {
    const w = await getWeather();
    res.json({
      unit: w.unit,
      temperature: w.now.temperature, feelsLike: w.now.feelsLike, summary: describeWeather(w.now.code), code: w.now.code,
      today: { high: w.today.high, low: w.today.low, rain: w.today.rain, summary: describeWeather(w.today.code) },
    });
  } catch (err) {
    if (err instanceof WeatherError) return res.status(err.code === 'NOT_LOCATED' ? 409 : 503).json({ error: err.message, code: err.code });
    logger.warn({ err }, 'Weather for the wall display failed');
    res.status(503).json({ error: "I can't get the weather right now.", code: 'UNREACHABLE' });
  }
});

homeSettingsRouter.put('/', requireAdmin, (req: Request, res: Response) => {
  try {
    const before = getHomeSettings();
    const after = saveHomeSettings(req.body ?? {});
    logger.info({ timezone: after.timezone, located: after.located, unit: after.temperatureUnit, by: req.user?.name }, 'Home settings saved');
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
