import fs from 'fs';
import path from 'path';
import { getDb } from '../db';
import { getAllCachedStates } from '../kasa/device.cache';
import { pausedByHand } from '../automation/pause';
import { cameraBridgeInstalled } from '../secrets';
import { getSettings as cameraSettings } from '../cameras/snapshots';
import { bridgeStandby, bridgeUrl, signInSavedAt } from '../cameras/bridge';
import { roleStatus } from './role';
import { pictureHealth } from '../cameras/picture-status';
import { cameraDevices } from '../cameras/watch';
import { addedCameras as ringCameras, ringState } from '../ring/ring';
import { bridgeLastState, bridgeRestartState, bridgeSeenAt, getVoiceSettings, lastBridgeReport, recentBridges } from './voice-bridge';

/**
 * One look at whether HomeHub is working: its services, devices, sensors,
 * backups, disk, voice, and the settings things depend on. Written for
 * someone who isn't technical: each item says what's wrong and what to do.
 */

export type Level = 'ok' | 'warn' | 'error' | 'info';

export interface HealthItem {
  id: string;
  group: 'HomeHub' | 'Devices' | 'Voice' | 'Data' | 'Computer' | 'Settings';
  label: string;
  level: Level;
  detail: string;
  /** A page in the app that helps, such as /settings. */
  link?: string;
  /** Something an admin can do from the Health page. */
  action?: 'restart-voice-bridge';
}

export interface HealthReport {
  status: 'ok' | 'attention' | 'problem';
  checkedAt: string;
  version: string;
  items: HealthItem[];
}

export type Probe = (url: string) => Promise<boolean>;

/** True when something answers at `url` at all, within 2.5 seconds. */
export const httpProbe: Probe = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
    await r.arrayBuffer().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
};

const HOUR = 3_600_000;
export const BRIDGE_LATE_MS = 3 * 60_000;
const startedAt = Date.now();

export function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(ms / HOUR);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(ms / (24 * HOUR))} days ago`;
}

const list = (names: string[], max = 4) =>
  names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`;

