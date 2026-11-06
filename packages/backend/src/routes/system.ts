import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { logger } from '../logger';
import { automationsPaused, setAutomationsPaused } from '../automation/pause';
import { BRIDGE_LATE_MS, checkHealth } from '../system/health';
import { lastBridgeReport, requestBridgeRestart } from '../system/voice-bridge';
import { UpdaterError, VERSION_RE, previousVersion, requestSwitch, switchStatus, updaterAvailable } from '../system/updater';
import { backupBefore } from '../db/backup';

/**
 * HomeHub-self update routes — see auraflow/docs/ota-strategy.md
 * "option A" for the full design.
 *
 * The actual docker-pull + container-recreate is delegated to the
 * watchtower sidecar (`docker-compose.yml`); this router is just the
 * UI-facing version display + a Bearer-auth POST that pokes
 * Watchtower's HTTP API. The backend never touches the docker socket
 * itself, so it can survive its own container being recreated.
 */

/* `dev` is treated as "running locally outside Docker" — no version
 * comparison runs and no update button shows. The Dockerfile bakes
 * the real value in via build-arg so deployed instances always have
 * a comparable string. */
const HOMEHUB_VERSION       = process.env.HOMEHUB_VERSION ?? 'dev';
const WATCHTOWER_URL        = process.env.WATCHTOWER_URL ?? 'http://localhost:8080';
const WATCHTOWER_HTTP_TOKEN = process.env.WATCHTOWER_HTTP_API_TOKEN ?? '';

/* Where to look for the latest release. Defaults to the public homehub
 * repo's GitHub Releases. Configurable so self-hosted forks can point
 * elsewhere (e.g. a private mirror). */
const RELEASES_URL = process.env.HOMEHUB_RELEASES_URL
  ?? 'https://api.github.com/repos/foodisready/homehub/releases/latest';

// 10 minutes: a new release shows soon after it's published, and 6 checks an hour
// stay well inside GitHub's 60 an hour for unauthenticated requests.
const CACHE_TTL_MS = 10 * 60 * 1000;

/* Cache the GitHub Releases lookup so the UI's per-minute poll doesn't
 * burn through the 60/hour unauthenticated rate limit. We hold the
 * last good value across failures: a 403 (rate limited) or transient
 * network error returns the stale tag rather than `null`, so the card
 * doesn't flap "available → unknown → available." */
let latestCache: { version: string | null; fetchedAt: number } = { version: null, fetchedAt: 0 };

async function getLatestVersion(): Promise<string | null> {
  if (latestCache.version !== null && Date.now() - latestCache.fetchedAt < CACHE_TTL_MS) {
    return latestCache.version;
  }
  try {
    const r = await fetch(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!r.ok) {
      logger.warn({ status: r.status, url: RELEASES_URL }, 'releases fetch returned non-OK');
      return latestCache.version;
    }
    const json = (await r.json()) as { tag_name?: unknown };
    if (typeof json.tag_name === 'string' && json.tag_name.length > 0) {
      latestCache = { version: json.tag_name, fetchedAt: Date.now() };
      return json.tag_name;
    }
    return latestCache.version;
  } catch (err) {
    logger.warn({ err }, 'releases fetch threw');
    return latestCache.version;
  }
}

export const systemRouter = Router();

/* GET /api/system/version
 * Returns running + latest + whether an update is available. The
 * update flag is only ever true for real Docker builds (HOMEHUB_VERSION
 * != "dev") so a dev workflow doesn't surface an Update button that
 * wouldn't actually do anything. */
/* Whether the updater service answers, checked at most every 30 seconds:
 * every open page asks for the version each minute. */
let switcherCache = { up: false, at: 0 };
async function canSwitch(): Promise<boolean> {
  if (Date.now() - switcherCache.at > 30_000) switcherCache = { up: await updaterAvailable(), at: Date.now() };
  return switcherCache.up;
}

