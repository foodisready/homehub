import { getDb } from '../db';

/**
 * What voice and Chat say after a command. Admins choose from built-in lines
 * in three styles and add their own, in Settings → Voice replies. HomeHub
 * picks one of the chosen lines at random each time.
 *
 * A reply must still say what changed: lines for switching a device need
 * {device}, and scene lines need {scene}, so a misheard command is noticed
 * whatever the joke. Failures, protected devices and "which one?" questions
 * keep their plain wording and aren't configurable.
 */

export type ReplyMoment = 'on' | 'off' | 'timer' | 'scene' | 'not_understood';
export type ReplyStyle = 'plain' | 'friendly' | 'funny';

export const MOMENTS: { id: ReplyMoment; label: string; placeholders: string[]; required: string | null }[] = [
  { id: 'on',             label: 'Turning something on',       placeholders: ['device'],            required: 'device' },
  { id: 'off',            label: 'Turning something off',      placeholders: ['device'],            required: 'device' },
  { id: 'timer',          label: 'Turning on with a timer',    placeholders: ['device', 'minutes'], required: 'device' },
  { id: 'scene',          label: 'Running a scene',            placeholders: ['scene'],             required: 'scene' },
  { id: 'not_understood', label: "Voice didn't understand",    placeholders: [],                    required: null },
];

export interface BuiltInReply { id: string; moment: ReplyMoment; style: ReplyStyle; text: string }

export const BUILT_IN: BuiltInReply[] = [
  { id: 'on-plain',      moment: 'on', style: 'plain',    text: 'Turned on {device}.' },
  { id: 'on-friendly-1', moment: 'on', style: 'friendly', text: 'Done! {device} is on.' },
  { id: 'on-friendly-2', moment: 'on', style: 'friendly', text: 'You got it. {device} is on.' },
  { id: 'on-funny-1',    moment: 'on', style: 'funny',    text: "{device} is on. You're welcome." },
  { id: 'on-funny-2',    moment: 'on', style: 'funny',    text: 'Let there be light. Specifically, {device}.' },
  { id: 'on-funny-3',    moment: 'on', style: 'funny',    text: '{device} is on. Try not to look directly at it.' },
  { id: 'on-funny-4',    moment: 'on', style: 'funny',    text: '{device}, reporting for duty.' },

  { id: 'off-plain',      moment: 'off', style: 'plain',    text: 'Turned off {device}.' },
  { id: 'off-friendly-1', moment: 'off', style: 'friendly', text: 'Done! {device} is off.' },
  { id: 'off-friendly-2', moment: 'off', style: 'friendly', text: 'All set. {device} is off.' },
  { id: 'off-funny-1',    moment: 'off', style: 'funny',    text: '{device} is off. Saving the planet, one bulb at a time.' },
  { id: 'off-funny-2',    moment: 'off', style: 'funny',    text: '{device} is off. It needed its beauty sleep.' },
  { id: 'off-funny-3',    moment: 'off', style: 'funny',    text: 'Lights out for {device}. Show’s over, folks.' },

  { id: 'timer-plain',      moment: 'timer', style: 'plain',    text: 'Turned on {device} for {minutes}.' },
  { id: 'timer-friendly-1', moment: 'timer', style: 'friendly', text: "{device} is on. I'll turn it off in {minutes}." },
  { id: 'timer-funny-1',    moment: 'timer', style: 'funny',    text: "{device} is on for {minutes}. I'll remember, so you don't have to." },
  { id: 'timer-funny-2',    moment: 'timer', style: 'funny',    text: '{device} is on. It turns into a pumpkin in {minutes}.' },

  { id: 'scene-plain',      moment: 'scene', style: 'plain',    text: 'Ran {scene}.' },
  { id: 'scene-friendly-1', moment: 'scene', style: 'friendly', text: '{scene} is all set.' },
  { id: 'scene-funny-1',    moment: 'scene', style: 'funny',    text: '{scene}, coming right up. Like magic, but with Wi-Fi.' },
  { id: 'scene-funny-2',    moment: 'scene', style: 'funny',    text: "{scene} is done. I'll keep an eye on things. Mostly the lamps." },

  { id: 'not_understood-plain',      moment: 'not_understood', style: 'plain',    text: "Sorry, I didn't understand that." },
  { id: 'not_understood-friendly-1', moment: 'not_understood', style: 'friendly', text: "Sorry, I didn't catch that. Could you say it again?" },
  { id: 'not_understood-funny-1',    moment: 'not_understood', style: 'funny',    text: "That one went right over my head. And I don't even have a head." },
  { id: 'not_understood-funny-2',    moment: 'not_understood', style: 'funny',    text: "I heard words, just not ones I know. Try again?" },
];