function setting(key: string): string | undefined {
  return (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

async function services(probe: Probe): Promise<HealthItem[]> {
  const items: HealthItem[] = [];
  const port = (name: string, fallback: number) => Number(process.env[name]) || fallback;
  const checks: { id: string; label: string; url: string; down: string; level: Level; when?: boolean }[] = [
    {
      id: 'scheduler', label: 'Schedules', level: 'error',
      url: process.env.SCHEDULER_HEALTH_URL || `http://127.0.0.1:${port('SCHEDULER_PORT', 3002)}/health`,
      down: "The schedule service isn't answering, so schedules won't run. Restart HomeHub on its computer.",
    },
    {
      id: 'assistant', label: 'AI assistant connection', level: 'warn',
      url: process.env.MCP_HEALTH_URL || 'http://127.0.0.1:3001/health',
      down: "The service AI assistants connect through isn't answering. HomeHub itself is unaffected.",
    },
    {
      id: 'chat-model', label: 'Chat model', level: 'warn',
      url: `${(process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '')}/api/version`,
      down: "The model Chat uses for open questions isn't answering. Device commands in Chat still work.",
    },
    {
      id: 'cameras', label: 'Cameras', level: 'warn',
      url: `${bridgeUrl()}/api/health`,
      down: "The camera service isn't answering, so cameras won't show.",
      // It waits, not listening, until someone signs in to Wyze on the Cameras page.
      when: cameraBridgeInstalled() && cameraSettings().enabled && signInSavedAt() !== null && !bridgeStandby(),
    },
  ];
  const results = await Promise.all(checks.map((c) => (c.when === false ? Promise.resolve(null) : probe(c.url))));
  checks.forEach((c, i) => {
    const up = results[i];
    if (up === null) return;
    items.push({ id: c.id, group: 'HomeHub', label: c.label, level: up ? 'ok' : c.level, detail: up ? 'Running' : c.down });
  });
  if (process.env.WATCHTOWER_HTTP_API_TOKEN) items.splice(1, 0, await updates(probe));
  return items;
}

/**
 * Updates go through the updater service, which can also go back a version.
 * Installs from before it have only Watchtower until the installer runs again.
 */
async function updates(probe: Probe): Promise<HealthItem> {
  const base: Pick<HealthItem, 'id' | 'group' | 'label'> = { id: 'updater', group: 'HomeHub', label: 'Updates' };
  // Their roots only, never /v1/update or /switch: any answer shows they're running.
  const [updater, watchtower] = await Promise.all([
    probe(`${(process.env.UPDATER_URL || 'http://127.0.0.1:8081').replace(/\/+$/, '')}/health`),
    probe(`${(process.env.WATCHTOWER_URL || 'http://localhost:8080').replace(/\/+$/, '')}/`),
  ]);
  if (updater) return { ...base, level: 'ok', detail: 'Running. HomeHub can update, and go back a version if an update misbehaves.' };
  if (watchtower) {
    return {
      ...base, level: 'info',
      detail: 'Updates work, but this HomeHub can\'t go back a version yet. Once, on the HomeHub computer, run: curl -fsSL https://raw.githubusercontent.com/foodisready/homehub/main/scripts/install.sh | sh',
    };
  }
  return { ...base, level: 'warn', detail: "The update service isn't answering, so the Update button won't work. Run the installer on the HomeHub computer to update." };
}

function devices(): HealthItem[] {
  const rows = getDb().prepare('SELECT id, alias FROM devices ORDER BY alias COLLATE NOCASE').all() as { id: number; alias: string }[];
  if (!rows.length) return [{ id: 'devices', group: 'Devices', label: 'Devices', level: 'info', detail: 'No devices yet.', link: '/settings' }];
  const states = getAllCachedStates();
  const offline = rows.filter((r) => states.get(r.id)?.online === false).map((r) => r.alias);
  const checked = rows.filter((r) => states.has(r.id)).length;
  if (offline.length) {
    return [{
      id: 'devices', group: 'Devices', label: 'Devices', level: 'warn', link: '/dashboard',
      detail: `${offline.length} of ${rows.length} aren't responding: ${list(offline)}. Check they're plugged in and on Wi-Fi.`,
    }];
  }
  if (checked < rows.length) {
    return [{ id: 'devices', group: 'Devices', label: 'Devices', level: 'info', detail: `Checking ${rows.length - checked} of ${rows.length}…` }];
  }
  return [{ id: 'devices', group: 'Devices', label: 'Devices', level: 'ok', detail: `All ${rows.length} are responding` }];
}

/** A camera with no picture for this long is worth mentioning. */
const NO_PICTURE_MS = 10 * 60_000;

function cameraPictures(now: number): HealthItem[] {
  if (!cameraBridgeInstalled() || !cameraSettings().enabled || signInSavedAt() === null || bridgeStandby()) return [];
  const cams = cameraDevices();
  if (!cams.length) return [];
  const states = getAllCachedStates();
  const watching = cams.filter((c) => states.get(c.id)?.state !== false);   // paused cameras send no picture by design
  const failing = watching.filter((c) => {
    const p = pictureHealth(c.cam, now);
    return p.state === 'failing' && p.failingSince !== null && now - p.failingSince >= NO_PICTURE_MS;
  });
  const base: Pick<HealthItem, 'id' | 'group' | 'label' | 'link'> = { id: 'camera-pictures', group: 'Devices', label: 'Cameras', link: '/cameras' };
  if (failing.length) {
    const first = pictureHealth(failing[0].cam, now);
    const since = failing.length === 1 && first.lastOkAt ? ` The last one was ${ago(now - first.lastOkAt)}.` : '';
    return [{ ...base, level: 'warn', detail: `No picture from ${list(failing.map((c) => c.alias))}.${since} The Cameras page says why.` }];
  }
  const recent = watching.filter((c) => pictureHealth(c.cam, now).state === 'failing');
  if (recent.length) return [{ ...base, level: 'info', detail: `No picture from ${list(recent.map((c) => c.alias))} for a few minutes. Checking again…` }];
  const ok = watching.filter((c) => pictureHealth(c.cam, now).state === 'ok').length;
  if (ok < watching.length) return [{ ...base, level: 'info', detail: `Checking ${watching.length - ok} of ${watching.length}…` }];
  return [{ ...base, level: 'ok', detail: watching.length ? `All ${watching.length} sending pictures` : 'All paused' }];
}

function ring(): HealthItem[] {
  const s = ringState();
  if (s.state === 'signed-out' || s.state === 'standby') return [];
  const base: Pick<HealthItem, 'id' | 'group' | 'label' | 'link'> = { id: 'ring', group: 'Devices', label: 'Ring', link: '/cameras' };
  switch (s.state) {
    case 'ready': {
      const n = ringCameras().length;
      return [{ ...base, level: 'ok', detail: n ? `Connected, ${n === 1 ? '1 camera' : `${n} cameras`} in HomeHub` : 'Connected. Add your Ring cameras on the Cameras page.' }];
    }
    case 'connecting': return [{ ...base, level: 'info', detail: 'Connecting…' }];
    case 'expired': return [{ ...base, level: 'warn', detail: 'Ring stopped accepting HomeHub\'s sign-in, so doorbell presses won\'t arrive. Sign in to Ring again on the Cameras page.' }];
    case 'error': return [{ ...base, level: 'warn', detail: `HomeHub can't reach Ring, so doorbell presses won't arrive. It keeps trying. (${s.detail})` }];
  }
}

function sensors(): HealthItem[] {
  const rows = getDb().prepare('SELECT alias, stale_since FROM sensors').all() as { alias: string; stale_since: string | null }[];
  if (!rows.length) return [];
  const stale = rows.filter((r) => r.stale_since).map((r) => r.alias);
  return [stale.length
    ? { id: 'sensors', group: 'Devices', label: 'Water sensors', level: 'warn', link: '/sensors', detail: `Not reporting: ${list(stale)}. Check its power and Wi-Fi.` }
    : { id: 'sensors', group: 'Devices', label: 'Water sensors', level: 'ok', detail: `All ${rows.length} reporting` }];
}

function voice(now: number): HealthItem[] {
  // Only the active server runs voice; a backup's bridge waits by design.
  const enabled = getVoiceSettings().enabled && roleStatus().role === 'active';
  const seen = bridgeSeenAt();
  const report = lastBridgeReport();
  const fresh = report && now - report.at <= BRIDGE_LATE_MS ? report : null;
  // Voice is off and the bridge that comes with HomeHub is waiting for it: nothing to report.
  // A bridge installed with install.sh doesn't wait, so it's reported whatever the setting.
  if (!enabled && (seen === null || bridgeLastState() === 'off')) return [];
  if (!fresh) {
    // Just started: the bridge hasn't had its minute to check in yet.
    if (!report && now - startedAt < BRIDGE_LATE_MS) {
      return [{ id: 'voice-bridge', group: 'Voice', label: 'Voice bridge', level: 'info', detail: 'Waiting for it to check in…' }];
    }
    return [{
      id: 'voice-bridge', group: 'Voice', label: 'Voice bridge', level: 'warn',
      detail: seen === null
        ? "Voice is on, but the voice bridge hasn't checked in. It comes with HomeHub: check that .env doesn't set HOMEHUB_VOICE_BRIDGE=0."
        : `Last heard from ${ago(now - seen)}, so speakers won't answer. On the HomeHub computer, run: docker compose -f docker-compose.yml restart voice-bridge`,
    }];
  }
  const two = recentBridges(now).length > 1
    ? [{
      id: 'voice-bridges', group: 'Voice' as const, label: 'Two voice bridges', level: 'warn' as const,
      detail: 'Two voice bridges are running, so each command may be answered twice. The one installed with install.sh is no longer needed. On the computer it runs on, run: systemctl --user disable --now homehub-voice',
    }]
    : [];
  if (fresh.state === 'off') {
    return [...two, { id: 'voice-bridge', group: 'Voice', label: 'Voice bridge', level: 'info', detail: 'Turning on…' }];
  }
  if (fresh.state === 'starting') {
    return [...two, { id: 'voice-bridge', group: 'Voice', label: 'Voice bridge', level: 'info', detail: 'Starting. The first time, it downloads its speech models, which can take a few minutes.' }];
  }
  const restart = bridgeRestartState();
  if (restart) {
    return [{
      id: 'voice-bridge', group: 'Voice', label: 'Voice bridge', level: 'info',
      detail: restart === 'asked' ? 'Asked to restart. It restarts when it next checks in, within a minute.' : 'Restarting…',
    }];
  }
  const items: HealthItem[] = [...two, {
    id: 'voice-bridge', group: 'Voice', label: 'Voice bridge', level: 'ok', action: 'restart-voice-bridge',
    detail: fresh.version ? `Running (${fresh.version})` : 'Running',
  }];
  if (!fresh.speakers.length) {
    items.push({ id: 'speakers', group: 'Voice', label: 'Speakers', level: 'warn', detail: 'No speakers found. Check the speaker or tablet is on, and the voice app is open.' });
  }
  for (const s of fresh.speakers) {
    items.push({
      id: `speaker:${s.address}`, group: 'Voice', label: s.name, level: s.connected ? 'ok' : 'warn',
      detail: s.connected ? 'Connected' : "Not connected. Check it's on, and on a tablet that the voice app is open and allowed to run in the background.",
    });
  }
  return items;
}

function backups(dataDir: string, now: number): HealthItem[] {
  const dir = path.join(dataDir, 'backups');
  let newest = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^db-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)) continue;
      newest = Math.max(newest, fs.statSync(path.join(dir, f)).mtimeMs);
    }
  } catch { /* no folder yet */ }
  if (!newest) {
    return [{ id: 'backups', group: 'Data', label: 'Nightly backup', level: 'error', link: '/settings', detail: "There's no backup yet. HomeHub makes one each day; if this stays, check its disk." }];
  }
  const age = now - newest;
  return [age > 36 * HOUR
    ? { id: 'backups', group: 'Data', label: 'Nightly backup', level: 'warn', link: '/settings', detail: `The last one was ${ago(age)}. Check the disk has space.` }
    : { id: 'backups', group: 'Data', label: 'Nightly backup', level: 'ok', detail: `Last made ${ago(age)}. It's kept on this computer, so also download a backup now and then from Settings → Backups.` }];
}

