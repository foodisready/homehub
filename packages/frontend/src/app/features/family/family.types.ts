/** GET /api/family and its parts. Times are the home's local "HH:MM"; days are weekdays, 0 = Sunday. */

export interface Checkin {
  id: number; name: string; enabled: boolean;
  from: string; by: string; days: number[];
  devices: number[] | null; motion: number[] | null; appUsers: string[] | null;
  voice: boolean; water: boolean; pausedUntil: string | null;
  lastDay: string | null; lastResult: 'ok' | 'alerted' | 'all-clear' | 'missed' | null;
  lastSignAt: string | null; lastSign: string | null; alertedAt: string | null;
}

export type VoiceLanguage = 'en' | 'yue' | 'zh' | 'vi';

export interface Reminder {
  id: number; text: string; language: 'auto' | VoiceLanguage; at: string; days: number[]; enabled: boolean;
  lastDay: string | null; lastStatus: string | null; lastSaidAt: string | null;
}

export interface Family {
  checkins: Checkin[];
  reminders: Reminder[];
  audience: { phones: number; people: string[]; emails: number };
  voice: { enabled: boolean; languages: VoiceLanguage[]; speakers: { name: string; connected: boolean; announce: boolean | null }[] };
  users: string[];
  motionRules: { id: number; name: string; ring: boolean }[];
  hasFlowSensor: boolean;
  timezone: string;
}

export interface Sign { at: string; what: string }
export interface PreviewDay { day: string; weekday: number; first: Sign | null; alert: boolean; homehubOff: boolean }

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const LANGUAGE_NAME: Record<VoiceLanguage, string> = { en: 'English', yue: 'Cantonese', zh: 'Mandarin', vi: 'Vietnamese' };

/** "HH:MM" as the person's clock shows it: 9:00 AM, or 09:00. */
export function clockText(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Minutes after midnight. */
export const minutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** "Every day", "Weekdays", "Mon, Wed, Fri". */
export function daysText(days: number[]): string {
  const s = [...days].sort().join('');
  if (s === '0123456') return 'Every day';
  if (s === '12345') return 'Weekdays';
  if (s === '06') return 'Weekends';
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => WEEKDAYS[d]).join(', ');
}

/** A time from the server, in the home's time zone. */
export function timeIn(iso: string, timezone: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: timezone });
}

/** Today in the home's time zone, YYYY-MM-DD. */
export function todayIn(timezone: string): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone });
}

export function errorText(e: unknown, fallback: string): string {
  const err = (e as { error?: { error?: string } })?.error?.error;
  return typeof err === 'string' && err ? err : fallback;
}
