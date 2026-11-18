/**
 * The demo's pretend kitchen: its lights, scenes and schedules, the sun, and what a command does.
 * Pure functions, no DOM: the tests run them under Node.
 *
 * Time is in minutes since midnight of the first day (fractions allowed), so a timer set at
 * 11:50 pm for 20 minutes ends at 1450, ten past midnight the next day.
 */
import { LIGHT_IDS } from './commands.js';

export const LIGHTS = [
  { id: 'ceiling',  name: 'Ceiling lights',       detail: '8 recessed LEDs', dimmable: true,  watts: 96 },
  { id: 'counter',  name: 'Under-cabinet lights', detail: '12 LED pucks',    dimmable: false, watts: 27 },
  { id: 'pendants', name: 'Island pendants',      detail: '3 pendants',      dimmable: true,  watts: 24 },
];
export const lightById = (id) => LIGHTS.find((l) => l.id === id);

export const SUNRISE = 6 * 60 + 45;
export const SUNSET = 17 * 60 + 50;
/** After motion, the under-cabinet lights stay on this long once the room is quiet. */
export const MOTION_MINUTES = 5;

const OFF = { ceiling: { on: false }, counter: { on: false }, pendants: { on: false } };

export const SCENES = {
  cooking:    { ceiling: { on: true, level: 100 }, counter: { on: true }, pendants: { on: true, level: 100 } },
  dinner:     { ceiling: { on: true, level: 35 },  counter: { on: true }, pendants: { on: true, level: 70 } },
  nightlight: { ceiling: { on: false },            counter: { on: true }, pendants: { on: false } },
  goodnight:  OFF,
};

/** A household's day: what HomeHub does on its own. `at` is a minute of the day, or the sun. */
export const SCHEDULES = [
  { id: 'breakfast', label: 'Breakfast', at: 6 * 60 + 30, changes: { ceiling: { on: true, level: 70 }, pendants: { on: true, level: 50 } } },
  { id: 'daylight',  label: 'Daylight',  at: { sun: 'sunrise', offset: 30 }, changes: OFF },
  { id: 'sunset',    label: 'Sunset',    at: { sun: 'sunset', offset: 0 }, changes: { counter: { on: true } } },
  { id: 'dinner',    label: 'Dinner',    at: 18 * 60 + 30, scene: 'dinner' },
  { id: 'winddown',  label: 'Wind down', at: 21 * 60 + 30, changes: { ceiling: { on: false }, pendants: { on: true, level: 30 } } },
  { id: 'goodnight', label: 'Goodnight', at: 23 * 60, scene: 'goodnight' },
];

export const allOff = () => ({ ceiling: { on: false, level: 100 }, counter: { on: false, level: 100 }, pendants: { on: false, level: 100 } });

export function applyChanges(lights, changes) {
  const next = { ...lights };
  for (const [id, c] of Object.entries(changes)) {
    next[id] = { on: c.on ?? lights[id].on, level: c.level ?? lights[id].level };
  }
  return next;
}

/** Watts drawn now. A dimmed LED draws roughly its share; even at the bottom it draws a little. */
export function watts(lights) {
  return LIGHTS.reduce((sum, l) => {
    const s = lights[l.id];
    if (!s.on) return sum;
    return sum + l.watts * (l.dimmable ? Math.max(0.08, s.level / 100) : 1);
  }, 0);
}

export const minuteOfDay = (t) => ((t % 1440) + 1440) % 1440;

export function scheduleMinute(s) {
  if (typeof s.at === 'number') return s.at;
  return (s.at.sun === 'sunrise' ? SUNRISE : SUNSET) + (s.at.offset || 0);
}
export const scheduleChanges = (s) => (s.scene ? SCENES[s.scene] : s.changes);

const smooth = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

/** How much daylight there is, 0 (night) to 1 (day), with about an hour of twilight around each. */
export function daylight(t) {
  const m = minuteOfDay(t);
  return Math.min(smooth((m - (SUNRISE - 35)) / 70), 1 - smooth((m - (SUNSET - 35)) / 70));
}

/**
 * The lights and today's energy at a minute of the day, as the schedules would have left them:
 * what the app shows after jumping to a time. Yesterday's schedules set the state at midnight.
 */
