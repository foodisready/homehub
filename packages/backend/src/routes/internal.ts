import { Router, Request, Response } from 'express';
import { reply } from '../nlp/replies';
import { requireInternalKey } from '../middleware/internal';
import { getDb } from '../db';
import { getDriver } from '../drivers/registry';
import { getCachedState, noteState } from '../kasa/device.cache';
import { emitDeviceState, emitSensorReading, emitSensorAlert } from '../socket';
import { logger } from '../logger';
import { ingestReading, getSensorByKey, parseSensorConfig } from '../sensors/flow-store';
import { resolveFlowConfig, type FlowReading } from '../sensors/flow-engine';
import { notify } from '../notifications/router';
import { maybeFireShutoff } from '../sensors/shutoff';
import { realInvoker, realNotifier } from '../sensors/shutoff-runtime';
import { notifyStaleRecovery } from '../sensors/stale-check';
import { runPowerCommand } from '../nlp/commands';
import { recordVoiceCommand } from '../nlp/command-log';
import { listDeviceNames, listSceneNames } from '../nlp/find-device';
import { withActivity } from '../activity/activity';
import { issueTokens, serviceUser } from '../auth/auth.service';
import { automationsPaused } from '../automation/pause';

export const internalRouter = Router();

internalRouter.use(requireInternalKey);

interface DeviceRow { id: number; alias: string; ip: string; driver_type: string; driver_config: string | null; }

/** Strip IPv4-mapped IPv6 prefix (::ffff:192.168.1.5 → 192.168.1.5) so the
 *  stored IP is usable directly as a target for outbound HTTP. */
function stripIpv6Mapped(ip?: string): string | null {
  if (!ip) return null;
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  return m ? m[1] : ip;
}

// POST /internal/service-token
// The MCP server's sign-in: it holds the internal key rather than an admin password.
// It acts as the first admin; Activity still shows its changes as the AI assistant's.
internalRouter.post('/service-token', (_req: Request, res: Response) => {
  const user = serviceUser();
  if (!user) {
    res.status(503).json({ error: 'HomeHub has no admin account yet. Create one in the browser first.', code: 'NOT_SET_UP' });
    return;
  }
  res.json({ accessToken: issueTokens(user).accessToken });
});

// GET /internal/voice/device-names
// Lets the voice bridge tell speech recognition which names to expect.
internalRouter.get('/voice/device-names', (_req: Request, res: Response) => {
  res.json({ names: [...listDeviceNames(), ...listSceneNames()] });
});

// POST /internal/voice/command  { text: string }
// Rules only. Spoken text can be misheard, so a model never gets to guess a device from it.
internalRouter.post('/voice/command', async (req: Request, res: Response) => {
  const { text } = req.body as { text?: unknown };
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: '`text` is required', code: 'VALIDATION_ERROR' });
  }

  // The wake word can swallow the first word, leaving "off my office lamp".
  const spoken = text.trim().replace(/^(on|off)\s/i, 'turn $1 ');

  const handled = await withActivity({ source: 'voice' }, () => runPowerCommand(spoken));
  recordVoiceCommand(text.trim(), handled !== null);
  if (!handled) return res.json({ handled: false, response: reply('not_understood', {}), actions: [] });

  res.json({ handled: true, ...handled });
});

// POST /internal/devices/:id/execute  { state: boolean }
// Called by the scheduler when a scheduled action fires.
internalRouter.post('/devices/:id/execute', async (req: Request, res: Response) => {
  const db = getDb();
  const device = db.prepare('SELECT id, alias, ip, driver_type, driver_config FROM devices WHERE id = ?')
    .get(req.params.id) as DeviceRow | undefined;

  if (!device) {
    return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });
  }

  const { state, label } = req.body as { state: boolean; label?: unknown };
  if (typeof state !== 'boolean') {
    return res.status(400).json({ error: '`state` must be a boolean', code: 'VALIDATION_ERROR' });
  }

  if (automationsPaused()) {
    logger.info({ deviceId: device.id, alias: device.alias }, 'Scheduled action skipped — automations paused');
    return res.json({ alias: device.alias, state, skipped: true, paused: true });
  }

  // Skip if there is an active manual override for this device
  const override = db.prepare(
    "SELECT override_state FROM devices WHERE id = ? AND override_until > datetime('now')"
  ).get(device.id) as { override_state: number } | undefined;

  if (override !== undefined) {
    logger.info({ deviceId: device.id, alias: device.alias }, 'Scheduled action skipped — active override');
    return res.json({ alias: device.alias, state, skipped: true });
  }

  try {
    const config = device.driver_config ? JSON.parse(device.driver_config) : undefined;
    await getDriver(device.driver_type ?? 'kasa').setPower(device.ip, state, config);
    withActivity({ source: 'schedule', detail: typeof label === 'string' ? label : null }, () => noteState(device.id, state));
    if (state) {
      db.prepare("UPDATE devices SET turned_on_at = datetime('now') WHERE id = ?").run(device.id);
    } else {
      db.prepare('UPDATE devices SET turned_on_at = NULL WHERE id = ?').run(device.id);
    }
    emitDeviceState(device.id, device.alias, state, getCachedState(device.id)?.wattage ?? null);
    logger.info({ deviceId: device.id, alias: device.alias, state }, 'Scheduled action executed');
    res.json({ alias: device.alias, state });
  } catch (err) {
    logger.error(err, 'Scheduled execute failed');
    res.status(503).json({ error: 'Device unreachable', code: 'DEVICE_UNREACHABLE' });
  }
});

