import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { TvConnection, TvError, searchTvs } from '../lgtv/protocol';
import { closeLink, macsOf, modelOf, press, remoteOf, type RemoteAction } from '../lgtv/link';
import { tvLoginOf } from '../drivers/LgTvDriver';
import { pollDeviceNow } from '../kasa/device.cache';
import { requireAdmin } from '../middleware/auth';
import { logger } from '../logger';

export const lgtvRouter = Router();

/** How long pairing waits for OK on the TV's remote. */
export const PAIR_WAIT_MS = 60_000;
/** A message on the TV's screen: a line or two. */
export const MAX_MESSAGE = 200;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

interface TvRow { id: number; alias: string; ip: string; driver_config: string | null; mac: string | null }

/**
 * POST /api/lgtv/pair { ip, alias?, room? } — adds the TV at that address.
 *
 * The TV, which must be on, asks on its screen whether to let HomeHub in; this waits for someone to
 * press OK on the remote. The key the TV gives back is saved with the device and never sent to the
 * browser, with the TV's own addresses for waking it. A TV that's already added gets its new address
 * and key.
 */
lgtvRouter.post('/pair', requireAdmin, async (req: Request, res: Response) => {
  const { ip, alias, room } = req.body as { ip?: unknown; alias?: unknown; room?: unknown };
  if (typeof ip !== 'string' || !IPV4.test(ip.trim()) || ip.trim().split('.').some((n) => Number(n) > 255)) {
    return res.status(400).json({ error: 'ip must be an IPv4 address', code: 'VALIDATION_ERROR' });
  }
  const address = ip.trim();
  const db = getDb();
  const holder = db.prepare("SELECT alias FROM devices WHERE ip = ? AND driver_type != 'lgtv'").get(address) as { alias: string } | undefined;
  if (holder) {
    return res.status(409).json({ error: `${holder.alias} is saved at ${address}. Change its address or remove it, then pair the TV.`, code: 'CONFLICT' });
  }

  let opened: { connection: TvConnection; key: string };
  try {
    opened = await TvConnection.open(address, { key: null, pairForMs: PAIR_WAIT_MS });
  } catch (err) {
    const code = err instanceof TvError ? err.code : 'FAILED';
    const reply: Record<string, [number, string]> = {
      UNREACHABLE: [404, `No LG TV answered at ${address}. Turn the TV on, and check it’s on the same network, then try again.`],
      DENIED: [409, 'The TV turned HomeHub down. Try again, and choose OK (or Allow) on the TV.'],
      TIMEOUT: [409, 'Nobody chose OK on the TV in time. Try again, with the TV’s remote at hand.'],
    };
    const [status, error] = reply[code] ?? [502, 'The TV wouldn’t pair. Try again.'];
    logger.warn({ ip: address, code, reason: (err as Error).message }, 'LG TV did not pair');
    return res.status(status).json({ error, code: code === 'UNREACHABLE' ? 'DEVICE_NOT_FOUND' : code === 'DENIED' ? 'PAIRING_DENIED' : code === 'TIMEOUT' ? 'PAIRING_TIMEOUT' : 'DEVICE_UNREACHABLE' });
  }

  const { connection, key } = opened;
  const [macs, model, found] = await Promise.all([
    macsOf(connection),
    modelOf(connection),
    searchTvs(address, 1500).then((list) => list.find((t) => t.ip === address)).catch(() => undefined),
  ]);
  connection.close();
  closeLink(address);
  if (!macs.length) logger.warn({ ip: address }, 'LG TV paired without saying its MAC address: it can be turned off, not on');

  const mac = macs[0] ?? null;
  const existing = (mac
    ? db.prepare("SELECT id, alias FROM devices WHERE driver_type = 'lgtv' AND (mac = ? OR ip = ?) ORDER BY mac = ? DESC").get(mac, address, mac)
    : db.prepare("SELECT id, alias FROM devices WHERE driver_type = 'lgtv' AND ip = ?").get(address)) as { id: number; alias: string } | undefined;
  const config = JSON.stringify({ key, macs });
  if (existing) {
    db.prepare('UPDATE devices SET ip = ?, driver_config = ?, mac = COALESCE(?, mac) WHERE id = ?').run(address, config, mac, existing.id);
    pollDeviceNow(existing.id).catch(() => undefined);
    logger.info({ id: existing.id, ip: address }, 'LG TV paired again');
    return res.json({ id: existing.id, alias: existing.alias, updated: true, canWake: macs.length > 0 });
  }

  const name = typeof alias === 'string' && alias.trim() ? alias.trim() : found?.name ?? 'LG TV';
  const roomName = typeof room === 'string' && room.trim() ? room.trim() : null;
  try {
    const result = db.prepare(
      "INSERT INTO devices (alias, ip, model, has_emeter, driver_type, driver_config, mac, room) VALUES (?, ?, ?, 0, 'lgtv', ?, ?, ?)",
    ).run(name, address, model ?? found?.model ?? 'LG webOS TV', config, mac, roomName);
    const id = Number(result.lastInsertRowid);
    pollDeviceNow(id).catch(() => undefined);
    logger.info({ id, ip: address, model, canWake: macs.length > 0 }, 'LG TV added');
    res.status(201).json({ id, alias: name, updated: false, canWake: macs.length > 0 });
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: `Another device is already called ${name} or uses ${address}`, code: 'CONFLICT' });
    }
    throw err;
  }
});

