import { announcementDone, answerAsk, openAsks, pendingAnnouncements } from '../family/reminders';
import { runVacuumCommand } from '../nlp/vacuum-rooms';
import { cancel as cancelSos, openAlert as openSos, raise as raiseSos, reach as sosReach } from '../family/sos';
import { answerCheckinAsk, openCheckinAsks } from '../family/checkin';
import { Router, Request, Response } from 'express';
import { reply } from '../nlp/replies';
import { answerStatusQuestion } from '../nlp/status';
import { spokenDegrees } from '../nlp/questions';
import { spokenAnswer } from '../nlp/spoken';
import { answerAsked, answerMissed, FOLLOW_UP_MS, type Answered } from '../nlp/question-reader';
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
import { answerVoiceAsk, askForVoice, thermostatProposal } from '../nlp/nlp.service';
import { askText, setPending } from '../nlp/confirm';
import { randomUUID } from 'crypto';
import { recordVoiceCommand } from '../nlp/command-log';
import { withActivity } from '../activity/activity';
import { issueTokens, serviceUser } from '../auth/auth.service';
import { automationsPaused } from '../automation/pause';
import { VOICE_LANGUAGES, bridgeInstructions, recordBridgeReport, voiceConfig, voiceNames, type VoiceLanguage } from '../system/voice-bridge';
import { noteBridgeReport } from '../system/voice-ready';
import { cancelPowerTimer, setScheduleTimer } from '../devices/power';
import { MAX_STAY_ON_MINUTES } from './schedules';
import { scheduledClean } from '../roomba/service';
import { RoomError } from '../roomba/rooms';
import { configWithPlay, playChoiceOf } from '../drivers/SonosDriver';
import { sendPushToUsers } from '../push/push.service';

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
  res.json(voiceNames());
});

// GET /internal/voice/config
// Voice on or off, and its languages, as chosen in Settings → Voice control.
// The bridge that comes with HomeHub waits until voice is on.
// It asks every 10 seconds, so namesVersion lets a new nickname work by voice straight away.
// announcements: reminders due now, for the bridge to say on its speakers; asking: reminders waiting
// for a yes or no. Neither is part of `version`, which the bridge restarts for.
internalRouter.get('/voice/config', (_req: Request, res: Response) => {
  res.json({ ...voiceConfig(), namesVersion: voiceNames().version, announcements: pendingAnnouncements(), asking: [...openCheckinAsks(), ...openAsks()] });
});

// POST /internal/voice/asks/:id  { answer: 'yes' | 'no', kind? }: the answer to a reminder's "done yet?",
// or with kind 'checkin', to a check-in's "are you OK?". asking in /voice/config lists the open ones
// with their kind, so a yes or no heard now answers them.
internalRouter.post('/voice/asks/:id', (req: Request, res: Response) => {
  const { answer, kind } = req.body ?? {};
  if (answer !== 'yes' && answer !== 'no') return res.status(400).json({ error: '`answer` must be yes or no', code: 'VALIDATION_ERROR' });
  const id = Number(req.params['id']);
  const done = kind === 'checkin' ? answerCheckinAsk(id, answer) : answerAsk(id, answer, 'voice');
  if (!done) return res.status(404).json({ error: 'Not asking', code: 'NOT_FOUND' });
  res.json({ ok: true });
});

// POST /internal/voice/announcements/:id  { said: [speaker names], error? } — how saying it went
internalRouter.post('/voice/announcements/:id', (req: Request, res: Response) => {
  if (!announcementDone(String(req.params['id']), req.body)) return res.status(404).json({ error: 'Not waiting to be said', code: 'NOT_FOUND' });
  res.json({ ok: true });
});

// POST /internal/voice/status  { version?, speakers: [{ name, address, connected }] }
// The voice bridge checks in every minute, for the Health page. The answer says
// whether its names are out of date, and whether an admin asked it to restart.
internalRouter.post('/voice/status', (req: Request, res: Response) => {
  const report = recordBridgeReport(req.body);
  if (!report) {
    return res.status(400).json({ error: '`speakers` must be a list', code: 'VALIDATION_ERROR' });
  }
  noteBridgeReport(report);
  // namesVersion changes when a device, nickname, room or scene name does, so the bridge fetches them again.
  res.json({ ok: true, ...bridgeInstructions() });
});

