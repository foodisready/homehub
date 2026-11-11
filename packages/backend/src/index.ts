import dotenv from 'dotenv';
import path from 'path';
// Repo root .env is two levels up from packages/backend/
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

// Secrets not set in .env come from files HomeHub makes in its data volume.
// Before any other import: auth reads the JWT secrets when it loads.
import { loadSecrets } from './secrets';
const { created: createdSecrets } = loadSecrets();
if (createdSecrets.length) console.info(`[homehub] Generated ${createdSecrets.join(', ')} in the data volume`);

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
import { notifyScheduler, schedulesRouter } from './routes/schedules';
import { usersRouter } from './routes/users';
import { internalRouter } from './routes/internal';
import { nlpRouter } from './routes/nlp';
import { energyRouter } from './routes/energy';
import { pushRouter } from './routes/push';
import { scenesRouter } from './routes/scenes';
import { tuyaRouter }   from './routes/tuya';
import { kasaRouter }   from './routes/kasa';
import { merossRouter } from './routes/meross';
import { motionEventsRouter, motionRouter } from './routes/motion';
import { sensorsRouter } from './routes/sensors';
import { firmwareApiRouter, firmwarePublicRouter } from './routes/firmware';
import { notificationsAckRouter } from './routes/notifications-ack';
import { notificationSettingsRouter } from './routes/notification-settings';
import { notificationHistoryRouter } from './routes/notification-history';
import { systemRouter } from './routes/system';
import { backupSyncPublicRouter, backupsRouter } from './routes/backups';
import { startLocalName } from './discovery/local-name';
import { camerasRouter } from './routes/cameras';
import { startCameraWatch } from './cameras/watch';
import { startSnapshotPruning } from './cameras/snapshots';
import { ringRouter } from './routes/ring';
import { startRing } from './ring/ring';
import { ipCamerasRouter } from './routes/ip-cameras';
import { startIpCameras } from './ipcam/ipcam';
import { activityMiddleware, startActivityPruning } from './activity/activity';
import { activityRouter } from './routes/activity';
import { runBackup } from './db/backup';
import { startBackupEmails } from './db/backup-email';
import { startBackupSync, whenCopied } from './db/backup-sync';
import { startComputerWatch } from './system/computer-watch';
import { backupReadOnly } from './middleware/backup-read-only';
import { applyRole, isActiveServer } from './system/role';
import { checkAllSensors } from './sensors/stale-check';
import { authenticate, requireAdmin } from './middleware/auth';
import { getDb } from './db';
import { refreshDevices, startPolling } from './kasa/device.cache';
import { startPowerTimers } from './devices/power';
import { startMotionRules } from './sensors/motion';
import { seedAdminIfEmpty } from './auth/auth.service';
import { applyHomeTimezone } from './home/home-settings';
import { homeSettingsRouter } from './routes/home-settings';
import { setupRouter } from './routes/setup';
import { matterRouter } from './routes/matter';
import { startMatter, stopMatter } from './matter/service';
import { noteRunningVersion } from './system/updater';
import { initSocket } from './socket';
import { warmModels } from './nlp/nlp.service';

const app = express();
const httpServer = createServer(app);

// Socket.io must be attached before any listen() call
initSocket(httpServer);

app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:4200', credentials: true }));
// Edited JSON backups (Settings → Backups) can pass the default 100 kB.
app.use(express.json({ limit: '5mb' }));
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

// ── Public motion events — sensors can't log in, so the URL's token is the auth.
app.use('/motion', motionEventsRouter);

// ── A backup HomeHub fetching the active one's settings: the pairing code is the auth.
app.use('/sync', backupSyncPublicRouter);

// ── All routes below require a valid JWT ──────────────────────
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  authenticate(req, res, next);
});

// A backup HomeHub is read-only, apart from switching things by hand: it's copied from the active one.
app.use('/api', backupReadOnly);

// Activity records who made each change. The AI assistant server identifies itself.
app.use('/api', activityMiddleware((req) => (req.headers['x-homehub-client'] === 'mcp' ? 'assistant' : 'app')));

app.use('/api/devices',   devicesRouter);
app.use('/api/schedules', schedulesRouter);
app.use('/api/users',     usersRouter);
app.use('/api/nlp',       nlpRouter);
app.use('/api/push',      pushRouter);
app.use('/api/scenes',    scenesRouter);
app.use('/api/devices',   energyRouter);   // history sub-routes: /api/devices/:id/energy/history
app.use('/api/tuya',      tuyaRouter);
app.use('/api/kasa',      requireAdmin, kasaRouter);
app.use('/api/meross',    requireAdmin, merossRouter);
app.use('/api/motion',    requireAdmin, motionRouter);
app.use('/api/sensors',   sensorsRouter);
app.use('/api/firmware',  firmwareApiRouter);
app.use('/api/notifications/settings', notificationSettingsRouter);
app.use('/api/notifications/history',  notificationHistoryRouter);
app.use('/api/system',                 systemRouter);
app.use('/api/backups',                requireAdmin, backupsRouter);
app.use('/api/cameras',                camerasRouter);
app.use('/api/ring',                   ringRouter);
app.use('/api/ip-cameras',             ipCamerasRouter);
app.use('/api/activity',               activityRouter);
app.use('/api/home-settings',          homeSettingsRouter);
app.use('/api/setup',                  setupRouter);
app.use('/api/matter',                 requireAdmin, matterRouter);

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
  applyHomeTimezone();       // the time zone chosen in Settings, if any
  await seedAdminIfEmpty();  // admin from ADMIN_PASSWORD, or wait for setup in the browser
  startPolling();            // begin device state polling
  startPowerTimers();        // turn devices off when their timers end
  startMotionRules();        // turn lights off when a room has been empty long enough
  startCameraWatch();        // save snapshots when Wyze cameras see motion
  startRing();               // Ring doorbell presses and motion, once someone signs in to Ring
  startIpCameras();          // motion from IP cameras added on the Cameras page
  startSnapshotPruning();    // delete camera snapshots older than the keep setting
  startActivityPruning();    // delete activity older than the keep setting
  applyRole();               // a backup or dev server holds the voice and camera bridges back
  startLocalName();          // answer for homehub.local (or <name>-backup.local) on the home network
  noteRunningVersion();   // remember the version before this one, to go back to
  startMatter().catch(() => undefined);   // connect to Matter devices, if there are any

  // Daily DB backup: run once at startup, then every 24 hours
  runBackup();
  setInterval(runBackup, 24 * 60 * 60 * 1000);
  startBackupEmails();       // weekly and after-update backup emails, when turned on
  whenCopied(() => {         // as after a restore by hand
    notifyScheduler();
    refreshDevices().catch((err) => logger.warn({ err }, 'Device refresh after backup sync failed'));
  });
  startBackupSync();         // on a paired backup, copy the active HomeHub every hour
  startComputerWatch();      // how hot the computer is, and on a Pi whether it has enough power
  if (isActiveServer()) warmModels().catch(() => undefined);   // load the chat models now, not on the first message

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

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down');
  // Matter first, with a limit: a device that doesn't answer mustn't hold up the stop.
  await Promise.race([stopMatter(), new Promise((r) => setTimeout(r, 3000))]);
  httpServer.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

export { app, httpServer };
