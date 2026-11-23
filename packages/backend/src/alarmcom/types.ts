/**
 * What HomeHub needs from Alarm.com, apart from how it's fetched (adc-client.ts does that), so
 * the service (alarmcom.ts) can be tested against a fake.
 */

export type ArmState = 'disarmed' | 'armed-stay' | 'armed-away' | 'armed-night' | 'unknown';
export type ArmCommand = 'disarm' | 'armStay' | 'armAway' | 'armNight';
export type SensorKind = 'door' | 'window' | 'motion' | 'glass' | 'smoke' | 'co' | 'temperature' | 'other';
export type SensorState = 'open' | 'closed' | 'active' | 'idle' | 'wet' | 'dry' | 'unknown';
export type CodeMethod = 'sms' | 'email' | 'app';

export interface AdcPartition {
  id: string;
  name: string;
  state: ArmState;
  /** What it's changing to, while Alarm.com says it's arming or disarming; null when settled. */
  pending: ArmState | null;
  /** The panel offers night arming. */
  canNight: boolean;
  /** The sensors on this partition. */
  sensorIds: string[];
}
export interface AdcSensor {
  id: string;
  name: string;
  kind: SensorKind;
  state: SensorState;
  bypassed: boolean;
  lowBattery: boolean;
  /** When Alarm.com says it last changed, if it says. */
  changedAt: string | null;
}
export interface AdcSnapshot { partitions: AdcPartition[]; sensors: AdcSensor[] }

/** One thing Alarm.com said changed, as it happened (its websocket). */
export type AdcEvent =
  | { kind: 'sensor'; id: string; state: 'open' | 'closed' | 'pulse' }
  | { kind: 'bypass'; id: string; bypassed: boolean }
  | { kind: 'partition'; id: string; state: ArmState }
  /** Something else changed: read everything again. */
  | { kind: 'other' };

export type AdcFailure =
  /** The username or password was refused, or the account can't sign in (locked, say). */
  | 'rejected'
  /** Alarm.com wants two-step verification again: someone has to sign in under Settings. */
  | 'code-needed'
  /** The session ended; signing in again fixes it. */
  | 'expired'
  /** Alarm.com refused a command: not allowed for this login, or the panel said no. */
  | 'refused'
  /** No answer, or Alarm.com is having trouble. */
  | 'unreachable';

export class AdcError extends Error {
  constructor(message: string, readonly kind: AdcFailure, readonly code?: number) { super(message); }
}

/** A signed-in session. */
export interface AdcSession {
  read(): Promise<AdcSnapshot>;
  /** Keeps the session from timing out. Alarm.com expects it every minute. */
  keepAlive(): Promise<void>;
  /** Sends an arm or disarm command. Never retried on its own, so a command is never sent twice. */
  command(partitionId: string, command: ArmCommand, opts: { bypass: boolean }): Promise<void>;
  /**
   * Optional: calls `changed` as soon as Alarm.com says something changed. Returns a function
   * that stops it.
   */
  watch?(changed: (e: AdcEvent) => void, status: (live: boolean, reason?: string) => void): () => void;
  close(): void;
}

/** Two-step verification in progress. */
export interface AdcChallenge {
  /** Asks Alarm.com to send a code; returns where it went ("•••-•••-1234"), if it says. */
  send(method: CodeMethod): Promise<string | null>;
  /** Checks the code and trusts this HomeHub, so later sign-ins skip the code. */
  verify(code: string, method: CodeMethod): Promise<{ session: AdcSession; trust: string | null }>;
}

export type AdcSignIn =
  | { kind: 'ok'; session: AdcSession }
  | { kind: 'code'; methods: CodeMethod[]; sentTo: string | null; challenge: AdcChallenge };

export interface AdcConnector {
  /** Signs in. `trust` is what an earlier verify() returned: with it, Alarm.com skips the code. */
  signIn(username: string, password: string, trust: string | null): Promise<AdcSignIn>;
}