systemRouter.get('/version', async (_req: Request, res: Response) => {
  const [latest, switcher] = await Promise.all([getLatestVersion(), canSwitch()]);
  const updateAvailable =
    HOMEHUB_VERSION !== 'dev'
    && latest !== null
    && latest !== HOMEHUB_VERSION;
  const previous = HOMEHUB_VERSION === 'dev' ? null : previousVersion();
  res.json({
    running: HOMEHUB_VERSION,
    latest,
    updateAvailable,
    updaterAvailable: WATCHTOWER_HTTP_TOKEN.length > 0,
    // The updater service can switch to any release, so this HomeHub can go back.
    canSwitch: switcher,
    previous,
  });
});

/* Before changing version, a copy of the database, in case the other
 * version can't use it. */
function backupForSwitch(to: string): void {
  backupBefore(`version-${HOMEHUB_VERSION}-to-${to}`);
}

/* POST /api/system/switch { version }
 * Goes back to the version that ran before this one, or on to the latest
 * release. Only those two: an arbitrary old version could be one whose
 * database changes this one has already made. Needs the updater service. */
systemRouter.post('/switch', requireAdmin, async (req: Request, res: Response) => {
  const version = (req.body ?? {}).version;
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    return res.status(400).json({ error: 'version must look like v1.2.3', code: 'VALIDATION_ERROR' });
  }
  if (version === HOMEHUB_VERSION) {
    return res.status(400).json({ error: `HomeHub is already running ${version}.`, code: 'ALREADY_RUNNING' });
  }
  const allowed = [previousVersion(), await getLatestVersion()].filter((v): v is string => !!v);
  if (!allowed.includes(version)) {
    return res.status(400).json({ error: 'HomeHub can go back to the version before this one, or update to the latest.', code: 'VERSION_NOT_OFFERED' });
  }
  try {
    backupForSwitch(version);
    await requestSwitch(version);
    logger.info({ from: HOMEHUB_VERSION, to: version, by: req.user?.name }, 'Version switch started');
    res.status(202).json({ started: true, version, message: `Switching to ${version}. HomeHub will restart shortly.` });
  } catch (err) {
    if (err instanceof UpdaterError) return res.status(err.status).json({ error: err.message, code: err.code });
    throw err;
  }
});

/* GET /api/system/switch-status — the updater's last switch, so a failed
 * download can be explained after HomeHub comes back. */
systemRouter.get('/switch-status', requireAdmin, async (_req: Request, res: Response) => {
  res.json(await switchStatus());
});

/* GET /api/system/health
 * Whether HomeHub is working: services, devices, voice, backups, disk and
 * settings, each with what to do about it. For the Health page. */
systemRouter.get('/health', async (_req: Request, res: Response) => {
  res.json(await checkHealth());
});

/* POST /api/system/voice-bridge/restart (admin)
 * The bridge runs outside HomeHub, so it's asked at its next check-in, within a
 * minute, and then stops; its service starts it again. */
systemRouter.post('/voice-bridge/restart', requireAdmin, (req: Request, res: Response) => {
  const report = lastBridgeReport();
  if (!report || Date.now() - report.at > BRIDGE_LATE_MS) {
    return res.status(409).json({
      error: "The voice bridge isn't checking in, so it can't be asked to restart. On the computer it runs on, run: systemctl --user restart homehub-voice",
      code: 'BRIDGE_NOT_RUNNING',
    });
  }
  requestBridgeRestart();
  logger.info({ by: req.user?.name }, 'Voice bridge restart requested');
  res.status(202).json({ asked: true });
});

/* GET /api/system/automations — { paused }, for the banner every page shows while paused.
 * PUT (admin) { paused } pauses or resumes schedules, motion rules, timers,
 * camera motion snapshots and automatic water shutoff on this HomeHub. */
systemRouter.get('/automations', (_req: Request, res: Response) => {
  res.json({ paused: automationsPaused() });
});