// ── AuraFlow sensor ingestion ──────────────────────────────────────────────

// Per-sensor rate limit: at most RATE_MAX requests per RATE_WINDOW_MS (fix E).
const RATE_MAX        = 10;
const RATE_WINDOW_MS  = 1_000;
const rateBuckets = new Map<string, number[]>();

function rateLimited(sensorKey: string, now: number): boolean {
  const arr = rateBuckets.get(sensorKey) ?? [];
  const cutoff = now - RATE_WINDOW_MS;
  const fresh = arr.filter((t) => t > cutoff);
  fresh.push(now);
  rateBuckets.set(sensorKey, fresh);
  return fresh.length > RATE_MAX;
}

interface FlowReadingPayload {
  sensorId:        string;
  rateM3h:         number;
  totalM3?:        number | null;
  signalQuality?:  number | null;
  tOffsetMs?:      number;
  rssi?:           number | null;
  uptimeSec?:      number | null;
  firmwareVersion?: string | null;
  mac?:            string | null;
  bootReason?:     string | null;
  /** Sent by firmware ≥ 0.1.1-c. False means the Modbus read of the meter
   *  failed (meter not yet wired, RS485 fault, etc.). When false the server
   *  treats this POST as a diagnostic-only heartbeat: refresh sensor
   *  diagnostics + last_ip, but skip the flow_readings INSERT and the leak
   *  engine. Older firmware omits the field; absent → treated as `true` to
   *  preserve historical behaviour. */
  meterReachable?: boolean;
}

