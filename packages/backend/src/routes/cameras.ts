import { Router, Request, Response } from 'express';
import { Readable } from 'stream';
import { getDb } from '../db';
import { logger } from '../logger';
import { requireAdmin } from '../middleware/auth';
import { getCachedState } from '../kasa/device.cache';
import * as bridge from '../cameras/bridge';
import * as snaps from '../cameras/snapshots';
import { cameraDevices } from '../cameras/watch';
import { clearPowerCache } from '../drivers/WyzeDriver';

/**
 * Wyze cameras through docker-wyze-bridge. Everyone signed in can watch and
 * see snapshots; signing the bridge in, changing settings and deleting
 * snapshots are admin only. Pausing a camera uses the normal device on/off.
 */
export const camerasRouter = Router();

function fail(res: Response, err: unknown, fallback = 'Camera request failed'): void {
  if (err instanceof bridge.BridgeError) {
    res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({ error: err.message, code: 'CAMERA_ERROR' });
    return;
  }
  logger.warn({ reason: (err as Error).message }, fallback);
  res.status(502).json({ error: fallback, code: 'CAMERA_ERROR' });
}

const isId = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v);

const deviceParam = (req: Request) => {
  if (!isId(req.params.deviceId)) return null;
  const id = Number(req.params.deviceId);
  return cameraDevices().find((d) => d.id === id) ?? null;
};

// GET /api/cameras/bridge — is the bridge set up and signed in?
camerasRouter.get('/bridge', async (_req: Request, res: Response) => {
  res.json(await bridge.getState());
});

// POST /api/cameras/bridge/login { email, password, keyId, apiKey } — passed to the bridge, not stored
camerasRouter.post('/bridge/login', requireAdmin, async (req: Request, res: Response) => {
  const { email, password, keyId, apiKey } = req.body as Record<string, unknown>;
  const fields = { email, password, keyId, apiKey };
  if (Object.values(fields).some((v) => typeof v !== 'string' || !v.trim())) {
    return res.status(400).json({ error: 'Enter your Wyze email, password, API key ID and API key', code: 'VALIDATION_ERROR' });
  }
  try {
    await bridge.signIn({ email: (email as string).trim(), password: password as string, keyId: (keyId as string).trim(), apiKey: (apiKey as string).trim() });
    clearPowerCache();
    res.json(await bridge.getState());
  } catch (err) { fail(res, err, 'Wyze sign-in failed'); }
});

// GET /api/cameras/bridge/cameras — every camera on the Wyze account, and whether it's in HomeHub
camerasRouter.get('/bridge/cameras', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const added = new Set(cameraDevices().map((d) => d.cam));
    res.json((await bridge.listCameras()).map((c) => ({
      cam: c.id, name: c.name, model: c.modelName ?? c.model, ip: c.ip, mac: c.mac,
      streaming: c.connected, added: added.has(c.id),
    })));
  } catch (err) { fail(res, err, 'Could not list the cameras'); }
});

// GET /api/cameras/settings
camerasRouter.get('/settings', (_req: Request, res: Response) => {
  res.json({ ...snaps.getSettings(), limits: snaps.LIMITS });
});

// PUT /api/cameras/settings
camerasRouter.put('/settings', requireAdmin, (req: Request, res: Response) => {
  try {
    res.json({ ...snaps.saveSettings(req.body ?? {}), limits: snaps.LIMITS });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message, code: 'VALIDATION_ERROR' });
  }
});

// GET /api/cameras/snapshots?deviceId=&before=&limit=
camerasRouter.get('/snapshots', (req: Request, res: Response) => {
  const num = (v: unknown) => (v === undefined || v === '' ? undefined : Number(v));
  const deviceId = num(req.query.deviceId);
  const before = num(req.query.before);
  const limit = num(req.query.limit);
  if ([deviceId, before, limit].some((v) => v !== undefined && !Number.isInteger(v))) {
    return res.status(400).json({ error: 'deviceId, before and limit must be whole numbers', code: 'VALIDATION_ERROR' });
  }
  res.json(snaps.listSnapshots({ deviceId, before, limit }));
});

