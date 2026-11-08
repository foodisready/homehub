import { Router, Request, Response } from 'express';
import { Readable } from 'stream';
import { logger } from '../logger';
import { requireAdmin } from '../middleware/auth';
import * as ipcam from '../ipcam/ipcam';
import { RelayError, hlsFetch, relayState } from '../ipcam/relay';
import type { PanAction } from '../ipcam/onvif-client';

/**
 * IP cameras on the home network (Reolink, Amcrest and others, by ONVIF or
 * RTSP). Everyone signed in can watch, take a snapshot and turn a camera;
 * adding, changing and removing cameras is admin only.
 */
export const ipCamerasRouter = Router();

function fail(res: Response, err: unknown, fallback: string): void {
  if (err instanceof ipcam.IpCamError || err instanceof RelayError) {
    res.status(err.status).json({ error: err.message, code: 'IP_CAMERA_ERROR' });
    return;
  }
  logger.warn({ reason: (err as Error).message }, fallback);
  res.status(502).json({ error: fallback, code: 'IP_CAMERA_ERROR' });
}

const idParam = (req: Request) => (/^\d+$/.test(String(req.params.id)) ? Number(req.params.id) : null);
const text = (v: unknown, max = 200) => typeof v === 'string' && v.length <= max && !/[\r\n\0]/.test(v);
const PAN_ACTIONS: PanAction[] = ['left', 'right', 'up', 'down', 'stop'];

function rtspError(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 1000) return 'Enter the camera\'s RTSP address';
  try {
    const u = new URL(v);
    if (u.protocol !== 'rtsp:' && u.protocol !== 'rtsps:') return 'The address must start with rtsp://';
    if (!ipcam.isHost(u.hostname)) return 'The address needs the camera\'s IP address or name';
    return null;
  } catch {
    return 'That isn\'t an RTSP address. It looks like rtsp://192.0.2.20:554/stream';
  }
}

// GET /api/ip-cameras — the IP cameras in HomeHub, and whether the camera relay is running
ipCamerasRouter.get('/', async (_req: Request, res: Response) => {
  const cameras = ipcam.cameraStatuses();
  res.json({ relay: cameras.length ? await relayState() : null, cameras });
});

// POST /api/ip-cameras/discover — cameras that answer an ONVIF search on the network
ipCamerasRouter.post('/discover', requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.json(await ipcam.discover());
  } catch (err) { fail(res, err, 'The search didn\'t finish'); }
});

// POST /api/ip-cameras { host, port?, username, password, name? } or { rtspUrl, username?, password?, name? }
ipCamerasRouter.post('/', requireAdmin, async (req: Request, res: Response) => {
  const { host, port, username = '', password = '', name, rtspUrl } = req.body as Record<string, unknown>;
  if (!text(username, 100) || !text(password, 200) || (name !== undefined && !text(name, 80))) {
    return res.status(400).json({ error: 'Check the username, password and name', code: 'VALIDATION_ERROR' });
  }
  if (rtspUrl !== undefined && rtspUrl !== '') {
    const problem = rtspError(rtspUrl);
    if (problem) return res.status(400).json({ error: problem, code: 'VALIDATION_ERROR' });
  } else {
    if (!ipcam.isHost(host)) return res.status(400).json({ error: 'Enter the camera\'s IP address, such as 192.0.2.20', code: 'VALIDATION_ERROR' });
    if (port !== undefined && port !== null && !(Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535)) {
      return res.status(400).json({ error: 'The port must be a number from 1 to 65535', code: 'VALIDATION_ERROR' });
    }
  }
  try {
    res.status(201).json(await ipcam.addCamera({
      host: host as string, port: (port as number | null | undefined) ?? undefined,
      username: username as string, password: password as string, name: name as string | undefined,
      rtspUrl: rtspUrl ? rtspUrl as string : undefined,
    }));
  } catch (err) { fail(res, err, 'Could not add the camera'); }
});

