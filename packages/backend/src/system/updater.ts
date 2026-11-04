import { getDb } from '../db';
import { logger } from '../logger';

/**
 * Talks to the updater service, which switches HomeHub to a release, newer
 * or older. It holds the Docker socket so the backend never does. Older
 * installs don't have it until the installer runs again; they update through
 * Watchtower instead and can't go back.
 */

export const VERSION_RE = /^v\d+\.\d+\.\d+$/;

const url = () => (process.env.UPDATER_URL || 'http://127.0.0.1:8081').replace(/\/+$/, '');
const token = () => process.env.WATCHTOWER_HTTP_API_TOKEN ?? '';

export class UpdaterError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
  }
}

/** Whether the updater is installed and answering. */
export async function updaterAvailable(): Promise<boolean> {
  if (!token()) return false;
  try {
    const r = await fetch(`${url()}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Asks the updater to switch. It answers at once and works in the background. */
export async function requestSwitch(version: string): Promise<void> {
  if (!VERSION_RE.test(version)) throw new UpdaterError('Not a release version', 'VALIDATION_ERROR', 400);
  let r: Response;
  try {
    r = await fetch(`${url()}/switch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    logger.error({ err }, 'updater unreachable');
    throw new UpdaterError("The updater isn't running. Run the installer on the HomeHub computer.", 'UPDATER_OFFLINE', 503);
  }
  if (r.status === 409) throw new UpdaterError('A version change is already under way.', 'BUSY', 409);
  if (!r.ok) {
    logger.error({ status: r.status, body: await r.text().catch(() => '') }, 'updater refused the switch');
    throw new UpdaterError('The updater refused the request.', 'UPDATER_FAILED', 502);
  }
}

export interface SwitchStatus {
  busy: boolean;
  current: string;
  last: { version: string; from?: string; ok: boolean; step: string; finished?: string } | null;
}

/** The updater's last switch, such as a failed download. Null if it can't be asked. */
export async function switchStatus(): Promise<SwitchStatus | null> {
  if (!token()) return null;
  try {
    const r = await fetch(`${url()}/status`, { headers: { Authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const s = (await r.json()) as SwitchStatus;
    // The log stays in the updater's own output; the app only needs the outcome.
    return { busy: !!s.busy, current: String(s.current ?? ''), last: s.last ? { version: s.last.version, from: s.last.from, ok: !!s.last.ok, step: s.last.step, finished: s.last.finished } : null };
  } catch {
    return null;
  }
}

// ── Which version ran before this one ───────────────────────────────────────

const CURRENT = 'version_current';
const PREVIOUS = 'version_previous';

function get(key: string): string | null {
  return (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}
function set(key: string, value: string): void {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/**
 * At startup: when this is a different release from last time, the last one
 * becomes the version to go back to.
 */
export function noteRunningVersion(version = process.env.HOMEHUB_VERSION ?? 'dev'): void {
  if (!VERSION_RE.test(version)) return;
  const was = get(CURRENT);
  if (was === version) return;
  if (was && VERSION_RE.test(was)) set(PREVIOUS, was);
  set(CURRENT, version);
  logger.info({ from: was, to: version }, 'HomeHub version changed');
}

const parts = (v: string) => v.slice(1).split('.').map(Number);
/** Negative when a is older than b. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * The older release that ran before this one, to go back to. After going
 * back, the newer one isn't offered here: the Update card offers it.
 */
export function previousVersion(): string | null {
  const v = get(PREVIOUS);
  const now = process.env.HOMEHUB_VERSION ?? 'dev';
  return v && VERSION_RE.test(v) && VERSION_RE.test(now) && compareVersions(v, now) < 0 ? v : null;
}
