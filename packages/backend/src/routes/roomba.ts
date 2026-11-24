import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { discover, fetchPassword } from '../roomba/protocol';
import { closeLink, readStatus, sendCommand } from '../roomba/link';
import { deviceForRobot } from '../roomba/service';
import { loginOf } from '../drivers/RoombaDriver';
import { pollDeviceNow } from '../kasa/device.cache';
import { requireAdmin } from '../middleware/auth';
import { logger } from '../logger';

export const roombaRouter = Router();

/** How long pairing listens for the robot's Home button. */
export const PAIR_WAIT_MS = 40_000;
const RETRY_MS = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * POST /api/roomba/pair { ip, alias?, room? } — adds the robot at that address.
 *
 * Someone holds the robot's Home button on the dock until it chimes, while
 * this asks it for its password every couple of seconds. The password is
 * checked by connecting, then saved with the device and never sent to the
 * browser. A robot that's already added gets its new address and password.
 */
roombaRouter.post('/pair', requireAdmin, async (req: Request, res: Response) => {
  const { ip, alias, room } = req.body as { ip?: unknown; alias?: unknown; room?: unknown };
  if (typeof ip !== 'string' || !IPV4.test(ip.trim()) || ip.trim().split('.').some((n) => Number(n) > 255)) {
    return res.status(400).json({ error: 'ip must be an IPv4 address', code: 'VALIDATION_ERROR' });
  }
  const address = ip.trim();
  const [robot] = await discover([address], 2500);
  if (!robot) return res.status(404).json({ error: `No Roomba answered at ${address}. Is it on and connected to Wi-Fi?`, code: 'DEVICE_NOT_FOUND' });

  let password: string | null = null;
  const until = Date.now() + PAIR_WAIT_MS;
  while (!password && Date.now() < until) {
    try {
      password = await fetchPassword(address);
    } catch (err) {
      logger.debug({ ip: address, reason: (err as Error).message }, 'Roomba password request failed');
    }
    if (!password) await sleep(RETRY_MS);
  }
  if (!password) {
    return res.status(409).json({
      error: "The robot didn't pair. With it on its dock, hold its Home button until it plays a tone, then try again.",
      code: 'NOT_IN_PAIRING_MODE',
    });
  }

  const login = { blid: robot.blid, password };
  closeLink(robot.blid);
  try {
    await readStatus(address, login);
  } catch (err) {
    closeLink(robot.blid);
    logger.warn({ ip: address, reason: (err as Error).message }, 'Roomba paired but would not connect');
    return res.status(502).json({ error: 'The robot paired, but HomeHub couldn’t connect to it. Try again in a minute.', code: 'DEVICE_UNREACHABLE' });
  }

  const db = getDb();
  const config = JSON.stringify(login);
  const existing = deviceForRobot(robot.blid);
  if (existing) {
    db.prepare('UPDATE devices SET ip = ?, driver_config = ?, mac = COALESCE(?, mac) WHERE id = ?')
      .run(address, config, robot.mac, existing.id);
    pollDeviceNow(existing.id).catch(() => undefined);
    logger.info({ id: existing.id, ip: address }, 'Roomba paired again');
    return res.json({ id: existing.id, alias: existing.alias, updated: true });
  }

  const name = typeof alias === 'string' && alias.trim() ? alias.trim() : robot.name;
  const roomName = typeof room === 'string' && room.trim() ? room.trim() : null;
  // "Start the vacuum" works by voice and Chat from the start, unless another device already goes by that.
  const taken = (db.prepare('SELECT alias, nicknames FROM devices').all() as { alias: string; nicknames: string | null }[])
    .some((d) => d.alias.toLowerCase() === 'vacuum' || (d.nicknames ?? '').toLowerCase().includes('"vacuum"'));
  try {
    const result = db.prepare(
      "INSERT INTO devices (alias, ip, model, has_emeter, driver_type, driver_config, mac, room, nicknames) VALUES (?, ?, ?, 0, 'roomba', ?, ?, ?, ?)",
    ).run(name, address, robot.sku || 'Roomba', config, robot.mac, roomName, taken ? null : JSON.stringify(['vacuum']));
    const id = Number(result.lastInsertRowid);
    pollDeviceNow(id).catch(() => undefined);
    logger.info({ id, ip: address, model: robot.sku }, 'Roomba added');
    res.status(201).json({ id, alias: name, updated: false });
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: `Another device is already called ${name} or uses ${address}`, code: 'CONFLICT' });
    }
    throw err;
  }
});

/**
 * POST /api/roomba/:id/pause — stops the robot where it is, to carry on later.
 * Starting and sending it home are the device's on and off.
 */
roombaRouter.post('/:id/pause', async (req: Request, res: Response) => {
  const device = getDb().prepare("SELECT id, alias, ip, driver_config FROM devices WHERE id = ? AND driver_type = 'roomba'")
    .get(req.params.id) as { id: number; alias: string; ip: string; driver_config: string | null } | undefined;
  if (!device) return res.status(404).json({ error: 'Robot vacuum not found', code: 'DEVICE_NOT_FOUND' });
  try {
    const login = loginOf(device.driver_config ? JSON.parse(device.driver_config) : undefined);
    const status = await readStatus(device.ip, login);
    if (status.activity !== 'cleaning') {
      return res.status(409).json({ error: `${device.alias} isn’t cleaning`, code: 'NOT_CLEANING' });
    }
    await sendCommand(device.ip, login, 'pause');
    res.json({ alias: device.alias, paused: true });
  } catch (err) {
    logger.warn({ id: device.id, reason: (err as Error).message }, 'Could not pause Roomba');
    res.status(503).json({ error: `Couldn’t reach ${device.alias}`, code: 'DEVICE_UNREACHABLE' });
  }
});
