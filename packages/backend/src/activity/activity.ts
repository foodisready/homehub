import { AsyncLocalStorage } from 'async_hooks';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db';
import { logger } from '../logger';

/**
 * Activity: a record of every device change and what caused it, kept for a
 * set number of days.
 *
 * The cause travels with the work that makes the change: each request or
 * background job runs inside `withActivity`, and `recordPower` reads it.
 * HomeHub records its own switches as it makes them; a change found by the
 * regular poll that HomeHub didn't make is recorded as "outside".
 */

export type ActivitySource =
  | 'app'        // someone in the HomeHub app (dashboard, Settings, Cameras page)
  | 'scene' | 'schedule' | 'timer' | 'motion'
  | 'chat' | 'voice' | 'assistant'
  | 'shutoff'    // automatic water shutoff
  | 'outside'    // a wall switch, the device's own app, or anything else
  | 'homehub';   // HomeHub itself, with no more specific cause

export interface ActivityContext {
  source: ActivitySource;
  /** e.g. the scene, schedule or motion rule name */
  detail?: string | null;
  /** What started a scene: "chat", "voice" or "app". */
  via?: ActivitySource | null;
  userId?: number | null;
  userName?: string | null;
}

const als = new AsyncLocalStorage<ActivityContext>();

/**
 * Runs `fn` with this cause. Nesting keeps the person and records the outer
 * cause as `via`, so a scene run from Chat reads "scene Goodnight, from Chat".
 */
export function withActivity<T>(ctx: ActivityContext, fn: () => T): T {
  const outer = als.getStore();
  const merged: ActivityContext = {
    ...ctx,
    userId: ctx.userId ?? outer?.userId ?? null,
    userName: ctx.userName ?? outer?.userName ?? null,
    via: ctx.via ?? (outer && outer.source !== ctx.source ? outer.source : null),
  };
  return als.run(merged, fn);
}

export function currentActivity(): ActivityContext {
  return als.getStore() ?? { source: 'homehub' };
}

/** Express middleware: requests from the app carry the signed-in person. */
export function activityMiddleware(source: ActivitySource | ((req: Request) => ActivitySource)) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    withActivity({
      source: typeof source === 'function' ? source(req) : source,
      userId: user?.sub ?? null,
      userName: user?.name ?? null,
    }, next);
  };
}

// ── Recording ─────────────────────────────────────────────────────

interface LastRow { state: number }

