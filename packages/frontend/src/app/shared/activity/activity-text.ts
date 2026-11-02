/** Turning Activity entries into plain words, shared by the Activity page and the dashboard. */

export type ActivitySource =
  | 'app' | 'scene' | 'schedule' | 'timer' | 'motion' | 'chat' | 'voice' | 'assistant' | 'shutoff' | 'outside' | 'homehub';

export interface LastChange {
  state: boolean;
  source: ActivitySource;
  detail: string | null;
  via: ActivitySource | null;
  userName: string | null;
  at: string;
}

export interface ActivityEvent extends LastChange {
  id: number;
  deviceId: number | null;
  deviceName: string;
  driverType: string | null;
  room: string | null;
  kind: 'power' | 'online';
  onForSeconds: number | null;
}

/** "turned on", "opened", "resumed"… for the device's kind. */
export function actionWord(driverType: string | null, state: boolean): string {
  if (driverType === 'meross') return state ? 'opened' : 'closed';
  if (driverType === 'wyze') return state ? 'resumed watching' : 'paused';
  return state ? 'turned on' : 'turned off';
}

const VIA: Partial<Record<ActivitySource, string>> = { chat: 'from Chat', voice: 'by voice', app: 'in the app', assistant: 'by the AI assistant' };

/** What caused it, e.g. "by schedule Evening", "outside HomeHub", "by alice". */
export function causeText(c: Pick<LastChange, 'source' | 'detail' | 'via' | 'userName'>): string {
  const who = c.userName ? ` by ${c.userName}` : '';
  switch (c.source) {
    case 'app': return c.userName ? `by ${c.userName}` : 'in the app';
    case 'scene': return `by scene ${c.detail ?? ''}`.trim() + (c.via && VIA[c.via] ? `, ${VIA[c.via]}` : '') + (c.via === 'chat' || c.via === 'app' ? who : '');
    case 'schedule': return c.detail ? `by schedule ${c.detail}` : 'by a schedule';
    case 'timer': return 'when its timer ended';
    case 'motion': return c.detail ? `by motion (${c.detail})` : 'by motion';
    case 'chat': return `from Chat${who}`;
    case 'voice': return 'by voice';
    case 'assistant': return 'by the AI assistant';
    case 'shutoff': return 'by automatic water shutoff';
    case 'outside': return 'outside HomeHub';
    default: return c.detail ? `by HomeHub (${c.detail})` : 'by HomeHub';
  }
}

/** "2 h 14 min", "45 s" */
export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h < 48) return m ? `${h} h ${m} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/** "Porch turned off" / "Garage door went offline" */
export function eventTitle(e: ActivityEvent): string {
  if (e.kind === 'online') return `${e.deviceName} ${e.state ? 'came back online' : 'went offline'}`;
  return `${e.deviceName} ${actionWord(e.driverType, e.state)}`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "6:12 PM" today, "Yesterday 6:12 PM", or "Nov 1, 6:12 PM". */
export function when(iso: string): string {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return clock(iso);
  if (d.toDateString() === new Date(now.getTime() - 86_400_000).toDateString()) return `yesterday ${clock(iso)}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${clock(iso)}`;
}
