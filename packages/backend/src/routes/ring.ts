import { Router, Request, Response } from 'express';
import { logger } from '../logger';
import { requireAdmin } from '../middleware/auth';
import * as ring from '../ring/ring';
import { RingAuthError } from '../ring/ring-client';

/**
 * Ring cameras and doorbells. Everyone signed in can see them and take a
 * snapshot; signing in to Ring, adding cameras and settings are admin only.
 */
export const ringRouter = Router();

function fail(res: Response, err: unknown, fallback: string): void {
  if (err instanceof ring.RingError) {
    res.status(err.status).json({ error: err.message, code: 'RING_ERROR' });
    return;
  }
  if (err instanceof RingAuthError) {
    res.status(422).json({ error: err.message, code: 'RING_SIGN_IN' });
    return;
  }
  logger.warn({ reason: (err as Error).message }, fallback);
  res.status(502).json({ error: (err as Error).message || fallback, code: 'RING_ERROR' });
}

const text = (v: unknown, max = 500) => typeof v === 'string' && v.trim() !== '' && v.length <= max && !/[\r\n\0]/.test(v);
const idParam = (req: Request) => (/^\d+$/.test(String(req.params.id)) ? Number(req.params.id) : null);

// GET /api/ring — whether HomeHub is signed in and connected, and the Ring cameras added to it
ringRouter.get('/', (_req: Request, res: Response) => {
  res.json({ ...ring.ringState(), cameras: ring.cameraStatuses(), notifyDoorbell: ring.notifyDoorbell() });
});

// POST /api/ring/login { email, password } — Ring then usually sends a code
ringRouter.post('/login', requireAdmin, async (req: Request, res: Response) => {
  const { email, password } = req.body as Record<string, unknown>;
  if (!text(email) || !text(password)) {
    return res.status(400).json({ error: 'Enter your Ring email and password', code: 'VALIDATION_ERROR' });
  }
  try {
    res.json(await ring.startSignIn((email as string).trim(), password as string));
  } catch (err) { fail(res, err, 'Ring sign-in failed'); }
});

// POST /api/ring/login/code { code }
ringRouter.post('/login/code', requireAdmin, async (req: Request, res: Response) => {
  const code = (req.body as Record<string, unknown>).code;
  if (typeof code !== 'string' || !/^\d{4,8}$/.test(code.replace(/\s/g, ''))) {
    return res.status(400).json({ error: 'Enter the code Ring sent you', code: 'VALIDATION_ERROR' });
  }
  try {
    res.json(await ring.submitCode(code.replace(/\s/g, '')));
  } catch (err) { fail(res, err, 'Ring sign-in failed'); }
});

// DELETE /api/ring/login — forget the Ring sign-in. Added cameras stay listed, for signing in again.
ringRouter.delete('/login', requireAdmin, (_req: Request, res: Response) => {
  ring.signOut();
  res.json(ring.ringState());
});

// GET /api/ring/account — every camera on the Ring account, and whether it's in HomeHub
ringRouter.get('/account', requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.json(await ring.accountCameras());
  } catch (err) { fail(res, err, 'Could not list the Ring cameras'); }
});

// POST /api/ring/cameras { id } — add a camera from the Ring account
ringRouter.post('/cameras', requireAdmin, async (req: Request, res: Response) => {
  const id = (req.body as Record<string, unknown>).id;
  if (!Number.isSafeInteger(id)) return res.status(400).json({ error: 'id must be a Ring camera id', code: 'VALIDATION_ERROR' });
  try {
    res.status(201).json(await ring.addCamera(id as number));
  } catch (err) { fail(res, err, 'Could not add the camera'); }
});

// DELETE /api/ring/cameras/:id — take a camera out of HomeHub
ringRouter.delete('/cameras/:id', requireAdmin, (req: Request, res: Response) => {
  const id = idParam(req);
  if (id === null || !ring.removeCamera(id)) return res.status(404).json({ error: 'Camera not found', code: 'NOT_FOUND' });
  res.status(204).end();
});

// POST /api/ring/cameras/:id/snapshots — save a picture now
ringRouter.post('/cameras/:id/snapshots', async (req: Request, res: Response) => {
  const id = idParam(req);
  if (id === null) return res.status(404).json({ error: 'Camera not found', code: 'NOT_FOUND' });
  try {
    res.status(201).json(await ring.takeSnapshot(id));
  } catch (err) { fail(res, err, 'Could not take a snapshot'); }
});

// PUT /api/ring/settings { notifyDoorbell }
ringRouter.put('/settings', requireAdmin, (req: Request, res: Response) => {
  const { notifyDoorbell } = req.body as Record<string, unknown>;
  if (typeof notifyDoorbell !== 'boolean') {
    return res.status(400).json({ error: 'notifyDoorbell must be true or false', code: 'VALIDATION_ERROR' });
  }
  ring.setNotifyDoorbell(notifyDoorbell);
  res.json({ notifyDoorbell: ring.notifyDoorbell() });
});

// POST /api/ring/cameras/:id/live { offer } — start live video. The answer
// connects the browser straight to Ring; the video doesn't pass through HomeHub.
ringRouter.post('/cameras/:id/live', async (req: Request, res: Response) => {
  const id = idParam(req);
  const offer = (req.body as Record<string, unknown>).offer;
  if (id === null) return res.status(404).json({ error: 'Camera not found', code: 'NOT_FOUND' });
  if (typeof offer !== 'string' || !offer.startsWith('v=0') || offer.length > 30_000) {
    return res.status(400).json({ error: 'offer must be a WebRTC offer', code: 'VALIDATION_ERROR' });
  }
  try {
    res.json(await ring.startLive(id, offer));
  } catch (err) { fail(res, err, 'Live video didn\'t start'); }
});

// DELETE /api/ring/live/:sessionId — stop live video
ringRouter.delete('/live/:sessionId', async (req: Request, res: Response) => {
  const ended = await ring.endLive(String(req.params.sessionId));
  res.status(ended ? 204 : 404).end();
});
