import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import * as klap from '../kasa/klap';
import { logger } from '../logger';

export const kasaRouter = Router();

/** Addresses of plugs that need a login, registered ones first. */
async function loginPlugAddresses(): Promise<string[]> {
  const rows = getDb().prepare(
    "SELECT ip, driver_config FROM devices WHERE driver_type = 'kasa' AND driver_config IS NOT NULL",
  ).all() as { ip: string; driver_config: string }[];
  const registered = rows
    .filter((row) => (JSON.parse(row.driver_config) as { protocol?: string }).protocol === 'klap')
    .map((row) => row.ip);
  const found = await klap.discoverKlap();
  return [...new Set([...registered, ...found.map((plug) => plug.ip)])];
}

/** Tries the login on the first plug that answers. Returns false if none did. */
async function verifyLogin(login: klap.KasaLogin): Promise<boolean> {
  for (const ip of await loginPlugAddresses()) {
    try {
      await klap.checkLogin(ip, login);
      return true;
    } catch (err) {
      if (err instanceof klap.KlapAuthError) throw err;
      logger.debug({ ip }, 'Kasa plug did not answer the login check');
    }
  }
  return false;
}

// GET /api/kasa/login — never returns the password
kasaRouter.get('/login', (_req: Request, res: Response) => {
  res.json({ username: klap.savedUsername() });
});

// PUT /api/kasa/login — checks the login on a plug, then saves it
kasaRouter.put('/login', async (req: Request, res: Response) => {
  const { username, password } = req.body as { username?: unknown; password?: unknown };
  if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Email and password are required', code: 'VALIDATION_ERROR' });
  }

  const login = klap.makeLogin(username.trim(), password);
  try {
    const verified = await verifyLogin(login);
    klap.saveLogin(login);
    res.json({ username: login.username, verified });
  } catch (err) {
    if (err instanceof klap.KlapAuthError) {
      return res.status(422).json({
        error: 'The plug rejected that email or password.',
        code: 'KASA_LOGIN_REJECTED',
      });
    }
    logger.error({ reason: (err as Error).message }, 'Could not save the Kasa login');
    res.status(500).json({ error: 'Could not save the login', code: 'KASA_LOGIN_FAILED' });
  }
});

// DELETE /api/kasa/login
kasaRouter.delete('/login', (_req: Request, res: Response) => {
  klap.clearLogin();
  res.status(204).end();
});
