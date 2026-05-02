import dotenv from 'dotenv';
import path from 'path';
// Repo root .env is two levels up from packages/backend/
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

import { validateEnv } from './env';
validateEnv();   // crash early with a clear message if config is incomplete

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { logger } from './logger';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { devicesRouter } from './routes/devices';
import { schedulesRouter } from './routes/schedules';
import { usersRouter } from './routes/users';
import { internalRouter } from './routes/internal';
import { nlpRouter } from './routes/nlp';
import { energyRouter } from './routes/energy';
import { pushRouter } from './routes/push';
import { scenesRouter } from './routes/scenes';
import { tuyaRouter }   from './routes/tuya';
import { sensorsRouter } from './routes/sensors';
import { firmwareApiRouter, firmwarePublicRouter } from './routes/firmware';
import { notificationsAckRouter } from './routes/notifications-ack';
import { notificationSettingsRouter } from './routes/notification-settings';
import { notificationHistoryRouter } from './routes/notification-history';
import { runBackup } from './db/backup';
import { checkAllSensors } from './sensors/stale-check';
import { authenticate } from './middleware/auth';
import { getDb } from './db';
import { startPolling } from './kasa/device.cache';
import { seedAdminIfEmpty } from './auth/auth.service';
import { initSocket } from './socket';

const app = express();
const httpServer = createServer(app);

// Socket.io must be attached before any listen() call
initSocket(httpServer);

app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:4200', credentials: true }));
app.use(express.json());
app.use(cookieParser());

// ── Public routes ──────────────────────────────────────────────
app.use(healthRouter);
app.use('/api/auth', authRouter);

// ── Internal service-to-service routes (key auth, no JWT) ──────
app.use('/internal', internalRouter);

// ── Public ack endpoint — token IS the auth, single-use, must precede JWT
app.use('/api/notifications/ack', notificationsAckRouter);

// ── Public firmware fetch — devices on the LAN pull .bin via the URL
//    HomeHub posted to their /ota endpoint. No JWT (devices have none);
//    the filename is the only secret, matching the project's existing
//    LAN-trust posture for sensor traffic.
app.use('/firmware', firmwarePublicRouter);

// ── All routes below require a valid JWT ──────────────────────
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  authenticate(req, res, next);
});

app.use('/api/devices',   devicesRouter);
app.use('/api/schedules', schedulesRouter);
app.use('/api/users',     usersRouter);
app.use('/api/nlp',       nlpRouter);
app.use('/api/push',      pushRouter);
app.use('/api/scenes',    scenesRouter);
app.use('/api/devices',   energyRouter);   // history sub-routes: /api/devices/:id/energy/history
app.use('/api/tuya',      tuyaRouter);
app.use('/api/sensors',   sensorsRouter);
app.use('/api/firmware',  firmwareApiRouter);
app.use('/api/notifications/settings', notificationSettingsRouter);
app.use('/api/notifications/history',  notificationHistoryRouter);

// ── Global error handler ───────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error(err, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
});

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, async () => {
  logger.info({ port: PORT }, 'HomeHub backend started');
  getDb();                   // init DB + run migrations
  await seedAdminIfEmpty();  // create default admin if DB is empty
  startPolling();            // begin device state polling

  // Daily DB backup: run once at startup, then every 24 hours
  runBackup();
  setInterval(runBackup, 24 * 60 * 60 * 1000);

  // Hourly prune of flow_readings older than 7 days. flow_events are kept indefinitely.
  pruneFlowReadings();
  setInterval(pruneFlowReadings, 60 * 60 * 1000);

  // Stale-sensor check: every 60s, alert if a sensor has stopped reporting.
  setInterval(() => {
    try { checkAllSensors(); } catch (err) {
      logger.error(err, 'stale-check failed');
    }
  }, 60 * 1000);
});

function pruneFlowReadings(): void {
  try {
    const r = getDb()
      .prepare("DELETE FROM flow_readings WHERE recorded_at < datetime('now', '-7 days')")
      .run();
    if (r.changes > 0) {
      logger.info({ deleted: r.changes }, 'Pruned old flow_readings');
    }
  } catch (err) {
    logger.error(err, 'flow_readings prune failed');
  }
}

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  httpServer.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

export { app, httpServer };
