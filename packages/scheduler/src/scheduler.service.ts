import cron from 'node-cron';
import Database from 'better-sqlite3';
import pino from 'pino';
import { getSolarEventTime, type SolarEvent } from './solar';

const logger = pino(
  process.env.NODE_ENV === 'production'
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true } } }
);

interface ScheduleRow {
  id: number;
  device_id: number;
  label: string;
  trigger_type: 'cron' | 'solar';
  cron_expression: string | null;
  solar_event: SolarEvent | null;
  solar_offset_minutes: number;
  state: number;
  enabled: number;
}

export class SchedulerService {
  private cronJobs    = new Map<number, cron.ScheduledTask>();
  private solarTimers = new Map<number, NodeJS.Timeout>();

  private readonly lat: number;
  private readonly lon: number;
  private readonly backendUrl: string;
  private readonly internalKey: string;
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db          = db;
    this.lat         = parseFloat(process.env.LATITUDE  || '37.7749');
    this.lon         = parseFloat(process.env.LONGITUDE || '-122.4194');
    this.backendUrl  = process.env.BACKEND_URL   || 'http://backend:3000';
    this.internalKey = process.env.INTERNAL_API_KEY || '';
  }

  /** Load all enabled schedules from DB and register their jobs. */
  load(): void {
    this.clearAll();

    const rows = this.db.prepare(
      "SELECT * FROM schedules WHERE enabled = 1"
    ).all() as ScheduleRow[];

    let cronCount  = 0;
    let solarCount = 0;

    for (const row of rows) {
      if (row.trigger_type === 'cron') {
        this.registerCron(row);
        cronCount++;
      } else {
        this.registerSolar(row);
        solarCount++;
      }
    }

    logger.info({ cronCount, solarCount }, 'Schedules loaded');
  }

  /** Clear all active jobs and timers. */
  clearAll(): void {
    for (const task of this.cronJobs.values())    task.stop();
    for (const timer of this.solarTimers.values()) clearTimeout(timer);
    this.cronJobs.clear();
    this.solarTimers.clear();
  }

  // ── Cron ──────────────────────────────────────────────────────

  private registerCron(row: ScheduleRow): void {
    if (!row.cron_expression || !cron.validate(row.cron_expression)) {
      logger.warn({ id: row.id, expr: row.cron_expression }, 'Invalid cron expression, skipping');
      return;
    }

    const task = cron.schedule(row.cron_expression, () => {
      this.execute(row).catch((err) =>
        logger.error({ err: err.message, scheduleId: row.id }, 'Cron execution failed')
      );
    });

    this.cronJobs.set(row.id, task);
    logger.debug({ id: row.id, label: row.label, expr: row.cron_expression }, 'Cron scheduled');
  }

  // ── Solar ─────────────────────────────────────────────────────

  private registerSolar(row: ScheduleRow): void {
    if (!row.solar_event) return;

    const now    = new Date();
    const target = getSolarEventTime(now, row.solar_event, row.solar_offset_minutes, this.lat, this.lon);

    if (!target) {
      logger.warn({ id: row.id, event: row.solar_event }, 'Solar event time unavailable');
      return;
    }

    const msUntil = target.getTime() - now.getTime();
    if (msUntil <= 0) {
      logger.debug({ id: row.id, label: row.label }, 'Solar event already passed today, skipping');
      return;
    }

    const timer = setTimeout(() => {
      this.execute(row).catch((err) =>
        logger.error({ err: err.message, scheduleId: row.id }, 'Solar execution failed')
      );
    }, msUntil);

    this.solarTimers.set(row.id, timer);
    logger.debug({ id: row.id, label: row.label, target: target.toISOString(), msUntil }, 'Solar scheduled');
  }

  // ── Daily solar refresh ───────────────────────────────────────

  /** Re-schedule all solar jobs for the new day. Called at midnight. */
  refreshSolar(): void {
    // Clear existing solar timers
    for (const [id, timer] of this.solarTimers) {
      clearTimeout(timer);
      this.solarTimers.delete(id);
    }

    const rows = this.db.prepare(
      "SELECT * FROM schedules WHERE enabled = 1 AND trigger_type = 'solar'"
    ).all() as ScheduleRow[];

    for (const row of rows) this.registerSolar(row);
    logger.info({ count: rows.length }, 'Solar schedules refreshed for new day');
  }

  // ── Execution ─────────────────────────────────────────────────

  private async execute(row: ScheduleRow): Promise<void> {
    // Re-read from DB to get latest enabled state (in case it changed)
    const latest = this.db.prepare('SELECT enabled FROM schedules WHERE id = ?')
      .get(row.id) as { enabled: number } | undefined;

    if (!latest || latest.enabled === 0) {
      logger.debug({ id: row.id }, 'Schedule disabled at execution time, skipping');
      return;
    }

    const url = `${this.backendUrl}/internal/devices/${row.device_id}/execute`;
    const res = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'x-internal-key': this.internalKey,
      },
      body: JSON.stringify({ state: row.state === 1 }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Backend returned ${res.status}: ${body}`);
    }

    logger.info({ id: row.id, label: row.label, deviceId: row.device_id, state: row.state === 1 }, 'Schedule fired');
  }
}