// POST /internal/voice/command  { text: string, retry?, ask?, lang?, heard?, questions?, wake? }
// The rules act at once. Spoken text can be misheard, so a model never switches a device from it:
// with Claude in use, a miss can become a question ("Should I turn on Kitchen light?") the bridge asks aloud.
// With Claude, a question is read by it too (question-reader.ts): "the weather in New York?", or a follow-up.
internalRouter.post('/voice/command', async (req: Request, res: Response) => {
  // retry: the bridge will try again with a slower, more careful hearing if this isn't understood,
  // so a miss isn't recorded yet. A command that is understood is recorded either way.
  // ask: the bridge can ask "Should I turn on …?" and listen for the answer (bridges before it couldn't).
  // lang: the language it heard, for the question's words and voice.
  // heard: what was said, when `text` is the bridge's English for a question it read itself.
  // questions: the bridge says an answer's `say` as it is, on a retry too (bridges from v0.2.12).
  // wake: the wake word the speaker was woken with, for Claude's reading of a miss (bridges from v0.2.18).
  const { text, retry, ask, lang, heard, questions, wake } = req.body as
    { text?: unknown; retry?: unknown; ask?: unknown; lang?: unknown; heard?: unknown; questions?: unknown; wake?: unknown };
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: '`text` is required', code: 'VALIDATION_ERROR' });
  }

  // The wake word can swallow the first word, leaving "off my office lamp" or "Off, kitchen light.",
  // and speech recognition can put a comma after the verb: "Turn off, Office light."
  const spoken = text.trim().replace(/^(?:(?:turn|switch)\s+)?(on|off)(?:\s*,\s*|\s+)/i, 'turn $1 ');
  const language = (VOICE_LANGUAGES as readonly string[]).includes(String(lang)) ? (lang as VoiceLanguage) : null;
  // Bridges that can ask also say HomeHub's `say` as it is: an answer in the language heard.
  const canSay = questions === true || (ask === true && retry !== true);
  const said = typeof heard === 'string' && heard.trim() ? heard.trim() : null;
  const reading = { who: 'voice', lang: language, heard: said, timeoutMs: 4_000, windowMs: FOLLOW_UP_MS.voice };

  const ruled = await withActivity({ source: 'voice' }, async () => await runVacuumCommand(spoken) ?? runPowerCommand(spoken));
  if (ruled?.ask) {
    // Turning a thermostat off: the speaker asks first and listens for the yes, on the bridge's
    // quick first hearing too (it sends ask only on its careful second one, but listens for a
    // question on both). A bridge that can't ask is told to use the card.
    recordVoiceCommand(said ?? text.trim(), true);
    if (ask !== true && questions !== true) return res.json({ handled: false, response: 'Turning off a thermostat needs a yes, so use its card on the dashboard.', actions: [] });
    const proposal = thermostatProposal(ruled.ask, language ?? 'en', spoken);
    const confirmId = randomUUID();
    setPending(`voice:${confirmId}`, proposal);
    const say = askText(proposal);
    // handled: understood, so the bridge asks now rather than hearing it again more slowly first.
    return res.json({ handled: true, response: say, say, lang: proposal.lang, actions: [], confirmId });
  }
  const handled = ruled ?? answerStatusQuestion(spoken) ?? await answerAsked(spoken, { ...reading, read: canSay });
  if (handled) {
    recordVoiceCommand(said ?? text.trim(), true);
    const own = (handled as Answered).said;
    if (own && canSay) return res.json(sayIt(handled, own.lang));
    return res.json({ handled: true, ...handled, response: spokenDegrees(handled.response) });
  }

  // With Claude in use, HomeHub asks before doing what it read. Not on a first try the bridge will
  // hear again more carefully. Claude reading nothing to switch leaves it not understood, as before.
  // A question Claude reads is answered, on a first try too: an English one then needn't wait for Whisper.
  const [asked, answer] = await Promise.all([
    ask === true && retry !== true ? askForVoice(spoken, language, typeof wake === 'string' ? wake.trim().slice(0, 40) : '') : null,
    canSay ? answerMissed(spoken, reading) : null,
  ]);
  if (asked) {
    if (retry !== true) recordVoiceCommand(text.trim(), false);
    return res.json({ handled: false, response: asked.say, say: asked.say, lang: asked.lang, actions: [],
      ...(asked.confirmId ? { confirmId: asked.confirmId } : {}) });
  }
  if (answer) {
    recordVoiceCommand(text.trim(), true);
    return res.json(sayIt(answer, answer.said!.lang));
  }
  if (retry !== true) recordVoiceCommand(text.trim(), false);
  return res.json({ handled: false, response: reply('not_understood', {}), actions: [] });
});

