import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { logger } from '../logger';

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

const CACHE_TTL_MS = 60 * 60 * 1000;   // 1 hour — see `latest` cache below

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
systemRouter.get('/version', async (_req: Request, res: Response) => {
  const latest = await getLatestVersion();
  const updateAvailable =
    HOMEHUB_VERSION !== 'dev'
    && latest !== null
    && latest !== HOMEHUB_VERSION;
  res.json({
    running: HOMEHUB_VERSION,
    latest,
    updateAvailable,
    updaterAvailable: WATCHTOWER_HTTP_TOKEN.length > 0,
  });
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
systemRouter.post('/update', requireAdmin, async (_req: Request, res: Response) => {
  if (!WATCHTOWER_HTTP_TOKEN) {
    return res.status(503).json({
      error: 'updater not configured (WATCHTOWER_HTTP_API_TOKEN unset)',
      code:  'UPDATER_DISABLED',
    });
  }

  try {
    const r = await fetch(`${WATCHTOWER_URL}/v1/update`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${WATCHTOWER_HTTP_TOKEN}` },
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      logger.error({ status: r.status, text }, 'watchtower update endpoint rejected request');
      return res.status(502).json({
        error: 'updater rejected request',
        code:  'UPDATER_FAILED',
      });
    }
    return res.json({
      started: true,
      message: 'Update started — backend will restart shortly.',
    });
  } catch (err) {
    logger.error({ err }, 'watchtower unreachable');
    return res.status(503).json({
      error: 'updater unreachable',
      code:  'UPDATER_OFFLINE',
    });
  }
});
