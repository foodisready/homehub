import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { getDriver } from '../drivers/registry';
import { emitDeviceState } from '../socket';
import { getCachedState, noteState } from '../kasa/device.cache';
import { logger } from '../logger';
import { withActivity } from '../activity/activity';
import { requireAdmin } from '../middleware/auth';

export const scenesRouter = Router();

interface SceneRow     { id: number; name: string; icon: string | null; created_at: string; voice_may_pause?: number; nicknames?: string | null }
interface ActionRow    { id: number; scene_id: number; device_id: number; state: number }
interface DeviceRow    { id: number; alias: string; ip: string; driver_type: string; driver_config: string | null }

function withActions(scene: SceneRow) {
  const db      = getDb();
  const actions = db.prepare(`
    SELECT sa.id, sa.scene_id, sa.device_id, sa.state, d.alias, d.driver_type
    FROM scene_actions sa JOIN devices d ON d.id = sa.device_id
    WHERE sa.scene_id = ?
  `).all(scene.id) as (ActionRow & { alias: string; driver_type: string })[];
  const { voice_may_pause, ...rest } = scene;
  return {
    ...rest,
    // Whether voice and Chat may pause this scene's cameras. Only an admin can change it.
    voiceMayPause: voice_may_pause === 1,
    actions: actions.map((a) => ({ id: a.id, deviceId: a.device_id, alias: a.alias, state: a.state === 1, camera: a.driver_type === 'wyze' })),
  };
}

// GET /api/scenes
scenesRouter.get('/', (_req, res) => {
  const scenes = getDb().prepare('SELECT * FROM scenes ORDER BY name').all() as SceneRow[];
  res.json(scenes.map(withActions));
});

// POST /api/scenes
scenesRouter.post('/', requireAdmin, (req: Request, res: Response) => {
  const { name, icon, actions, voiceMayPause } = req.body as {
    name: string;
    icon?: string;
    actions: { deviceId: number; state: boolean }[];
    voiceMayPause?: unknown;
  };
  if (!name?.trim() || !actions?.length) {
    return res.status(400).json({ error: 'name and actions are required', code: 'VALIDATION_ERROR' });
  }
  if (voiceMayPause !== undefined && typeof voiceMayPause !== 'boolean') {
    return res.status(400).json({ error: '`voiceMayPause` must be true or false', code: 'VALIDATION_ERROR' });
  }

  const db = getDb();
  try {
    const result = db.prepare('INSERT INTO scenes (name, icon, voice_may_pause) VALUES (?, ?, ?)').run(name.trim(), icon ?? null, voiceMayPause ? 1 : 0);
    const sceneId = result.lastInsertRowid;
    const insert  = db.prepare('INSERT INTO scene_actions (scene_id, device_id, state) VALUES (?, ?, ?)');
    for (const a of actions) insert.run(sceneId, a.deviceId, a.state ? 1 : 0);
    const created = db.prepare('SELECT * FROM scenes WHERE id = ?').get(sceneId) as SceneRow;
    res.status(201).json(withActions(created));
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Scene name already exists', code: 'CONFLICT' });
    }
    throw err;
  }
});

