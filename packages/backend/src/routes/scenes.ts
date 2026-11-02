import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { getDriver } from '../drivers/registry';
import { emitDeviceState } from '../socket';
import { getCachedState, noteState } from '../kasa/device.cache';
import { logger } from '../logger';
import { withActivity } from '../activity/activity';

export const scenesRouter = Router();

interface SceneRow     { id: number; name: string; icon: string | null; created_at: string }
interface ActionRow    { id: number; scene_id: number; device_id: number; state: number }
interface DeviceRow    { id: number; alias: string; ip: string; driver_type: string; driver_config: string | null }

function withActions(scene: SceneRow) {
  const db      = getDb();
  const actions = db.prepare(`
    SELECT sa.id, sa.scene_id, sa.device_id, sa.state, d.alias
    FROM scene_actions sa JOIN devices d ON d.id = sa.device_id
    WHERE sa.scene_id = ?
  `).all(scene.id) as (ActionRow & { alias: string })[];
  return { ...scene, actions: actions.map((a) => ({ id: a.id, deviceId: a.device_id, alias: a.alias, state: a.state === 1 })) };
}

// GET /api/scenes
scenesRouter.get('/', (_req, res) => {
  const scenes = getDb().prepare('SELECT * FROM scenes ORDER BY name').all() as SceneRow[];
  res.json(scenes.map(withActions));
});

// POST /api/scenes
scenesRouter.post('/', (req: Request, res: Response) => {
  const { name, icon, actions } = req.body as {
    name: string;
    icon?: string;
    actions: { deviceId: number; state: boolean }[];
  };
  if (!name?.trim() || !actions?.length) {
    return res.status(400).json({ error: 'name and actions are required', code: 'VALIDATION_ERROR' });
  }

  const db = getDb();
  try {
    const result = db.prepare('INSERT INTO scenes (name, icon) VALUES (?, ?)').run(name.trim(), icon ?? null);
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

// DELETE /api/scenes/:id
scenesRouter.delete('/:id', (req: Request, res: Response) => {
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
