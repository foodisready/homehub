/**
 * What happened, from Activity: "what got turned on between midnight and 5 this morning?",
 * "what turned the porch light off last night?", "when did the garage door last close?".
 *
 * Read only. Times go to the model and back in the home's time zone, as a person says them; the
 * log itself is in UTC. Offered to Claude only, like the setup tools (setup-tools.ts).
 */
import { listActivity, type ActivityEvent } from '../activity/activity';
import { getHomeSettings } from '../home/home-settings';
import { findDeviceByName, findDeviceGroup } from './find-device';

export const HISTORY_TOOL = {
  type: 'function',
  function: {
    name: 'get_activity',
    description: 'Look up what happened to devices: what was switched on or off, when, and by what (the app and who, a schedule, a motion light, '
      + 'a timer, Chat, voice, a scene, or a wall switch or the device’s own app). Use for questions about the past, such as '
      + '"what got turned on overnight?" or "what turned the porch light off?". Times are in the home’s time zone.',
    parameters: {
      type: 'object',
      properties: {
        from:   { type: 'string', description: 'Start, in the home’s time zone, "YYYY-MM-DD HH:MM". Leave out for the last 24 hours.' },
        to:     { type: 'string', description: 'End, in the home’s time zone, "YYYY-MM-DD HH:MM". Leave out for now.' },
        device: { type: 'string', description: 'A device, room or shared name to look at. Leave out for every device.' },
        state:  { type: 'string', enum: ['on', 'off', 'any'], description: 'Only switching on, only off, or both (the default)' },
        newest_first: { type: 'boolean', description: 'True for the latest changes first, e.g. "when did it last close?". Default: in time order.' },
      },
    },
  },
} as const;

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/;

/** Minutes the zone is ahead of UTC at this instant. */
function offsetMinutes(ms: number, timeZone: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(ms).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** "2026-11-22 05:00" on the home's clock, as an instant; null if it isn't one. */
export function fromLocal(text: string, timeZone: string): number | null {
  const m = LOCAL.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Twice, so a time near a daylight-saving change lands on the right side of it.
  let at = guess - offsetMinutes(guess, timeZone) * 60_000;
  at = guess - offsetMinutes(at, timeZone) * 60_000;
  return at;
}

const SOURCE: Record<string, string> = {
  app: 'the app', scene: 'a scene', schedule: 'a schedule', timer: 'a timer', motion: 'a motion light', chat: 'Chat', voice: 'voice',
  assistant: 'an AI assistant', shutoff: 'the automatic water shutoff', away: 'Away mode',
  outside: 'outside HomeHub: a wall switch, the device’s own app or remote, or the device itself', homehub: 'HomeHub',
};

/** "the app (Anna)", "a schedule (Porch on at sunset)", "a scene (Goodnight), from Chat". */
export function byWords(e: Pick<ActivityEvent, 'source' | 'detail' | 'via' | 'userName'>): string {
  const who = SOURCE[e.source] ?? e.source;
  const named = e.userName ?? e.detail;
  const via = e.via && e.via !== e.source ? `, from ${SOURCE[e.via] ?? e.via}` : '';
  return `${who}${named ? ` (${named})` : ''}${via}`;
}

const MAX = 60;

export function runHistoryTool(args: Record<string, unknown>, now = Date.now()): unknown {
  const tz = getHomeSettings().timezone;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const fromText = str(args['from']), toText = str(args['to']);
  const from = fromText ? fromLocal(fromText, tz) : now - 24 * 3_600_000;
  const to = toText ? fromLocal(toText, tz) : now;
  if (from === null || to === null) return { error: 'from and to must be "YYYY-MM-DD HH:MM" in the home’s time zone' };
  if (from >= to) return { error: 'from must be before to' };

  let deviceIds: number[] | undefined;
  const name = str(args['device']);
  if (name) {
    const group = findDeviceGroup(name) as unknown as { id: number }[];
    if (group.length) deviceIds = group.map((d) => d.id);
    else {
      const one = findDeviceByName(name);
      if ('error' in one) return { error: one.error };
      deviceIds = [Number((one.device as { id: number }).id)];
    }
  }

  const state = args['state'] === 'on' ? true : args['state'] === 'off' ? false : null;
  const newest = args['newest_first'] === true;
  // Newest first from the log; enough to cover a busy night, then trimmed.
  const rows = listActivity({ kind: 'power', from: new Date(from).toISOString(), to: new Date(to).toISOString(), deviceIds, limit: 200 })
    .filter((e) => state === null || e.state === state)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const picked = newest ? rows.slice(0, MAX) : rows.slice(0, MAX).reverse();
  const clock = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return {
    timezone: tz,
    from: clock.format(from), to: clock.format(to),
    changes: picked.map((e) => ({
      at: clock.format(Date.parse(e.at)),
      device: e.deviceName,
      // A garage door opens and closes; a camera watches or is paused.
      state: e.driverType === 'meross' ? (e.state ? 'opened' : 'closed') : e.driverType === 'wyze' ? (e.state ? 'watching' : 'paused') : e.state ? 'on' : 'off',
      by: byWords(e),
      ...(e.onForSeconds !== null ? { wasOnFor: `${Math.round(e.onForSeconds / 60)} min` } : {}),
    })),
    ...(rows.length > MAX ? { note: `Only ${MAX} of ${rows.length >= 200 ? 'more than 200' : rows.length} changes are listed: ask about a shorter time or one device.` } : {}),
    ...(rows.length === 0 ? { note: 'Nothing was switched then. Activity is kept for 90 days unless changed in Settings.' } : {}),
  };
}