// GET /api/cameras/snapshots/:id/image
camerasRouter.get('/snapshots/:id/image', (req: Request, res: Response) => {
  const file = isId(req.params.id) ? snaps.snapshotFile(Number(req.params.id)) : null;
  if (!file) return res.status(404).json({ error: 'Snapshot not found', code: 'NOT_FOUND' });
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
  res.type('jpeg').sendFile(file);
});

// DELETE /api/cameras/snapshots/:id
camerasRouter.delete('/snapshots/:id', requireAdmin, (req: Request, res: Response) => {
  if (!isId(req.params.id) || !snaps.deleteSnapshot(Number(req.params.id))) return res.status(404).json({ error: 'Snapshot not found', code: 'NOT_FOUND' });
  res.status(204).end();
});

// GET /api/cameras — the cameras added to HomeHub, with what the bridge knows about each
camerasRouter.get('/', async (_req: Request, res: Response) => {
  const devices = cameraDevices();
  const rooms = new Map((getDb().prepare("SELECT id, room FROM devices WHERE driver_type = 'wyze'").all() as { id: number; room: string | null }[])
    .map((r) => [r.id, r.room]));
  let live: bridge.BridgeCamera[] = [];
  let bridgeError: string | null = null;
  try {
    live = await bridge.listCameras();
  } catch (err) {
    bridgeError = (err as Error).message;
  }
  res.json({
    bridgeError,
    cameras: devices.map((d) => {
      const cam = live.find((c) => c.id === d.cam);
      const cached = getCachedState(d.id);
      return {
        deviceId: d.id,
        name: d.alias,
        room: rooms.get(d.id) ?? null,
        cam: d.cam,
        model: cam?.modelName ?? cam?.model ?? null,
        watching: cached?.state ?? null,      // null until the first check
        online: cached?.online ?? null,
        streaming: cam?.connected ?? false,
        lastMotionAt: cam?.motionTs ? new Date(cam.motionTs * 1000).toISOString() : null,
        latestSnapshot: snaps.latestFor(d.id),
      };
    }),
  });
});

// GET /api/cameras/:deviceId/live.jpg?cached=1 — a picture from the camera now
camerasRouter.get('/:deviceId/live.jpg', async (req: Request, res: Response) => {
  const device = deviceParam(req);
  if (!device) return res.status(404).json({ error: 'Camera not found', code: 'NOT_FOUND' });
  try {
    const jpeg = await bridge.snapshot(device.cam, req.query.cached !== '1');
    res.setHeader('Cache-Control', 'no-store');
    res.type('jpeg').send(jpeg);
  } catch (err) { fail(res, err, 'No picture from this camera'); }
});

// POST /api/cameras/:deviceId/snapshots — save a picture now
camerasRouter.post('/:deviceId/snapshots', async (req: Request, res: Response) => {
  const device = deviceParam(req);
  if (!device) return res.status(404).json({ error: 'Camera not found', code: 'NOT_FOUND' });
  try {
    res.status(201).json(await snaps.capture(device, 'manual'));
  } catch (err) { fail(res, err, 'Could not take a snapshot'); }
});

/**
 * GET /api/cameras/:deviceId/hls/<file> — live video, relayed from the bridge's
 * HLS server so it works over HomeHub's own HTTPS address and login.
 */
camerasRouter.get('/:deviceId/hls/*path', async (req: Request, res: Response) => {
  const device = deviceParam(req);
  if (!device) return res.status(404).json({ error: 'Camera not found', code: 'NOT_FOUND' });
  // Express 5 gives a named wildcard as its path segments.
  const raw = (req.params as Record<string, unknown>).path;
  const rest = Array.isArray(raw) ? raw.join('/') : String(raw ?? '');
  if (!/^[A-Za-z0-9._\-/]+$/.test(rest) || rest.includes('..')) {
    return res.status(400).json({ error: 'Bad stream path', code: 'VALIDATION_ERROR' });
  }
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const abort = new AbortController();
  req.on('close', () => abort.abort());
  try {
    const upstream = await bridge.hlsFetch(`${encodeURIComponent(device.cam)}/${rest}${query}`, abort.signal);
    res.status(upstream.status);
    for (const h of ['content-type', 'cache-control', 'content-length']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body as never).on('error', () => res.end()).pipe(res);
  } catch (err) {
    if (abort.signal.aborted) return;
    fail(res, err, 'Live video is unavailable');
  }
});
