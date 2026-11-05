import { Router, Request, Response } from 'express';
import { cameraBridgeInstalled } from '../secrets';
import { Readable } from 'stream';
import { getDb } from '../db';
import { logger } from '../logger';
import { requireAdmin } from '../middleware/auth';
import { getCachedState } from '../kasa/device.cache';
import * as bridge from '../cameras/bridge';
import * as snaps from '../cameras/snapshots';
import { cameraDevices, lastMotionFor, liveCameras } from '../cameras/watch';
import { noPictureHint, pictureHealth } from '../cameras/picture-status';
import { clearPowerCache } from '../drivers/WyzeDriver';
import { canPan, isMoving, ptz, PTZ_ACTIONS, type PtzAction } from '../cameras/ptz';

/**
 * Wyze cameras through the camera bridge. Everyone signed in can watch and
 * see snapshots; signing in to Wyze, changing settings and deleting
 * snapshots are admin only.
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
  if (!snaps.getSettings().enabled) return res.json({ state: 'off' });
  res.json(await bridge.getState());
});

// POST /api/cameras/bridge/login { email, password, keyId, apiKey } — saved for the bridge, which restarts with it
camerasRouter.post('/bridge/login', requireAdmin, async (req: Request, res: Response) => {
  const { email, password, keyId, apiKey } = req.body as Record<string, unknown>;
  const fields = { email, password, keyId, apiKey };
  if (Object.values(fields).some((v) => typeof v !== 'string' || !v.trim() || v.length > 500 || /[\r\n\0]/.test(v))) {
    return res.status(400).json({ error: 'Enter your Wyze email, password, API key ID and API key', code: 'VALIDATION_ERROR' });
  }
  if (!process.env.WYZE_BRIDGE_API_KEY) {
    return res.status(409).json({ error: 'The camera bridge is left out of this HomeHub', code: 'NOT_CONFIGURED' });
  }
  try {
    const state = await bridge.signIn({ email: (email as string).trim(), password: password as string, keyId: (keyId as string).trim(), apiKey: (apiKey as string).trim() });
    clearPowerCache();
    res.json(state);
  } catch (err) { fail(res, err, 'Wyze sign-in failed'); }
});

// DELETE /api/cameras/bridge/login — sign out of Wyze: the saved sign-in is deleted and the bridge stops
camerasRouter.delete('/bridge/login', requireAdmin, async (_req: Request, res: Response) => {
  bridge.clearSignIn();
  clearPowerCache();
  res.json(await bridge.getState());
});

// GET /api/cameras/bridge/cameras — every camera on the Wyze account, and whether it's in HomeHub
camerasRouter.get('/bridge/cameras', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const added = new Set(cameraDevices().map((d) => d.cam));
    res.json((await liveCameras()).map((c) => ({
      cam: c.id, name: c.name, model: c.modelName ?? c.model, ip: c.ip, mac: c.mac,
      streaming: c.connected, added: added.has(c.id),
    })));
  } catch (err) { fail(res, err, 'Could not list the cameras'); }
});

// GET /api/cameras/settings
// bridgeInstalled: false when .env leaves the bridge out, so the menu can hide Cameras.
camerasRouter.get('/settings', (_req: Request, res: Response) => {
  res.json({ ...snaps.getSettings(), bridgeInstalled: cameraBridgeInstalled(), limits: snaps.LIMITS });
});

// PUT /api/cameras/settings
camerasRouter.put('/settings', requireAdmin, (req: Request, res: Response) => {
  try {
    res.json({ ...snaps.saveSettings(req.body ?? {}), bridgeInstalled: cameraBridgeInstalled(), limits: snaps.LIMITS });
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
  let live: bridge.BridgeCamera[] = [];
  let bridgeError: string | null = null;
  try {
    live = await liveCameras();   // first, so cameras renamed on the bridge are relinked
  } catch (err) {
    bridgeError = (err as Error).message;
  }
  const devices = cameraDevices();
  const rooms = new Map((getDb().prepare("SELECT id, room FROM devices WHERE driver_type = 'wyze'").all() as { id: number; room: string | null }[])
    .map((r) => [r.id, r.room]));
  const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
  const cameras = await Promise.all(devices.map(async (d) => {
    const cam = live.find((c) => c.id === d.cam);
    const cached = getCachedState(d.id);
    const picture = pictureHealth(d.cam);
    return {
      deviceId: d.id,
      name: d.alias,
      room: rooms.get(d.id) ?? null,
      cam: d.cam,
      model: cam?.modelName ?? cam?.model ?? null,
      canPan: canPan(cam),
      watching: cached?.state ?? null,      // null until the first check
      online: cached?.online ?? null,
      streaming: cam?.connected ?? false,
      // Whether pictures actually arrive: 'ok', 'failing' or 'unknown' (not checked lately).
      picture: picture.state,
      lastPictureAt: iso(picture.lastOkAt),
      noPictureSince: iso(picture.failingSince),
      noPictureHint: picture.state === 'failing' && cached?.state !== false
        ? await noPictureHint(d.cam, d.mac ?? cam?.mac ?? null, cam?.ip ?? null)
        : null,
      lastMotionAt: lastMotionFor(d.id),
      latestSnapshot: snaps.latestFor(d.id),
    };
  }));
  res.json({ bridgeError, cameras });
});

// GET /api/cameras/:deviceId/live.jpg?cached=1 — a picture from the camera now
// (cached=1, for thumbnails that refresh themselves: one try, no retry)
camerasRouter.get('/:deviceId/live.jpg', async (req: Request, res: Response) => {
  const device = deviceParam(req);
  if (!device) return res.status(404).json({ error: 'Camera not found', code: 'NOT_FOUND' });
  try {
    const jpeg = await bridge.snapshot(device.cam, req.query.cached === '1' ? 1 : 2);
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
 * POST /api/cameras/:deviceId/ptz { action: left|right|up|down|stop } — turn a
 * Pan camera. A move keeps going until stop; repeat it at least every second
 * while the arrow is held, or HomeHub stops the camera.
 */