systemRouter.put('/automations', requireAdmin, (req: Request, res: Response) => {
  const { paused } = (req.body ?? {}) as { paused?: unknown };
  if (typeof paused !== 'boolean') {
    return res.status(400).json({ error: 'paused must be true or false', code: 'VALIDATION_ERROR' });
  }
  setAutomationsPaused(paused);
  res.json({ paused: automationsPaused() });
});

/* GET /api/system/remote-url
 * The address for the dashboard's QR code. It's configured rather than
 * read from the request, so a page opened on localhost still gives a
 * phone a usable address. Null means the page should use its own origin. */
systemRouter.get('/remote-url', (_req: Request, res: Response) => {
  res.json({ url: process.env.HOMEHUB_REMOTE_URL || null });
});

/* POST /api/system/update
 * Forwards the request to Watchtower. The container-recreate happens
 * after this response is on the wire — the client's TCP connection
 * will drop mid-poll and reconnect to the new instance. */
/* Watchtower answers only once it has pulled the new images and replaced the
 * containers, this backend included, so waiting for its answer would never
 * finish: the request dies with the old container. Wait briefly for a quick
 * refusal (wrong token, updater down), then say the update has started. */
let acceptWaitMs = 3_000;
/** For tests. */
export function setUpdateAcceptWait(ms: number): void { acceptWaitMs = ms; }

systemRouter.post('/update', requireAdmin, async (req: Request, res: Response) => {
  // With the updater service, an update is a switch to the latest release.
  const latest = await getLatestVersion();
  if (latest && VERSION_RE.test(latest) && latest !== HOMEHUB_VERSION && await canSwitch()) {
    try {
      backupForSwitch(latest);
      await requestSwitch(latest);
      logger.info({ from: HOMEHUB_VERSION, to: latest, by: req.user?.name }, 'Update started');
      return res.status(202).json({ started: true, message: 'Update started — HomeHub will restart shortly.' });
    } catch (err) {
      if (!(err instanceof UpdaterError)) throw err;
      logger.warn({ code: err.code }, 'Updater failed; trying Watchtower');
    }
  }

  if (!WATCHTOWER_HTTP_TOKEN) {
    return res.status(503).json({
      error: 'updater not configured (WATCHTOWER_HTTP_API_TOKEN unset)',
      code:  'UPDATER_DISABLED',
    });
  }

  const request = fetch(`${WATCHTOWER_URL}/v1/update`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${WATCHTOWER_HTTP_TOKEN}` },
  });
  const STILL_RUNNING = Symbol('still running');
  const first = await Promise.race([
    request.then((r) => ({ r }), (err: unknown) => ({ err })),
    new Promise<typeof STILL_RUNNING>((resolve) => setTimeout(() => resolve(STILL_RUNNING), acceptWaitMs)),
  ]);

  if (first === STILL_RUNNING) {
    // Updating. The answer, if it ever comes, only matters for the log.
    request.then(
      (r) => { if (!r.ok) logger.error({ status: r.status }, 'watchtower update finished with an error'); },
      () => undefined,   // expected: this container is replaced mid-request
    );
    logger.info('Update started');
    return res.status(202).json({ started: true, message: 'Update started — HomeHub will restart shortly.' });
  }
  if ('err' in first) {
    logger.error({ err: first.err }, 'watchtower unreachable');
    return res.status(503).json({ error: 'updater unreachable', code: 'UPDATER_OFFLINE' });
  }
  if (!first.r.ok) {
    const text = await first.r.text().catch(() => '');
    logger.error({ status: first.r.status, text }, 'watchtower update endpoint rejected request');
    return res.status(502).json({ error: 'updater rejected request', code: 'UPDATER_FAILED' });
  }
  // Finished already: nothing was out of date, or this container wasn't replaced.
  return res.json({ started: true, message: 'Update finished.' });
});
