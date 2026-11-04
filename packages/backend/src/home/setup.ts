import { getDb } from '../db';
import { isProtectedDevice } from '../devices/power';
import { cronProblem } from '../routes/cron-check';

/**
 * First-run setup: the guided steps a new admin goes through after creating
 * their account. HomeHub remembers the step, so setup can be left and resumed.
 */

export const SETUP_STEPS = ['home', 'devices', 'rooms', 'starters', 'family', 'done'] as const;
export type SetupStep = typeof SETUP_STEPS[number];

export interface SetupState {
  /** True once setup was finished or skipped. */
  finished: boolean;
  step: SetupStep;
}

const KEY = 'setup_wizard';

export function getSetupState(): SetupState {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  if (row) {
    try {
      const saved = JSON.parse(row.value) as Partial<SetupState>;
      const step = SETUP_STEPS.includes(saved.step as SetupStep) ? saved.step as SetupStep : 'home';
      return { finished: saved.finished === true, step };
    } catch { /* fall through */ }
  }
  // Homes set up before the wizard existed already have devices: don't send them through it.
  const devices = (getDb().prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n;
  return { finished: devices > 0, step: 'home' };
}

export class SetupStateError extends Error {}

export function saveSetupState(input: { step?: unknown; finished?: unknown }): SetupState {
  const current = getSetupState();
  const next: SetupState = { ...current };
  if (input.step !== undefined) {
    if (!SETUP_STEPS.includes(input.step as SetupStep)) throw new SetupStateError(`step must be one of: ${SETUP_STEPS.join(', ')}`);
    next.step = input.step as SetupStep;
  }
  if (input.finished !== undefined) {
    if (typeof input.finished !== 'boolean') throw new SetupStateError('finished must be true or false');
    next.finished = input.finished;
  }
  getDb().prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(KEY, JSON.stringify(next));
  return next;
}

// ── Starter automations ─────────────────────────────────────────

export const STARTERS = [
  {
    id: 'evening',
    title: 'Evening lights',
    description: 'On at sunset, off at bedtime.',
  },
  {
    id: 'outdoor',
    title: 'Outdoor lights at night',
    description: 'On at sunset, off at sunrise.',
  },
  {
    id: 'goodnight',
    title: 'A "Goodnight" scene',
    description: 'Turns everything chosen off with one tap, or by saying "Goodnight".',
  },
] as const;
export type StarterId = typeof STARTERS[number]['id'];

export interface StarterRequest {
  id: StarterId;
  deviceIds: number[];
  /** Evening lights only: when they go off, "HH:MM" (24-hour). Default 23:00. */
  offTime?: string;
}

export interface StarterResult { schedules: number; scenes: string[] }

export class StarterError extends Error {}

interface DeviceRow { id: number; alias: string; is_protected: number; driver_type: string }

/**
 * Creates the chosen starters in one go: all of them, or none if any is wrong.
 * Protected devices (garage doors, cameras, valves) are refused: a schedule
 * shouldn't open a garage door.
 */
export function createStarters(requests: unknown): StarterResult {
  if (!Array.isArray(requests) || requests.length === 0) throw new StarterError('Choose at least one starter.');
  const db = getDb();
  const result: StarterResult = { schedules: 0, scenes: [] };

  const plan: { device: DeviceRow; label: string; trigger: 'cron' | 'solar'; cron?: string; solar?: string; state: boolean }[] = [];
  const scenes: { name: string; devices: DeviceRow[] }[] = [];

  for (const raw of requests as Partial<StarterRequest>[]) {
    const starter = STARTERS.find((s) => s.id === raw?.id);
    if (!starter) throw new StarterError(`Unknown starter "${String(raw?.id)}".`);
    const ids = Array.isArray(raw.deviceIds) ? [...new Set(raw.deviceIds)] : [];
    if (!ids.length) throw new StarterError(`Choose at least one device for ${starter.title}.`);
    const devices = ids.map((id) => {
      const d = db.prepare('SELECT id, alias, is_protected, driver_type FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
      if (!d) throw new StarterError(`Device ${String(id)} wasn't found.`);
      if (isProtectedDevice(d)) throw new StarterError(`${d.alias} is protected, so starters can't switch it.`);
      return d;
    });

    if (starter.id === 'evening') {
      const off = raw.offTime ?? '23:00';
      const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(off);
      if (!m) throw new StarterError('Choose when the evening lights go off, such as 23:00.');
      const cron = `${Number(m[2])} ${Number(m[1])} * * *`;
      const problem = cronProblem(cron);
      if (problem) throw new StarterError(problem);
      for (const device of devices) {
        plan.push({ device, label: 'Evening lights on', trigger: 'solar', solar: 'sunset', state: true });
        plan.push({ device, label: 'Evening lights off', trigger: 'cron', cron, state: false });
      }
    } else if (starter.id === 'outdoor') {
      for (const device of devices) {
        plan.push({ device, label: 'Outdoor lights on', trigger: 'solar', solar: 'sunset', state: true });
        plan.push({ device, label: 'Outdoor lights off', trigger: 'solar', solar: 'sunrise', state: false });
      }
    } else {
      scenes.push({ name: 'Goodnight', devices });
    }
  }

  db.transaction(() => {
    const insertSchedule = db.prepare(`
      INSERT INTO schedules (device_id, label, trigger_type, cron_expression, solar_event, solar_offset_minutes, state)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `);
    for (const p of plan) {
      insertSchedule.run(p.device.id, p.label, p.trigger, p.cron ?? null, p.solar ?? null, p.state ? 1 : 0);
      result.schedules++;
    }
    for (const s of scenes) {
      // Don't fail over a name already taken: "Goodnight 2" is better than nothing.
      let name = s.name;
      for (let n = 2; db.prepare('SELECT 1 FROM scenes WHERE name = ?').get(name); n++) name = `${s.name} ${n}`;
      const sceneId = db.prepare("INSERT INTO scenes (name, icon) VALUES (?, '🌙')").run(name).lastInsertRowid;
      const insertAction = db.prepare('INSERT INTO scene_actions (scene_id, device_id, state) VALUES (?, ?, 0)');
      for (const d of s.devices) insertAction.run(sceneId, d.id);
      result.scenes.push(name);
    }
  })();
  return result;
}
