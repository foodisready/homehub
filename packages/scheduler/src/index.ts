import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
import express from 'express';
import Database from 'better-sqlite3';
import cron from 'node-cron';
import pino from 'pino';
import { SchedulerService } from './scheduler.service';

const logger = pino(
  process.env.NODE_ENV === 'production'
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true } } }
);

const DB_PATH      = process.env.DB_PATH      || path.resolve(process.cwd(), '../backend/data/db.sqlite');
const PORT         = process.env.SCHEDULER_PORT || 3002;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY || '';

// Open DB in read-write (scheduler may read; backend does all writes)
const db        = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const scheduler = new SchedulerService(db);

// ── HTTP server (health + reload) ──────────────────────────────
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'scheduler', version: '1.0.0' });
});

// Called by backend after any schedule change
app.post('/reload', (req, res) => {
  if (req.headers['x-internal-key'] !== INTERNAL_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  scheduler.load();
  logger.info('Schedules reloaded via HTTP');
  res.json({ status: 'reloaded' });
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Scheduler service started');
});

// ── Initial load ───────────────────────────────────────────────
// Wait briefly for the DB to be fully ready on first boot
setTimeout(() => scheduler.load(), 3000);

// ── Midnight solar refresh ─────────────────────────────────────
// Every day at 00:01, recompute solar event times for the new day
cron.schedule('1 0 * * *', () => {
  logger.info('Midnight tick — refreshing solar schedules');
  scheduler.refreshSolar();
});

// ── Graceful shutdown ──────────────────────────────────────────
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  scheduler.clearAll();
  process.exit(0);
});