// PATCH /api/scenes/:id  { name?, icon?, actions?, voiceMayPause? }
// Edits a scene in place: its id, and the nicknames HomeHub has learned for it, stay.
scenesRouter.patch('/:id', requireAdmin, (req: Request, res: Response) => {
  const { name, icon, actions, voiceMayPause } = req.body as {
    name?: unknown; icon?: unknown; actions?: unknown; voiceMayPause?: unknown;
  };
  if (name === undefined && icon === undefined && actions === undefined && voiceMayPause === undefined) {
    return res.status(400).json({ error: 'Nothing to change', code: 'VALIDATION_ERROR' });
  }
  if (voiceMayPause !== undefined && typeof voiceMayPause !== 'boolean') {
    return res.status(400).json({ error: '`voiceMayPause` must be true or false', code: 'VALIDATION_ERROR' });
  }
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ error: 'A scene needs a name', code: 'VALIDATION_ERROR' });
  }
  if (icon !== undefined && icon !== null && (typeof icon !== 'string' || icon.length > 16)) {
    return res.status(400).json({ error: '`icon` must be a short text', code: 'VALIDATION_ERROR' });
  }
  const db = getDb();
  let list: { deviceId: number; state: boolean }[] | undefined;
  if (actions !== undefined) {
    const ok = Array.isArray(actions) && actions.length > 0 && actions.every((a) =>
      a && Number.isInteger(a.deviceId) && typeof a.state === 'boolean');
    if (!ok) return res.status(400).json({ error: 'A scene needs at least one device', code: 'VALIDATION_ERROR' });
    list = [...new Map((actions as { deviceId: number; state: boolean }[]).map((a) => [a.deviceId, a])).values()];
    const known = db.prepare('SELECT id FROM devices WHERE id = ?');
    if (list.some((a) => !known.get(a.deviceId))) {
      return res.status(400).json({ error: 'A device in this scene no longer exists', code: 'VALIDATION_ERROR' });
    }
  }

  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(req.params.id) as SceneRow | undefined;
  if (!scene) return res.status(404).json({ error: 'Scene not found', code: 'NOT_FOUND' });

  try {
    db.transaction(() => {
      if (name !== undefined) db.prepare('UPDATE scenes SET name = ? WHERE id = ?').run((name as string).trim(), scene.id);
      if (icon !== undefined) db.prepare('UPDATE scenes SET icon = ? WHERE id = ?').run(icon, scene.id);
      if (list) {
        db.prepare('DELETE FROM scene_actions WHERE scene_id = ?').run(scene.id);
        const insert = db.prepare('INSERT INTO scene_actions (scene_id, device_id, state) VALUES (?, ?, ?)');
        for (const a of list) insert.run(scene.id, a.deviceId, a.state ? 1 : 0);
      }
      if (voiceMayPause !== undefined) db.prepare('UPDATE scenes SET voice_may_pause = ? WHERE id = ?').run(voiceMayPause ? 1 : 0, scene.id);
      // A scene that no longer pauses a camera has nothing for voice to pause. Clearing it means
      // adding a camera pause later asks again, instead of quietly allowing voice to pause it.
      const pauses = db.prepare(`SELECT 1 FROM scene_actions sa JOIN devices d ON d.id = sa.device_id
        WHERE sa.scene_id = ? AND sa.state = 0 AND d.driver_type = 'wyze'`).get(scene.id);
      if (!pauses) db.prepare('UPDATE scenes SET voice_may_pause = 0 WHERE id = ?').run(scene.id);
    })();
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Another scene already has that name', code: 'CONFLICT' });
    }
    throw err;
  }

  const updated = db.prepare('SELECT * FROM scenes WHERE id = ?').get(scene.id) as SceneRow;
  if (voiceMayPause !== undefined && (updated.voice_may_pause === 1) !== (scene.voice_may_pause === 1)) {
    logger.info({ sceneId: scene.id, voiceMayPause: updated.voice_may_pause === 1, by: req.user?.name }, 'Scene voice pause changed');
  }
  if (name !== undefined || icon !== undefined || list) {
    logger.info({ sceneId: scene.id, name: updated.name, devices: list?.length, by: req.user?.name }, 'Scene edited');
  }
  res.json(withActions(updated));
});

// DELETE /api/scenes/:id
scenesRouter.delete('/:id', requireAdmin, (req: Request, res: Response) => {
  const result = getDb().prepare('DELETE FROM scenes WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Scene not found', code: 'NOT_FOUND' });
  res.status(204).send();
});

// POST /api/scenes/:id/run
scenesRouter.post('/:id/run', async (req: Request, res: Response) => {
  const db     = getDb();
  const scene  = db.prepare('SELECT * FROM scenes WHERE id = ?').get(req.params.id) as SceneRow | undefined;
  if (!scene) return res.status(404).json({ error: 'Scene not found', code: 'NOT_FOUND' });

  const actions = db.prepare(`
    SELECT sa.state, d.id, d.ip, d.alias, d.driver_type, d.driver_config
    FROM scene_actions sa JOIN devices d ON d.id = sa.device_id
    WHERE sa.scene_id = ?
  `).all(scene.id) as (ActionRow & DeviceRow & { alias: string })[];

  const results = await Promise.allSettled(
    actions.map(async (a) => {
      const config = a.driver_config ? JSON.parse(a.driver_config) : undefined;
      await getDriver(a.driver_type ?? 'kasa').setPower(a.ip, a.state === 1, config);
      withActivity({ source: 'scene', detail: scene.name }, () => noteState(a.id, a.state === 1));
      emitDeviceState(a.id, a.alias, a.state === 1, getCachedState(a.id)?.wattage ?? null);
      return { alias: a.alias, state: a.state === 1 };
    })
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<any>).value);
  const failed    = results.filter((r) => r.status === 'rejected').length;

  logger.info({ scene: scene.name, succeeded: succeeded.length, failed }, 'Scene run');
  res.json({ scene: scene.name, actions: succeeded, failed });
});
