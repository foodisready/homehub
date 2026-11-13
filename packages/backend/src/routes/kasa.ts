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

/**
 * Tries the login on the plug it's for (`ip`), or else on every plug that needs one, until
 * one accepts it. Plugs can hold different passwords for the same account (each keeps the
 * one it last synced), so one plug refusing it says nothing about the others.
 * Returns false if no plug answered; throws KlapAuthError if every plug that answered refused it.
 */
async function verifyLogin(login: klap.KasaLogin, ip?: string): Promise<boolean> {
  const plugs = await loginPlugAddresses();
  // Only an address HomeHub knows as a plug that needs a login: never somewhere else on the network.
  const addresses = ip && plugs.includes(ip) ? [ip] : plugs;
  let refused: klap.KlapAuthError | null = null;
  for (const address of addresses) {
    try {
      await klap.checkLogin(address, login);
      return true;
    } catch (err) {
      if (err instanceof klap.KlapAuthError) refused = err;
      else logger.debug({ ip: address }, 'Kasa plug did not answer the login check');
    }
  }
  if (refused) throw refused;
  return false;
}

// GET /api/kasa/login — never returns the password
kasaRouter.get('/login', (_req: Request, res: Response) => {
  res.json({ username: klap.savedUsername(), count: klap.savedLoginCount() });
});

// PUT /api/kasa/login { username, password, ip? } — checks the login on the plug at ip (or on
// any plug that needs one), then saves it as the newest. Older logins are kept and still tried.
kasaRouter.put('/login', async (req: Request, res: Response) => {
  const { username, password, ip } = req.body as { username?: unknown; password?: unknown; ip?: unknown };
  if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Email and password are required', code: 'VALIDATION_ERROR' });
  }

  const login = klap.makeLogin(username.trim(), password);
  try {
    const verified = await verifyLogin(login, typeof ip === 'string' && ip.trim() ? ip.trim() : undefined);
    klap.saveLogin(login);
    res.json({ username: login.username, verified });
  } catch (err) {
    if (err instanceof klap.KlapAuthError) {
      return res.status(422).json({
        error: typeof ip === 'string' && ip.trim()
          ? 'This plug rejected that email or password.'
          : 'The plugs rejected that email or password.',
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
