import { Router, Request, Response } from 'express';
import { logger } from '../logger';
import { requireAdmin } from '../middleware/auth';
import * as alarm from '../alarmcom/alarmcom';
import { AlarmPinError, removeAlarmPin, setAlarmPin } from '../alarmcom/alarm-pin';
import type { CodeMethod } from '../alarmcom/types';

/**
 * The alarm system through Alarm.com, mounted at /api/alarm. Everyone signed in can see it and
 * arm it; disarming needs the alarm PIN. Signing in to Alarm.com and setting the PIN are admin
 * only. The password is never sent back.
 *
 * Arming and disarming are for people in the app: requests from the AI assistant server are
 * turned away, and Chat, voice, scenes and schedules have no way to reach them.
 */
export const alarmRouter = Router();

const text = (v: unknown, max = 200) => typeof v === 'string' && v.trim() !== '' && v.length <= max && !/[\r\n\0]/.test(v);
const METHODS: CodeMethod[] = ['sms', 'email', 'app'];

function fail(res: Response, err: unknown): void {
  if (err instanceof AlarmPinError) {
    res.status(err.status).json({ error: err.message, code: 'ALARM_PIN', ...(err.retryAfterSeconds ? { retryAfterSeconds: err.retryAfterSeconds } : {}) });
    return;
  }
  if (err instanceof alarm.AlarmCommandError) {
    res.status(err.status).json({ error: err.message, code: 'ALARM_COMMAND', ...err.extra });
    return;
  }
  if (err instanceof alarm.SignInError) {
    res.status(err.status).json({ error: err.message, code: 'ALARMCOM_SIGN_IN' });
    return;
  }
  logger.warn({ reason: (err as Error)?.message }, 'Alarm.com sign-in failed');
  res.status(502).json({ error: 'Alarm.com didn’t answer as expected. Try again in a minute.', code: 'ALARMCOM_ERROR' });
}

// GET /api/alarm — arm state and sensors. Reads Alarm.com first when the last read is more than a few seconds old.
alarmRouter.get('/', async (_req: Request, res: Response) => {
  // A slow Alarm.com mustn't hold the page: wait at most 4 s, then answer with what HomeHub has.
  await Promise.race([alarm.readIfStale(), new Promise((r) => setTimeout(r, 4_000).unref())]);
  res.json(alarm.alarmView());
});

// GET /api/alarm/login — the saved account, without the password
alarmRouter.get('/login', requireAdmin, (_req: Request, res: Response) => {
  res.json(alarm.accountStatus());
});

// PUT /api/alarm/login { username, password } — signs in; Alarm.com may then want a code
alarmRouter.put('/login', requireAdmin, async (req: Request, res: Response) => {
  const { username, password } = (req.body ?? {}) as Record<string, unknown>;
  if (!text(username) || typeof password !== 'string' || !password || password.length > 200) {
    return res.status(400).json({ error: 'Enter your Alarm.com username and password', code: 'VALIDATION_ERROR' });
  }
  try { res.json(await alarm.startSignIn((username as string).trim(), password)); } catch (err) { fail(res, err); }
});

// POST /api/alarm/login/send { method: 'sms' | 'email' } — asks Alarm.com to send the code
alarmRouter.post('/login/send', requireAdmin, async (req: Request, res: Response) => {
  const method = (req.body ?? {}).method as CodeMethod;
  if (!METHODS.includes(method) || method === 'app') return res.status(400).json({ error: 'Choose text or email', code: 'VALIDATION_ERROR' });
  try { res.json(await alarm.sendCode(method)); } catch (err) { fail(res, err); }
});

// POST /api/alarm/login/code { code } — the code; then this HomeHub is trusted and signed in
alarmRouter.post('/login/code', requireAdmin, async (req: Request, res: Response) => {
  const code = String((req.body ?? {}).code ?? '').replace(/\s/g, '');
  if (!/^\d{4,10}$/.test(code)) return res.status(400).json({ error: 'Enter the code: numbers only', code: 'VALIDATION_ERROR' });
  try { res.json(await alarm.submitCode(code)); } catch (err) { fail(res, err); }
});

// POST /api/alarm/login/app — the code will come from an authenticator app
alarmRouter.post('/login/app', requireAdmin, (_req: Request, res: Response) => {
  try { alarm.useApp(); res.status(204).end(); } catch (err) { fail(res, err); }
});

// DELETE /api/alarm/login/pending — gives up a sign-in waiting for its code
alarmRouter.delete('/login/pending', requireAdmin, (_req: Request, res: Response) => {
  alarm.cancelSignIn();
  res.status(204).end();
});

// DELETE /api/alarm/login — forgets the account and this HomeHub's trust
alarmRouter.delete('/login', requireAdmin, (_req: Request, res: Response) => {
  alarm.signOut();
  res.status(204).end();
});

/** People in the app only: never the AI assistant server. */
function fromPerson(req: Request, res: Response): boolean {
  if (req.headers['x-homehub-client']) {
    res.status(403).json({ error: 'Arming and disarming are done by people in the app.', code: 'FORBIDDEN' });
    return false;
  }
  return true;
}

const partitionId = (v: unknown): string | undefined => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : undefined);

// POST /api/alarm/arm { mode: 'stay' | 'away' | 'night', partitionId?, bypass? } — 409 with { open: [...] } when doors or windows are open
alarmRouter.post('/arm', async (req: Request, res: Response) => {
  if (!fromPerson(req, res)) return;
  const { mode, bypass } = (req.body ?? {}) as Record<string, unknown>;
  if (mode !== 'stay' && mode !== 'away' && mode !== 'night') return res.status(400).json({ error: 'Choose Stay or Away', code: 'VALIDATION_ERROR' });
  try {
    res.json(await alarm.arm(mode, { partitionId: partitionId(req.body?.partitionId), bypass: bypass === true, userName: req.user?.name ?? null }));
  } catch (err) { fail(res, err); }
});

// POST /api/alarm/disarm { pin, partitionId? }
alarmRouter.post('/disarm', async (req: Request, res: Response) => {
  if (!fromPerson(req, res)) return;
  try {
    res.json(await alarm.disarm(String(req.body?.pin ?? ''), { partitionId: partitionId(req.body?.partitionId), userName: req.user?.name ?? null }));
  } catch (err) { fail(res, err); }
});

// PUT /api/alarm/pin { pin } — sets or changes the alarm PIN
alarmRouter.put('/pin', requireAdmin, async (req: Request, res: Response) => {
  if (!fromPerson(req, res)) return;
  try {
    await setAlarmPin(req.body?.pin);
    alarm.republish();
    res.status(204).end();
  } catch (err) { fail(res, err); }
});

// DELETE /api/alarm/pin — no PIN: no disarming from HomeHub
alarmRouter.delete('/pin', requireAdmin, (req: Request, res: Response) => {
  if (!fromPerson(req, res)) return;
  removeAlarmPin();
  alarm.republish();
  res.status(204).end();
});
