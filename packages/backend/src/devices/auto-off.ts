import { getDb } from '../db';
import { getCachedState } from '../kasa/device.cache';
import { motionStatus, type RuleWithDevice } from '../sensors/motion';

/**
 * When each device that's on will next turn itself off, and why. Three
 * things can do it: a timer someone set, a motion rule once the room is
 * empty, and a "turn off after X minutes" schedule. The earliest wins.
 *
 * Each uses the same rules as the code that acts on it, so the dashboard's
 * countdown matches what happens.
 */

export interface AutoOff {
  /** ISO time it turns off; null while a motion rule waits for the room to empty. */
  at: string | null;
  cause: 'timer' | 'motion' | 'schedule';
  /** The motion rule or schedule's name. */
  detail: string | null;
  /** For a waiting motion rule: minutes after motion stops. */
  afterMinutes?: number;
}

const toMs = (time: string | null) =>
  time ? Date.parse(time.includes('T') ? time : `${time.replace(' ', 'T')}Z`) : NaN;

interface DeviceRow {
  id: number;
  timer_off_at: string | null;
  override_until: string | null;
  turned_on_at: string | null;
}

function isOn(d: DeviceRow): boolean {
  const cached = getCachedState(d.id);
  return cached ? cached.online && cached.state : d.turned_on_at !== null;
}

/** Earlier time wins; a timed turn-off beats one still waiting. */
function better(a: AutoOff | undefined, b: AutoOff): AutoOff {
  if (!a) return b;
  if (a.at === null) return b.at === null ? a : b;
  if (b.at === null) return a;
  return Date.parse(b.at) < Date.parse(a.at) ? b : a;
}

export function pendingAutoOff(now = Date.now()): Map<number, AutoOff> {
  const db = getDb();
  const result = new Map<number, AutoOff>();
  const devices = db.prepare('SELECT id, timer_off_at, override_until, turned_on_at FROM devices').all() as DeviceRow[];
  const on = new Map(devices.filter(isOn).map((d) => [d.id, d]));
  const offer = (id: number, a: AutoOff) => result.set(id, better(result.get(id), a));

  // 1. Timers someone set ("turn off after 1 h").
  for (const d of on.values()) {
    if (d.timer_off_at) offer(d.id, { at: new Date(toMs(d.timer_off_at)).toISOString(), cause: 'timer', detail: null });
  }

  // 2. Motion rules.
  const rules = db.prepare('SELECT d.*, r.* FROM motion_rules r JOIN devices d ON d.id = r.device_id').all() as RuleWithDevice[];
  for (const rule of rules) {
    if (!on.has(rule.device_id)) continue;
    const status = motionStatus(rule, now);
    if (status.kind === 'counting') offer(rule.device_id, { at: status.offAt, cause: 'motion', detail: rule.name });
    else if (status.kind === 'occupied') {
      offer(rule.device_id, { at: null, cause: 'motion', detail: rule.name, afterMinutes: rule.off_after_minutes });
    }
  }

  // 3. "Turn off after X minutes" schedules. The scheduler skips them while a timer or hold is set.
  const schedules = db.prepare(`
    SELECT device_id, label, duration_minutes FROM schedules
    WHERE trigger_type = 'auto_off' AND enabled = 1 AND state = 0
  `).all() as { device_id: number; label: string; duration_minutes: number | null }[];
  for (const s of schedules) {
    const d = on.get(s.device_id);
    if (!d?.turned_on_at || toMs(d.override_until) > now) continue;
    const at = toMs(d.turned_on_at) + (s.duration_minutes ?? 15) * 60_000;
    offer(s.device_id, { at: new Date(at).toISOString(), cause: 'schedule', detail: s.label });
  }

  return result;
}