function tvFor(req: Request): TvRow | undefined {
  return getDb().prepare("SELECT id, alias, ip, driver_config, mac FROM devices WHERE id = ? AND driver_type = 'lgtv'")
    .get(req.params.id) as TvRow | undefined;
}

const configOf = (tv: TvRow) => { try { return tv.driver_config ? JSON.parse(tv.driver_config) : undefined; } catch { return undefined; } };

function tvFailure(res: Response, tv: TvRow, err: unknown) {
  if (err instanceof TvError && err.code === 'NOT_PAIRED') {
    return res.status(409).json({ error: `${tv.alias} doesn’t know HomeHub any more. Pair it again from Discover.`, code: 'NOT_PAIRED' });
  }
  if (err instanceof TvError && err.code === 'FAILED') {
    return res.status(502).json({ error: `${tv.alias} didn’t do that: ${err.message}`, code: 'DEVICE_REFUSED' });
  }
  logger.warn({ id: tv.id, reason: (err as Error).message }, 'Could not reach LG TV');
  return res.status(503).json({ error: `Couldn’t reach ${tv.alias}. Is it on?`, code: 'DEVICE_UNREACHABLE' });
}

/** GET /api/lgtv/:id/remote — on or off, volume, what's on screen, and the inputs and apps to choose from. */
lgtvRouter.get('/:id/remote', async (req: Request, res: Response) => {
  const tv = tvFor(req);
  if (!tv) return res.status(404).json({ error: 'TV not found', code: 'DEVICE_NOT_FOUND' });
  try {
    res.json(await remoteOf(tv.ip, tvLoginOf(configOf(tv))));
  } catch (err) {
    tvFailure(res, tv, err);
  }
});

/** Reads a remote button from a request body; a message for a bad one. */
export function actionOf(body: Record<string, unknown>): RemoteAction | string {
  const { volume, step, mute, input, app, message } = body;
  if (volume !== undefined) {
    if (typeof volume !== 'number' || !Number.isInteger(volume) || volume < 0 || volume > 100) return 'volume must be a whole number from 0 to 100';
    return { kind: 'volume', level: volume };
  }
  if (step !== undefined) {
    if (step !== 'up' && step !== 'down') return 'step must be "up" or "down"';
    return { kind: 'step', up: step === 'up' };
  }
  if (mute !== undefined) {
    if (typeof mute !== 'boolean') return 'mute must be true or false';
    return { kind: 'mute', on: mute };
  }
  if (input !== undefined) {
    if (typeof input !== 'string' || !input.trim() || input.length > 100) return 'input must be one of the TV’s inputs';
    return { kind: 'input', id: input.trim() };
  }
  if (app !== undefined) {
    if (typeof app !== 'string' || !app.trim() || app.length > 200) return 'app must be one of the TV’s apps';
    return { kind: 'app', id: app.trim() };
  }
  if (message !== undefined) {
    const text = typeof message === 'string' ? message.trim().replace(/\s+/g, ' ') : '';
    if (!text) return 'Write a message to show';
    if (text.length > MAX_MESSAGE) return `A message can be up to ${MAX_MESSAGE} characters`;
    return { kind: 'message', text };
  }
  return 'Say what to do: volume, step, mute, input, app or message';
}

/**
 * POST /api/lgtv/:id/remote { volume | step | mute | input | app | message } — one button on the
 * TV's remote. Answers with the remote as it is afterwards.
 */
lgtvRouter.post('/:id/remote', async (req: Request, res: Response) => {
  const tv = tvFor(req);
  if (!tv) return res.status(404).json({ error: 'TV not found', code: 'DEVICE_NOT_FOUND' });
  const action = actionOf((req.body ?? {}) as Record<string, unknown>);
  if (typeof action === 'string') return res.status(400).json({ error: action, code: 'VALIDATION_ERROR' });
  try {
    const login = tvLoginOf(configOf(tv));
    await press(tv.ip, login, action);
    logger.info({ id: tv.id, action: action.kind, by: req.user?.sub }, 'LG TV remote');
    // A new input or app takes a moment to come up before the TV says it's showing it.
    if (action.kind === 'input' || action.kind === 'app') await new Promise((r) => setTimeout(r, 1200));
    res.json(await remoteOf(tv.ip, login));
  } catch (err) {
    if (err instanceof TvError && err.code === 'UNREACHABLE') {
      return res.status(409).json({ error: `${tv.alias} is off. Turn it on first.`, code: 'DEVICE_OFF' });
    }
    tvFailure(res, tv, err);
  }
});