camerasRouter.post('/:deviceId/ptz', async (req: Request, res: Response) => {
  const device = deviceParam(req);
  if (!device) return res.status(404).json({ error: 'Camera not found', code: 'NOT_FOUND' });
  const action = (req.body as { action?: unknown } | undefined)?.action;
  if (typeof action !== 'string' || !PTZ_ACTIONS.includes(action as PtzAction)) {
    return res.status(400).json({ error: `action must be one of ${PTZ_ACTIONS.join(', ')}`, code: 'VALIDATION_ERROR' });
  }
  try {
    if (action !== 'stop' && !isMoving(device.cam, action as PtzAction)) {
      const cam = (await liveCameras()).find((c) => c.id === device.cam);
      if (!canPan(cam)) return res.status(409).json({ error: 'This camera doesn\'t turn', code: 'NOT_SUPPORTED' });
    }
    await ptz(device.cam, action as PtzAction);
    res.status(204).end();
  } catch (err) { fail(res, err, 'The camera didn\'t turn'); }
});

/**
 * GET /api/cameras/:deviceId/hls/<file> — live video, relayed from the bridge's
 * go2rtc so it works over HomeHub's own HTTPS address and login. index.m3u8
 * starts the stream; it points at hls/playlist.m3u8, which points at
 * hls/segment.ts (or .m4s), each naming go2rtc's session in the query.
 */
camerasRouter.get('/:deviceId/hls/*path', async (req: Request, res: Response) => {
  const device = deviceParam(req);
  if (!device) return res.status(404).json({ error: 'Camera not found', code: 'NOT_FOUND' });
  // Express 5 gives a named wildcard as its path segments.
  const raw = (req.params as Record<string, unknown>).path;
  const rest = Array.isArray(raw) ? raw.join('/') : String(raw ?? '');
  if (rest !== 'index.m3u8' && !/^hls\/[A-Za-z0-9_-]+\.(m3u8|ts|m4s|mp4)$/.test(rest)) {
    return res.status(400).json({ error: 'Bad stream path', code: 'VALIDATION_ERROR' });
  }
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const abort = new AbortController();
  req.on('close', () => abort.abort());
  try {
    const upstream = await bridge.hlsFetch(device.cam, rest, query, abort.signal);
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