function insert(deviceId: number, kind: 'power' | 'online', state: boolean, ctx: ActivityContext): void {
  const db = getDb();
  const device = db.prepare('SELECT alias FROM devices WHERE id = ?').get(deviceId) as { alias: string } | undefined;
  if (!device) return;
  // Repeating the current state isn't a change.
  const last = db.prepare('SELECT state FROM device_events WHERE device_id = ? AND kind = ? ORDER BY id DESC LIMIT 1')
    .get(deviceId, kind) as LastRow | undefined;
  if (last && last.state === (state ? 1 : 0)) return;
  db.prepare(`
    INSERT INTO device_events (device_id, device_alias, kind, state, source, detail, via, user_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(deviceId, device.alias, kind, state ? 1 : 0, ctx.source, ctx.detail ?? null, ctx.via ?? null, ctx.userName ?? null);
}

/** Records a device turning on or off. Never throws: the switch itself mustn't fail over a log. */
export function recordPower(deviceId: number, state: boolean, ctx: ActivityContext = currentActivity()): void {
  try {
    insert(deviceId, 'power', state, ctx);
  } catch (err) {
    logger.warn({ err, deviceId }, 'Could not record activity');
  }
}

export function recordOnline(deviceId: number, online: boolean): void {
  try {
    insert(deviceId, 'online', online, { source: 'homehub' });
  } catch (err) {
    logger.warn({ err, deviceId }, 'Could not record activity');
  }
}

/** The last recorded power state, or null if none. */
export function lastPowerState(deviceId: number): boolean | null {
  const row = getDb().prepare("SELECT state FROM device_events WHERE device_id = ? AND kind = 'power' ORDER BY id DESC LIMIT 1")
    .get(deviceId) as LastRow | undefined;
  return row ? row.state === 1 : null;
}

// ── Reading ───────────────────────────────────────────────────────

export interface ActivityEvent {
  id: number;
  deviceId: number | null;
  deviceName: string;
  driverType: string | null;
  room: string | null;
  kind: 'power' | 'online';
  state: boolean;
  source: ActivitySource;
  detail: string | null;
  via: ActivitySource | null;
  userName: string | null;
  at: string;
  /** For a power-off: how long it had been on, in seconds. */
  onForSeconds: number | null;
}

interface EventRow {
  id: number; device_id: number | null; device_alias: string; driver_type: string | null; room: string | null; current_alias: string | null;
  kind: 'power' | 'online'; state: number; source: ActivitySource; detail: string | null; via: ActivitySource | null;
  user_name: string | null; at: string; prev_state: number | null; prev_at: string | null;
}

const toEvent = (r: EventRow): ActivityEvent => ({
  id: r.id,
  deviceId: r.device_id,
  deviceName: r.current_alias ?? r.device_alias,
  driverType: r.driver_type,
  room: r.room,
  kind: r.kind,
  state: r.state === 1,
  source: r.source,
  detail: r.detail,
  via: r.via,
  userName: r.user_name,
  at: r.at,
  onForSeconds: r.kind === 'power' && r.state === 0 && r.prev_state === 1 && r.prev_at
    ? Math.max(0, Math.round((Date.parse(r.at) - Date.parse(r.prev_at)) / 1000))
    : null,
});

export interface ActivityQuery {
  deviceId?: number;
  room?: string;
  source?: ActivitySource;
  kind?: 'power' | 'online';
  before?: number;
  limit?: number;
}

/** Newest first. Durations are worked out from each device's previous change. */
export function listActivity(q: ActivityQuery = {}): ActivityEvent[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.deviceId !== undefined) { where.push('device_id = ?'); args.push(q.deviceId); }
  if (q.room !== undefined) { where.push(q.room === '' ? 'room IS NULL' : 'room = ?'); if (q.room !== '') args.push(q.room); }
  if (q.source !== undefined) { where.push('source = ?'); args.push(q.source); }
  if (q.kind !== undefined) { where.push('kind = ?'); args.push(q.kind); }
  if (q.before !== undefined) { where.push('id < ?'); args.push(q.before); }
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const rows = getDb().prepare(`
    SELECT * FROM (
      SELECT e.*, d.driver_type, d.room, d.alias AS current_alias,
             LAG(e.state) OVER w AS prev_state, LAG(e.at) OVER w AS prev_at
      FROM device_events e LEFT JOIN devices d ON d.id = e.device_id
      WINDOW w AS (PARTITION BY e.device_id, e.kind ORDER BY e.id)
    )
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY id DESC LIMIT ?
  `).all(...args, limit) as EventRow[];
  return rows.map(toEvent);
}

export interface LastChange { state: boolean; source: ActivitySource; detail: string | null; via: ActivitySource | null; userName: string | null; at: string }

/** Each device's latest on/off change, for the dashboard. */
export function lastChanges(): Map<number, LastChange> {
  const rows = getDb().prepare(`
    SELECT device_id, state, source, detail, via, user_name, at FROM device_events
    WHERE id IN (SELECT MAX(id) FROM device_events WHERE kind = 'power' AND device_id IS NOT NULL GROUP BY device_id)
  `).all() as { device_id: number; state: number; source: ActivitySource; detail: string | null; via: ActivitySource | null; user_name: string | null; at: string }[];
  return new Map(rows.map((r) => [r.device_id, { state: r.state === 1, source: r.source, detail: r.detail, via: r.via, userName: r.user_name, at: r.at }]));
}

// ── Keeping ───────────────────────────────────────────────────────

export const KEEP_DAYS = { default: 90, min: 7, max: 730 } as const;

export function keepDays(): number {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'activity_keep_days'").get() as { value: string } | undefined;
  const n = Number(row?.value);
  return Number.isInteger(n) && n >= KEEP_DAYS.min && n <= KEEP_DAYS.max ? n : KEEP_DAYS.default;
}

export function setKeepDays(days: unknown): number {
  if (!Number.isInteger(days) || (days as number) < KEEP_DAYS.min || (days as number) > KEEP_DAYS.max) {
    throw new Error(`keepDays must be a whole number from ${KEEP_DAYS.min} to ${KEEP_DAYS.max}`);
  }
  getDb().prepare("INSERT INTO settings (key, value) VALUES ('activity_keep_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(days));
  return days as number;
}

export function pruneActivity(now = Date.now()): number {
  const cutoff = new Date(now - keepDays() * 86_400_000).toISOString();
  const { changes } = getDb().prepare('DELETE FROM device_events WHERE at < ?').run(cutoff);
  if (changes) logger.info({ deleted: changes }, 'Pruned old activity');
  return changes;
}

export function startActivityPruning(): void {
  try { pruneActivity(); } catch (err) { logger.error({ err }, 'Activity prune failed'); }
  setInterval(() => {
    try { pruneActivity(); } catch (err) { logger.error({ err }, 'Activity prune failed'); }
  }, 24 * 60 * 60 * 1000);
}
