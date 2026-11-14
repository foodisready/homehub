import { getDb } from '../db';
import { logger } from '../logger';
import { pollDeviceNow } from '../kasa/device.cache';
import type { MatterEndpoint } from './controller';
import { matterAddress } from '../drivers/MatterDriver';

/**
 * Ties Matter devices to HomeHub's device list: starts the controller when a
 * home has Matter devices, turns a device's live reports into HomeHub state
 * and activity, and adds and removes devices.
 */

// matter.js loads only when Matter is used.
const matter = () => import('./controller');

interface MatterRow { id: number; alias: string; driver_config: string | null }

const configOf = (row: MatterRow): { nodeId?: string; endpoint?: number } => {
  try { return row.driver_config ? JSON.parse(row.driver_config) : {}; } catch { return {}; }
};

function matterRows(): MatterRow[] {
  return getDb().prepare("SELECT id, alias, driver_config FROM devices WHERE driver_type = 'matter'").all() as MatterRow[];
}

let used = false;

/** Closes Matter connections cleanly on shutdown. Does nothing if Matter never started. */
export async function stopMatter(): Promise<void> {
  if (!used) return;
  await (await matter()).stopController().catch(() => undefined);
}

let wired = false;
async function wireReports(): Promise<void> {
  used = true;
  if (wired) return;
  wired = true;
  const { onMatterSwitch, onThermostatChange } = await matter();
  // A device reported a change (from HomeHub, a wall switch, or another app): read it into
  // HomeHub's state the same way a poll would, so activity records its cause.
  onMatterSwitch((nodeId, endpoint) => {
    const row = matterRows().find((r) => { const c = configOf(r); return c.nodeId === nodeId && c.endpoint === endpoint; });
    if (row) pollDeviceNow(row.id).catch(() => undefined);
  });
  // A thermostat's temperature, target, mode or running state changed: tell open pages, and
  // read its on/off (mode off or not) as for any device.
  onThermostatChange((nodeId, endpoint) => {
    void import('../thermostat/thermostat').then(({ thermostatIdFor, refresh }) => {
      const id = thermostatIdFor(nodeId, endpoint);
      if (id === null) return;
      void refresh(id);
      pollDeviceNow(id).catch(() => undefined);
    });
  });
}

/** At startup: connect to every paired device, if there are any. */
export async function startMatter(): Promise<void> {
  const nodeIds = [...new Set(matterRows().map((r) => configOf(r).nodeId).filter((n): n is string => !!n))];
  if (!nodeIds.length) return;
  await wireReports();
  const { startController, connectNode } = await matter();
  try {
    await startController();
  } catch (err) {
    logger.error({ err }, 'Matter controller failed to start');
    return;
  }
  for (const nodeId of nodeIds) {
    connectNode(nodeId)
      .then(() => { for (const r of matterRows()) if (configOf(r).nodeId === nodeId) pollDeviceNow(r.id).catch(() => undefined); })
      .catch((err) => logger.warn({ nodeId, err: String(err?.message ?? err) }, 'Matter device not reachable yet'));
  }
}

/** Pairs a device from its code and adds each switchable part as a HomeHub device. */
export async function addMatterDevice(code: string): Promise<{ id: number; alias: string }[]> {
  await wireReports();
  const endpoints = await (await matter()).pairDevice(code);
  const db = getDb();
  const taken = (name: string) => !!db.prepare('SELECT 1 FROM devices WHERE alias = ? COLLATE NOCASE').get(name);
  const created: { id: number; alias: string }[] = [];
  const insert = db.prepare(`
    INSERT INTO devices (alias, ip, model, has_emeter, driver_type, driver_config)
    VALUES (?, ?, ?, 0, 'matter', ?)
    ON CONFLICT (ip) DO NOTHING
  `);
  for (const ep of endpoints) {
    let alias = ep.name;
    for (let n = 2; taken(alias); n++) alias = `${ep.name} ${n}`;
    const config = JSON.stringify({ nodeId: ep.nodeId, endpoint: ep.endpoint, vendor: ep.vendor, product: ep.product, kind: ep.kind });
    const result = insert.run(alias, matterAddress(ep.nodeId, ep.endpoint), modelOf(ep), config);
    if (result.changes) created.push({ id: Number(result.lastInsertRowid), alias });
  }
  for (const d of created) pollDeviceNow(d.id).catch(() => undefined);
  logger.info({ devices: created.map((d) => d.alias) }, 'Matter devices added');
  return created;
}

const modelOf = (ep: MatterEndpoint) => [ep.vendor, ep.product].filter(Boolean).join(' ') || 'Matter device';

/**
 * After a Matter device is deleted from HomeHub: once none of its parts are
 * left, unpair it, so it stops expecting HomeHub. Other apps keep it.
 */
export function forgetIfUnused(nodeId: string): void {
  if (matterRows().some((r) => configOf(r).nodeId === nodeId)) return;
  matter().then((m) => m.removeNode(nodeId)).catch((err) => logger.warn({ nodeId, err: String(err?.message ?? err) }, 'Matter device could not be unpaired'));
}