// POST /internal/sensors/flow/readings
internalRouter.post('/sensors/flow/readings', (req: Request, res: Response) => {
  const body = req.body as Partial<FlowReadingPayload>;

  if (!body || typeof body.sensorId !== 'string' || typeof body.rateM3h !== 'number'
      || !Number.isFinite(body.rateM3h) || body.rateM3h < 0) {
    return res.status(400).json({ error: '`sensorId` and non-negative numeric `rateM3h` are required', code: 'VALIDATION_ERROR' });
  }

  const now = Date.now();
  if (rateLimited(body.sensorId, now)) {
    return res.status(429).json({ error: 'Rate limit exceeded for sensor', code: 'RATE_LIMITED' });
  }

  const sensor = getSensorByKey(body.sensorId);
  if (!sensor) {
    return res.status(404).json({ error: 'Sensor not registered. Create it via POST /api/sensors first.', code: 'SENSOR_NOT_FOUND' });
  }

  // MAC pinning (fix F)
  if (body.mac) {
    if (!sensor.first_seen_mac) {
      getDb().prepare('UPDATE sensors SET first_seen_mac = ? WHERE id = ?').run(body.mac, sensor.id);
      sensor.first_seen_mac = body.mac;
    } else if (sensor.first_seen_mac !== body.mac) {
      logger.warn(
        { sensorKey: body.sensorId, expected: sensor.first_seen_mac, got: body.mac },
        'Sensor MAC mismatch — rejecting reading',
      );
      return res.status(409).json({ error: 'Sensor MAC mismatch', code: 'MAC_MISMATCH' });
    }
  }

  const tOffsetMs = Math.max(0, Math.floor(body.tOffsetMs ?? 0));
  const recordedAt = new Date(now - tOffsetMs);

  // Default to true when the field is missing — keeps older firmware
  // (no meterReachable in payload) behaving exactly as before.
  const meterReachable = body.meterReachable !== false;

  // Diagnostic-only heartbeat path: skip the flow_readings INSERT and
  // the leak engine. Still refresh diagnostics so the dashboard sees
  // the device is alive, OTA dispatch knows the IP, and stale-check
  // doesn't trip. We also DON'T emit the sensor-reading socket event
  // (a heartbeat is not a reading), but the sensors-list will pick up
  // the new last_seen on its next polling cycle.
  const wasStale = !!sensor.stale_since;
  const sourceIp = stripIpv6Mapped(req.ip);

  if (!meterReachable) {
    getDb().prepare(`
      UPDATE sensors
         SET last_seen_at         = ?,
             stale_since          = NULL,
             last_rssi            = COALESCE(?, last_rssi),
             last_uptime_sec      = COALESCE(?, last_uptime_sec),
             firmware_version     = COALESCE(?, firmware_version),
             last_ip              = COALESCE(?, last_ip),
             last_meter_reachable = 0
       WHERE id = ?
    `).run(
      recordedAt.toISOString().replace('T', ' ').replace('Z', ''),
      body.rssi ?? null,
      body.uptimeSec ?? null,
      body.firmwareVersion ?? null,
      sourceIp,
      sensor.id,
    );
    if (wasStale) notifyStaleRecovery(sensor.id, sensor.alias);
    logger.debug({ sensorKey: body.sensorId, ip: sourceIp }, 'Diagnostic heartbeat (meter unreachable)');

    // Honour the same response shape so the firmware applies cadence as usual.
    const cfg = resolveFlowConfig(parseSensorConfig(sensor.config));
    const stored: Partial<FlowReadingPollConfig> = sensor.config ? safeJson(sensor.config) : {};
    return res.json({
      pollIntervalMs:        stored.idlePollIntervalMs ?? 30000,
      flowingPollIntervalMs: stored.flowingPollIntervalMs ?? 5000,
      idlePollIntervalMs:    stored.idlePollIntervalMs   ?? 30000,
      configVersion:         stored.version              ?? 1,
    });
  }

  const reading: FlowReading = {
    rate:          body.rateM3h,
    totalM3:       body.totalM3 ?? null,
    signalQuality: body.signalQuality ?? null,
    recordedAt,
  };

  const result = ingestReading(sensor, reading, tOffsetMs);

  // Update diagnostics columns on every successful ingest. Clearing
  // stale_since here is the recovery half of the stale-detection state
  // machine — see sensors/stale-check.ts.
  // last_ip is captured here so an admin clicking "Update firmware" on the
  // dashboard can dispatch to the device without requiring static IP.
  getDb().prepare(`
    UPDATE sensors
       SET last_seen_at         = ?,
           stale_since          = NULL,
           last_rssi            = COALESCE(?, last_rssi),
           last_uptime_sec      = COALESCE(?, last_uptime_sec),
           last_signal_quality  = COALESCE(?, last_signal_quality),
           firmware_version     = COALESCE(?, firmware_version),
           last_ip              = COALESCE(?, last_ip),
           last_meter_reachable = 1
     WHERE id = ?
  `).run(
    recordedAt.toISOString().replace('T', ' ').replace('Z', ''),
    body.rssi ?? null,
    body.uptimeSec ?? null,
    body.signalQuality ?? null,
    body.firmwareVersion ?? null,
    sourceIp,
    sensor.id,
  );
  if (wasStale) {
    notifyStaleRecovery(sensor.id, sensor.alias);
  }

  // Real-time updates for the dashboard.
  if (!result.decision.rejectedSignal) {
    emitSensorReading(
      sensor.id, sensor.sensor_id, body.rateM3h, body.totalM3 ?? null,
      recordedAt.toISOString(),
    );
  }
  if (result.levelChanged && result.eventId !== null) {
    emitSensorAlert(sensor.id, sensor.sensor_id, result.eventId, result.level, body.rateM3h);
    logger.info(
      { sensorKey: sensor.sensor_id, eventId: result.eventId, level: result.level },
      'Flow alert level transition',
    );
    // Fire-and-forget: don't block the ESP32's response on notification dispatch.
    if (result.level >= 1) {
      notify({
        level:        result.level,
        eventId:      result.eventId,
        sensorRowId:  sensor.id,
        sensorKey:    sensor.sensor_id,
        sensorAlias:  sensor.alias,
        rateM3h:      body.rateM3h,
        snoozedUntil: sensor.snoozed_until,
      });
    }

    // Auto-shutoff: idempotent, only fires once per event when level reaches 3.
    if (result.level >= 3) {
      maybeFireShutoff(result.eventId, realInvoker, realNotifier).catch((err) => {
        logger.error(err, 'Auto-shutoff threw');
      });
    }
  }
  if (result.opened) {
    logger.info({ sensorKey: sensor.sensor_id, eventId: result.eventId }, 'Flow event opened');
  }
  if (result.closed) {
    logger.info({ sensorKey: sensor.sensor_id, eventId: result.eventId }, 'Flow event closed');
  }

  // Server-pushed adaptive poll config — see firmware.md.
  const cfg = resolveFlowConfig(parseSensorConfig(sensor.config));
  const isFlowing = body.rateM3h > cfg.flowingThresholdM3h;
  const stored: Partial<FlowReadingPollConfig> = sensor.config ? safeJson(sensor.config) : {};

  res.json({
    pollIntervalMs:        isFlowing
      ? (stored.flowingPollIntervalMs ?? 5000)
      : (stored.idlePollIntervalMs   ?? 30000),
    flowingPollIntervalMs: stored.flowingPollIntervalMs ?? 5000,
    idlePollIntervalMs:    stored.idlePollIntervalMs   ?? 30000,
    configVersion:         stored.version              ?? 1,
  });
});

interface FlowReadingPollConfig {
  flowingPollIntervalMs?: number;
  idlePollIntervalMs?:    number;
  version?:               number;
}

function safeJson<T>(s: string): Partial<T> {
  try { return JSON.parse(s) as Partial<T>; } catch { return {}; }
}