export interface MomentChoice { builtIn: string[]; custom: string[] }
export type ReplyChoices = Record<ReplyMoment, MomentChoice>;

const KEY = 'voice_replies';
export const MAX_CUSTOM = 20;
export const MAX_LENGTH = 160;

export class ReplyError extends Error {}

const plainOnly = (): ReplyChoices => Object.fromEntries(
  MOMENTS.map((m) => [m.id, { builtIn: [`${m.id}-plain`], custom: [] }]),
) as unknown as ReplyChoices;

/** The admin's choices, or plain replies (HomeHub's original wording) until they choose. */
export function getReplyChoices(): ReplyChoices {
  const choices = plainOnly();
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  if (!row) return choices;
  try {
    const saved = JSON.parse(row.value) as Partial<Record<string, Partial<MomentChoice>>>;
    for (const m of MOMENTS) {
      const s = saved[m.id];
      if (!s) continue;
      choices[m.id] = {
        builtIn: (s.builtIn ?? []).filter((id) => BUILT_IN.some((b) => b.id === id && b.moment === m.id)),
        custom:  (s.custom ?? []).filter((t): t is string => typeof t === 'string'),
      };
    }
  } catch { /* a bad value falls back to plain replies */ }
  return choices;
}

/** What's wrong with a reply the admin wrote, or null. */
export function replyProblem(moment: ReplyMoment, text: string): string | null {
  const meta = MOMENTS.find((m) => m.id === moment)!;
  if (!text.trim()) return 'A reply can’t be empty.';
  if (text.length > MAX_LENGTH) return `Keep a reply under ${MAX_LENGTH} characters.`;
  for (const [, name] of text.matchAll(/\{(\w+)\}/g)) {
    if (!meta.placeholders.includes(name)) {
      return meta.placeholders.length
        ? `{${name}} isn't available here. Use ${meta.placeholders.map((p) => `{${p}}`).join(' or ')}.`
        : `{${name}} isn't available here.`;
    }
  }
  if (meta.required && !text.includes(`{${meta.required}}`)) {
    return `Include {${meta.required}}, so you always hear what changed.`;
  }
  return null;
}

/** Checks and stores the admin's choices. */
export function saveReplyChoices(input: unknown): ReplyChoices {
  if (!input || typeof input !== 'object') throw new ReplyError('Send the replies for each moment.');
  const body = input as Record<string, unknown>;
  const result = plainOnly();
  for (const m of MOMENTS) {
    const s = body[m.id] as Partial<MomentChoice> | undefined;
    if (!s) continue;
    const builtIn = Array.isArray(s.builtIn) ? s.builtIn : [];
    const custom = Array.isArray(s.custom) ? s.custom : [];
    for (const id of builtIn) {
      if (!BUILT_IN.some((b) => b.id === id && b.moment === m.id)) throw new ReplyError(`Unknown reply "${String(id)}".`);
    }
    if (custom.length > MAX_CUSTOM) throw new ReplyError(`Up to ${MAX_CUSTOM} of your own replies for each moment.`);
    const cleaned: string[] = [];
    for (const raw of custom) {
      if (typeof raw !== 'string') throw new ReplyError('Each reply must be text.');
      const text = raw.trim().replace(/\s+/g, ' ');
      const problem = replyProblem(m.id, text);
      if (problem) throw new ReplyError(`"${text || '(empty)'}": ${problem}`);
      if (!cleaned.includes(text)) cleaned.push(text);
    }
    result[m.id] = { builtIn: [...new Set(builtIn as string[])], custom: cleaned };
  }
  getDb().prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(KEY, JSON.stringify(result));
  return result;
}

/** One of the chosen lines for this moment, filled in. Plain wording if none is chosen. */
export function reply(
  moment: ReplyMoment,
  values: Partial<Record<'device' | 'minutes' | 'scene', string>>,
  { plain = false, random = Math.random }: { plain?: boolean; random?: () => number } = {},
): string {
  // Protected devices (cameras, garage doors, valves) always get the plain confirmation.
  const choice = plain ? { builtIn: [`${moment}-plain`], custom: [] } : getReplyChoices()[moment];
  const lines = [
    ...choice.builtIn.map((id) => BUILT_IN.find((b) => b.id === id)?.text).filter((t): t is string => !!t),
    ...choice.custom,
  ];
  const pool = lines.length ? lines : [BUILT_IN.find((b) => b.id === `${moment}-plain`)!.text];
  const line = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  const filled = line.replace(/\{(\w+)\}/g, (whole, name: string) => values[name as keyof typeof values] ?? whole);
  // A line may start with {device}: "office lamp is on" reads better as "Office lamp is on".
  return filled.charAt(0).toUpperCase() + filled.slice(1);
}