function disk(dataDir: string): HealthItem[] {
  try {
    const s = fs.statfsSync(dataDir);
    const free = s.bavail * s.bsize;
    const total = s.blocks * s.bsize;
    const gb = (n: number) => (n / 1e9 >= 10 ? Math.round(n / 1e9) : Math.round(n / 1e8) / 10);
    const pct = total ? free / total : 1;
    const detail = `${gb(free)} GB free of ${gb(total)} GB`;
    if (free < 1e9) return [{ id: 'disk', group: 'Computer', label: 'Disk space', level: 'error', detail: `${detail}. HomeHub can stop saving changes when it's full. Free some space.` }];
    if (free < 3e9 || (pct < 0.05 && free < 10e9)) return [{ id: 'disk', group: 'Computer', label: 'Disk space', level: 'warn', detail: `${detail}. It's getting low.` }];
    return [{ id: 'disk', group: 'Computer', label: 'Disk space', level: 'ok', detail }];
  } catch {
    return [];
  }
}

/** The hottest sensor the computer reports, if it reports any (Linux only). */
export function temperature(root = '/sys/class/thermal'): HealthItem[] {
  let hottest = 0;
  try {
    for (const zone of fs.readdirSync(root)) {
      if (!zone.startsWith('thermal_zone')) continue;
      const milli = Number(fs.readFileSync(path.join(root, zone, 'temp'), 'utf8').trim());
      if (Number.isFinite(milli)) hottest = Math.max(hottest, milli / 1000);
    }
  } catch {
    return [];
  }
  if (!hottest) return [];
  const t = Math.round(hottest);
  if (t >= 85) return [{ id: 'temperature', group: 'Computer', label: 'Temperature', level: 'error', detail: `${t} °C, which is too hot. Give it air, and check its fan.` }];
  if (t >= 75) return [{ id: 'temperature', group: 'Computer', label: 'Temperature', level: 'warn', detail: `${t} °C, which is warm. Make sure air can reach it.` }];
  return [{ id: 'temperature', group: 'Computer', label: 'Temperature', level: 'ok', detail: `${t} °C` }];
}

