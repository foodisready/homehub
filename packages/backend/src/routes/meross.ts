import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import * as meross from '../meross/meross';
import { logger } from '../logger';

/** Admin-only Meross account sign-in. Only the account key is stored. */
export const merossRouter = Router();

merossRouter.get('/login', (_req: Request, res: Response) => {
  res.json({ email: meross.savedEmail(), signedIn: meross.savedKey() !== null, hasNames: meross.hasCloudToken() });
});

// PUT /api/meross/login { email, password, code? }
merossRouter.put('/login', async (req: Request, res: Response) => {
  const { email, password, code } = req.body as { email?: unknown; password?: unknown; code?: unknown };
  if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Email and password are required', code: 'VALIDATION_ERROR' });
  }
  const mfa = typeof code === 'string' && code.trim() ? code.trim() : undefined;

  let account: meross.MerossAccount;
  try {
    account = await meross.signIn(email.trim(), password, mfa);
  } catch (err) {
    if (err instanceof meross.MerossCloudError) {
      const needsCode = err.code === 1033 || err.code === 1032;
      return res.status(422).json({ error: err.message, code: needsCode ? 'MEROSS_CODE_REQUIRED' : 'MEROSS_LOGIN_REJECTED' });
    }
    logger.warn({ reason: (err as Error).message }, 'Meross sign-in failed');
    return res.status(502).json({ error: 'Could not reach Meross. Check HomeHub has internet access.', code: 'MEROSS_UNREACHABLE' });
  }
  const { key } = account;
  meross.saveKey(email.trim(), key, account.token ? { token: account.token, domain: account.domain } : undefined);

  // Check the key on any registered Meross device, so a wrong account shows up now.
  const devices = getDb().prepare("SELECT alias, ip FROM devices WHERE driver_type = 'meross'").all() as { alias: string; ip: string }[];
  const rejectedBy: string[] = [];
  for (const d of devices) {
    try {
      await meross.getSystemAll(d.ip, key);
    } catch (err) {
      if (err instanceof meross.MerossKeyError) rejectedBy.push(d.alias);
    }
  }
  res.json({ email: email.trim(), signedIn: true, hasNames: meross.hasCloudToken(), rejectedBy });
});

merossRouter.delete('/login', (_req: Request, res: Response) => {
  meross.clearKey();
  res.status(204).end();
});

/**
 * Garage door openers on the Meross account, and whether each is in HomeHub.
 * Lets Settings point out an opener that Discover couldn't reach.
 */
merossRouter.get('/devices', async (_req: Request, res: Response) => {
  const cloud = await meross.cloudDevices();
  const registered = new Set(
    (getDb().prepare("SELECT driver_config FROM devices WHERE driver_type = 'meross'").all() as { driver_config: string | null }[])
      .map((d) => { try { return JSON.parse(d.driver_config ?? '{}').uuid as string | undefined; } catch { return undefined; } })
      .filter(Boolean),
  );
  res.json(cloud
    .filter((d) => /^msg/i.test(d.type))
    .map((d) => ({ uuid: d.uuid, name: d.name, type: d.type.toUpperCase(), online: d.online, registered: registered.has(d.uuid) })));
});