/** An answer for the bridge to say as it is, in `lang`. */
function sayIt(answer: { response: string; actions: unknown[] }, lang: VoiceLanguage) {
  const say = spokenAnswer(answer.response, lang);
  return { handled: true, response: say, say, lang, actions: answer.actions };
}

// POST /internal/voice/confirm/:id  { answer: 'yes' | 'no' }: the answer to "Should I turn on …?" after a
// voice command. Replies with what to say, in the question's language; 404 once it isn't asking.
internalRouter.post('/voice/confirm/:id', async (req: Request, res: Response) => {
  const answer = (req.body ?? {}).answer;
  if (answer !== 'yes' && answer !== 'no') return res.status(400).json({ error: '`answer` must be yes or no', code: 'VALIDATION_ERROR' });
  const done = await withActivity({ source: 'voice' }, () => answerVoiceAsk(String(req.params['id']), answer));
  if (!done) return res.status(404).json({ error: 'Not asking', code: 'NOT_FOUND' });
  const ok = answer === 'no' || done.actions.some((a) => (a.result as { success?: boolean } | undefined)?.success);
  res.json({ handled: ok, response: done.response, lang: done.lang, actions: done.actions });
});

// POST /internal/voice/sos  { action: 'raise' | 'cancel', where?, lang?, heard? }
// A call for help heard by a speaker, or "cancel" after one. The bridge says the reply in the
// language it heard, from `state`: raised, already (one is going), cancelled, or nothing (no call
// to cancel, so "cancel" wasn't meant for this).
// Bridges from v0.1.86 to v0.2.7 sent it to /internal/voice/family/sos, which HomeHub didn't
// answer, so their calls for help failed: that address works too, for one left on an old image.
internalRouter.post(['/voice/sos', '/voice/family/sos'], async (req: Request, res: Response) => {
  const { action, where, lang, heard } = (req.body ?? {}) as { action?: unknown; where?: unknown; lang?: unknown; heard?: unknown };
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const language = (VOICE_LANGUAGES as readonly string[]).includes(str(lang) ?? '') ? (lang as VoiceLanguage) : null;
  if (action === 'raise') {
    const r = raiseSos({ via: 'voice', place: str(where), lang: language, heard: str(heard) });
    // reach: how many phones, addresses and numbers can be told. With none, the speaker says to phone for help.
    return res.json({ state: r.state, id: r.alert.id, who: r.alert.who, ackedBy: r.alert.ackedBy, reach: sosReach() });
  }
  if (action === 'cancel') {
    const open = openSos();
    if (!open) return res.json({ state: 'nothing' });
    const a = await cancelSos(open.id, open.who);
    return res.json({ state: 'cancelled', id: a.id, who: a.who, ackedBy: a.ackedBy });
  }
  res.status(400).json({ error: '`action` must be raise or cancel', code: 'VALIDATION_ERROR' });
});