function settingsChecks(): HealthItem[] {
  const items: HealthItem[] = [];
  const role = roleStatus();
  if (role.role !== 'active') {
    const active = role.other ? ` (the one at ${role.other.address})` : '';
    items.push({ id: 'role', group: 'Settings', label: 'This server', level: 'info', link: '/settings', detail: `A ${role.role === 'dev' ? 'development' : 'backup'} server. Schedules, motion lights, timers, water shutoff, voice and cameras run on the active HomeHub${active}.` });
  } else if (role.other) {
    items.push({ id: 'role', group: 'Settings', label: 'Another active HomeHub', level: 'error', link: '/settings', detail: `The HomeHub at ${role.other.address} also answers to this HomeHub's .local name, so both may be running your schedules. Set one of them to Backup in Settings → This server.` });
  }
  if (pausedByHand()) {
    items.push({ id: 'paused', group: 'Settings', label: 'Automations', level: 'warn', link: '/settings', detail: 'Paused: schedules, motion lights, timers and water shutoff won\'t run until you resume them.' });
  }
  const solar = (getDb().prepare("SELECT COUNT(*) AS n FROM schedules WHERE trigger_type = 'solar' AND enabled = 1").get() as { n: number }).n;
  const hasHome = !!setting('home_latitude') && !!setting('home_longitude');
  if (!hasHome) {
    items.push({
      id: 'location', group: 'Settings', label: 'Home location', level: solar ? 'warn' : 'info', link: '/settings',
      detail: solar
        ? `Not set, so ${solar} sunrise or sunset schedule${solar === 1 ? '' : 's'} may run at the wrong time. Set it in Settings → Home.`
        : 'Not set. Sunrise and sunset schedules need it.',
    });
  }
  return items;
}

const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, ok: 3 };

export async function checkHealth(opts: { probe?: Probe; now?: number; dataDir?: string; thermalRoot?: string } = {}): Promise<HealthReport> {
  const now = opts.now ?? Date.now();
  const dataDir = opts.dataDir ?? path.dirname(process.env.DB_PATH || path.join(process.cwd(), 'data', 'db.sqlite'));
  const items = [
    ...(await services(opts.probe ?? httpProbe)),
    ...devices(),
    ...cameraPictures(now),
    ...ring(),
    ...sensors(),
    ...voice(now),
    ...backups(dataDir, now),
    ...disk(dataDir),
    ...temperature(opts.thermalRoot),
    ...settingsChecks(),
  ];
  const worst = items.reduce((w, i) => Math.min(w, RANK[i.level]), RANK.ok);
  return {
    status: worst === RANK.error ? 'problem' : worst === RANK.warn ? 'attention' : 'ok',
    checkedAt: new Date(now).toISOString(),
    version: process.env.HOMEHUB_VERSION || 'dev',
    items,
  };
}
