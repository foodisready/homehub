import type { AlertLevel } from '../sensors/flow-engine';

export type Channel = 'push' | 'email' | 'sms' | 'voice';

export interface NotificationPayload {
  title:        string;
  body:         string;
  level:        AlertLevel;
  eventId:      number;
  sensorId:     number;
  sensorKey:    string;
  sensorAlias:  string;
  rateM3h:      number;
  /** Token tied to a specific dispatch row — used by the public ack endpoint. */
  ackToken?:    string;
}

export interface Notifier {
  readonly channel: Channel;
  send(payload: NotificationPayload): Promise<void>;
}