// POST /internal/devices/:id/execute  { state: boolean, label?, stayOnMinutes?, rooms?, play? }
// Called by the scheduler when a scheduled action fires. stayOnMinutes, on a
// Turn ON schedule, sets the device's timer to turn it off again. A robot vacuum's
// Turn ON is a clean: of `rooms` (room keys), or with none the whole house. A Sonos's
// Turn ON (Play) with `play` starts that favorite or Sonos playlist.
internalRouter.post('/devices/:id/execute', async (req: Request, res: Response) => {
  const db = getDb();
  const device = db.prepare('SELECT id, alias, ip, driver_type, driver_config FROM devices WHERE id = ?')
    .get(req.params.id) as DeviceRow | undefined;

  if (!device) {
    return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });
  }

  const { state, label, stayOnMinutes, rooms, play } = req.body as { state: boolean; label?: unknown; stayOnMinutes?: unknown; rooms?: unknown; play?: unknown };
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

  if (device.driver_type === 'roomba' && state) return runScheduledClean(device, label, rooms, res);

  try {
    // A Sonos Play schedule may start a chosen favorite instead of carrying on.
    const chosen = device.driver_type === 'sonos' && state ? playChoiceOf(typeof play === 'string' ? play : play ? JSON.stringify(play) : null) : null;
    const configJson = configWithPlay(device.driver_config, chosen);
    const config = configJson ? JSON.parse(configJson) : undefined;
    await getDriver(device.driver_type ?? 'kasa').setPower(device.ip, state, config);
    withActivity({ source: 'schedule', detail: typeof label === 'string' ? label : null }, () => noteState(device.id, state));
    const name = typeof label === 'string' && label ? label : 'Schedule';
    const stayOn = state && typeof stayOnMinutes === 'number' && Number.isInteger(stayOnMinutes)
      && stayOnMinutes >= 1 && stayOnMinutes <= MAX_STAY_ON_MINUTES ? stayOnMinutes : null;
    if (state) {
      db.prepare("UPDATE devices SET turned_on_at = datetime('now') WHERE id = ?").run(device.id);
      if (stayOn) setScheduleTimer(device.id, stayOn, name);
    } else {
      db.prepare('UPDATE devices SET turned_on_at = NULL WHERE id = ?').run(device.id);
      // Off already: a timer left from a "Turn off after" has nothing left to do.
      cancelPowerTimer(device.id);
    }
    emitDeviceState(device.id, device.alias, state, getCachedState(device.id)?.wattage ?? null);
    logger.info({ deviceId: device.id, alias: device.alias, state, ...(stayOn ? { stayOnMinutes: stayOn } : {}) }, 'Scheduled action executed');
    res.json({ alias: device.alias, state, ...(stayOn ? { stayOnMinutes: stayOn } : {}) });
  } catch (err) {
    logger.error(err, 'Scheduled execute failed');
    res.status(503).json({ error: 'Device unreachable', code: 'DEVICE_UNREACHABLE' });
  }
});

/**
 * A robot vacuum's Clean schedule, started the way the dashboard and voice start one: a job it holds
 * paused is ended first, and HomeHub waits to see it set off. A robot already out on a job keeps it.
 * If it doesn't start, admins are told, since nobody is there to see it.
 */
async function runScheduledClean(device: DeviceRow, label: unknown, rooms: unknown, res: Response): Promise<void> {
  const name = typeof label === 'string' && label ? label : 'Schedule';
  try {
    const done = await withActivity({ source: 'schedule', detail: typeof label === 'string' ? label : null }, () => scheduledClean(device.id, rooms));
    if ('skipped' in done) {
      logger.info({ deviceId: device.id, alias: device.alias, schedule: name }, 'Scheduled clean skipped — the robot is already on a job');
      res.json({ alias: device.alias, state: true, skipped: true, busy: true });
      return;
    }
    logger.info({ deviceId: device.id, alias: device.alias, rooms: done.names.length ? done.names : 'whole house', ...(done.missing ? { missing: done.missing } : {}) }, 'Scheduled clean started');
    res.json({ alias: device.alias, state: true, rooms: done.names, ...(done.missing ? { missing: done.missing } : {}) });
  } catch (err) {
    const why = err instanceof RoomError ? err.message : 'HomeHub couldn’t reach it.';
    logger.warn({ deviceId: device.id, alias: device.alias, schedule: name, reason: (err as Error).message }, 'Scheduled clean failed');
    const admins = (getDb().prepare("SELECT id FROM users WHERE role = 'admin'").all() as { id: number }[]).map((u) => u.id);
    sendPushToUsers(admins, `${device.alias} didn’t start “${name}”`, why, { url: '/schedules', deviceId: device.id });
    res.status(503).json({ error: why, code: err instanceof RoomError ? 'VACUUM_DID_NOT_START' : 'DEVICE_UNREACHABLE' });
  }
}

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