// PATCH /api/ip-cameras/:id { name?, username?, password?, quality?, motion? } — a blank password keeps the saved one
ipCamerasRouter.patch('/:id', requireAdmin, async (req: Request, res: Response) => {
  const id = idParam(req);
  if (id === null) return res.status(404).json({ error: 'Camera not found', code: 'NOT_FOUND' });
  const { name, username, password, quality, motion } = req.body as Record<string, unknown>;
  if ((name !== undefined && (!text(name, 80) || !(name as string).trim()))
      || (username !== undefined && !text(username, 100))
      || (password !== undefined && !text(password, 200))
      || (quality !== undefined && quality !== 'main' && quality !== 'sub')
      || (motion !== undefined && typeof motion !== 'boolean')) {
    return res.status(400).json({ error: 'Check the camera\'s settings', code: 'VALIDATION_ERROR' });
  }
  try {
    res.json(await ipcam.updateCamera(id, {
      name: name as string | undefined, username: username as string | undefined, password: password as string | undefined,
      quality: quality as ipcam.Quality | undefined, motion: motion as boolean | undefined,
    }));
  } catch (err) { fail(res, err, 'Could not change the camera'); }
});

// DELETE /api/ip-cameras/:id
ipCamerasRouter.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
  const id = idParam(req);
  if (id === null || !(await ipcam.removeCamera(id))) return res.status(404).json({ error: 'Camera not found', code: 'NOT_FOUND' });
  res.status(204).end();
});

// GET /api/ip-cameras/:id/live.jpg — a picture from the camera now
ipCamerasRouter.get('/:id/live.jpg', async (req: Request, res: Response) => {
  const id = idParam(req);
  if (id === null) return res.status(404).json({ error: 'Camera not found', code: 'NOT_FOUND' });
  try {
    const jpeg = await ipcam.picture(id);
    res.setHeader('Cache-Control', 'no-store');
    res.type('jpeg').send(jpeg);
  } catch (err) { fail(res, err, 'No picture from this camera'); }
});

// POST /api/ip-cameras/:id/snapshots — save a picture now
ipCamerasRouter.post('/:id/snapshots', async (req: Request, res: Response) => {
  const id = idParam(req);
  if (id === null) return res.status(404).json({ error: 'Camera not found', code: 'NOT_FOUND' });
  try {
    res.status(201).json(await ipcam.takeSnapshot(id));
  } catch (err) { fail(res, err, 'Could not take a snapshot'); }
});

/**
 * POST /api/ip-cameras/:id/ptz { action: left|right|up|down|stop } — turn the
 * camera. A move lasts about a second and a half; repeat it while the arrow
 * is held.
 */
ipCamerasRouter.post('/:id/ptz', async (req: Request, res: Response) => {
  const id = idParam(req);
  if (id === null) return res.status(404).json({ error: 'Camera not found', code: 'NOT_FOUND' });
  const action = (req.body as { action?: unknown } | undefined)?.action;
  if (typeof action !== 'string' || !PAN_ACTIONS.includes(action as PanAction)) {
    return res.status(400).json({ error: `action must be one of ${PAN_ACTIONS.join(', ')}`, code: 'VALIDATION_ERROR' });
  }
  try {
    await ipcam.pan(id, action as PanAction);
    res.status(204).end();
  } catch (err) { fail(res, err, 'The camera didn\'t turn'); }
});

/**
 * GET /api/ip-cameras/:id/hls/<file> — live video, relayed from the camera
 * relay so it works over HomeHub's own address and login. index.m3u8 starts
 * the stream; it points at hls/playlist.m3u8 and its segments, each naming
 * the relay's session in the query.
 */
ipCamerasRouter.get('/:id/hls/*path', async (req: Request, res: Response) => {
  const id = idParam(req);
  if (id === null) return res.status(404).json({ error: 'Camera not found', code: 'NOT_FOUND' });
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
    // Only the first request names the camera; the rest name the relay's session.
    const name = rest === 'index.m3u8' ? await ipcam.liveStream(id) : '';
    const upstream = await hlsFetch(name, rest, query, abort.signal);
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
