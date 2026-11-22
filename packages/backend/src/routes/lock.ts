import { Router, Request, Response } from 'express';
import { checkPin, hasPin, LockPinError, pinLength, removePin, setPin } from '../auth/lock-pin';

/** The signed-in person's PIN for locking a shared screen (auth/lock-pin.ts), at /api/lock. */
export const lockRouter = Router();

const fail = (res: Response, err: unknown) => {
  if (!(err instanceof LockPinError)) throw err;
  if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
  res.status(err.status).json({ error: err.message, code: 'LOCK_PIN', retryAfterSeconds: err.retryAfterSeconds ?? null });
};

lockRouter.get('/', (req: Request, res: Response) => {
  res.json({ set: hasPin(req.user!.sub), length: pinLength(req.user!.sub) });
});

// PUT /api/lock { pin, current?, password? } — sets or changes it; changing needs the current PIN or the password
lockRouter.put('/', async (req: Request, res: Response) => {
  try {
    await setPin(req.user!.sub, req.body?.pin, req.body?.current, req.body?.password);
    res.json({ set: true, length: pinLength(req.user!.sub) });
  } catch (err) { fail(res, err); }
});

// POST /api/lock/check { pin }
lockRouter.post('/check', async (req: Request, res: Response) => {
  try {
    await checkPin(req.user!.sub, req.body?.pin);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// DELETE /api/lock { current?, password? }
lockRouter.delete('/', async (req: Request, res: Response) => {
  try {
    await removePin(req.user!.sub, req.body?.current, req.body?.password);
    res.json({ set: false });
  } catch (err) { fail(res, err); }
});