export function replayTo(minute, schedules) {
  const events = schedules.filter((s) => s.enabled !== false)
    .map((s) => ({ m: scheduleMinute(s), changes: scheduleChanges(s) }))
    .sort((a, b) => a.m - b.m);
  let lights = allOff();
  for (const e of events) lights = applyChanges(lights, e.changes);
  let wh = 0, i = 0;
  const end = Math.floor(minute);
  for (let t = 0; t < end; t++) {
    while (i < events.length && events[i].m <= t) lights = applyChanges(lights, events[i++].changes);
    wh += watts(lights) / 60;
  }
  while (i < events.length && events[i].m <= end) lights = applyChanges(lights, events[i++].changes);
  return { lights, wh };
}

/** The next time "at 7", "at 7 pm" or "at 19:30" comes round after `now`. */
export function resolveAt({ h, m, period }, now) {
  const day = Math.floor(now / 1440);
  let candidates;
  if (period === 'am') candidates = [(h % 12) * 60 + m];
  else if (period === 'pm') candidates = [((h % 12) + 12) * 60 + m];
  else if (h > 12 || h === 0) candidates = [h * 60 + m];
  else candidates = [(h % 12) * 60 + m, ((h % 12) + 12) * 60 + m];
  const times = candidates.flatMap((c) => [day * 1440 + c, (day + 1) * 1440 + c]).filter((x) => x > now);
  return Math.min(...times);
}

/** Whether a walk into the dark kitchen turns on the under-cabinet lights. */
export function motionTurnsOn(lights, t) {
  return daylight(t) < 0.35 && LIGHT_IDS.every((id) => !lights[id].on);
}

/**
 * What a command does. Returns the changes to make now, any to make later, and what to reply
 * (see replyText in commands.js). `pending` is the lights an earlier "on or off?" was about.
 */
export function plan(r, lights, now, pending = null) {
  if (r.kind === 'ask') return { reply: { kind: 'ask' }, pending: r.targets };
  if (r.kind === 'help' || r.kind === 'elsewhere' || r.kind === 'unknown') return { reply: { kind: r.kind } };
  if (r.kind === 'status') {
    const lit = LIGHTS.filter((l) => lights[l.id].on).map((l) => ({ id: l.id, level: l.dimmable ? lights[l.id].level : null }));
    return { reply: { kind: 'status', lit } };
  }

  const later = (changes, extra) => {
    const at = r.when.type === 'in' ? now + r.when.minutes : resolveAt(r.when, now);
    return { later: [{ at, changes, ...extra }], reply: { ...extra.reply, kind: 'later', when: { ...r.when, atMinute: minuteOfDay(at) } } };
  };

  if (r.kind === 'scene') {
    const changes = SCENES[r.scene];
    if (r.when && r.when.type !== 'for') return later(changes, { scene: r.scene, reply: { scene: r.scene } });
    return { now: changes, scene: r.scene, reply: { kind: 'scene', scene: r.scene } };
  }

  const targets = r.targets.length ? r.targets : pending?.length ? pending : LIGHT_IDS;
  const changes = {};
  for (const id of targets) {
    const light = lightById(id), cur = lights[id];
    if (r.on === false) changes[id] = { on: false };
    else if (r.level !== null) changes[id] = light.dimmable ? { on: true, level: r.level } : { on: true };
    else if (r.relative !== null) {
      if (r.relative < 0 && !cur.on) continue;                // "dimmer" leaves an off light off
      changes[id] = light.dimmable
        ? { on: true, level: Math.max(5, Math.min(100, (cur.on ? cur.level : 0) + r.relative)) }
        : { on: true };
    } else changes[id] = { on: true };
  }
  const dimmed = targets.filter((id) => lightById(id).dimmable && changes[id]?.level !== undefined);
  const verb = r.on === false ? 'off' : (r.level !== null || r.relative !== null) && dimmed.length ? 'level' : 'on';
  const reply = { verb, targets, level: verb === 'level' ? changes[dimmed[0]].level : null };

  if (!r.when) return { now: changes, reply: { ...reply, kind: 'done' } };
  if (r.when.type === 'for') {
    // "On for 10 minutes" ends off and "off for 10 minutes" ends on, whatever they were before,
    // as the reply says. A level for a while goes back to what it was.
    const end = (id) => (verb === 'level' ? { on: lights[id].on, level: lights[id].level } : { on: verb === 'off' });
    const restore = Object.fromEntries(Object.keys(changes).map((id) => [id, end(id)]));
    return { now: changes, later: [{ at: now + r.when.minutes, changes: restore, restore: true }], reply: { ...reply, kind: 'done', when: r.when } };
  }
  return later(changes, { reply });
}
