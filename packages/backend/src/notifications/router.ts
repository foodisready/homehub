/**
 * Notification dispatch — routes a payload to channels per the alert-level
 * matrix and persists a dispatch row per channel for ack tracking.
 *
 * Routing matrix (from docs/notifications.md):
 *   L1: push
 *   L2: push + email
 *   L3: push + email + SMS
 *   Snooze suppresses L1/L2; L3 always fires.
 *   Quiet-hours overrides happen *upstream* in the engine (the engine
 *   produces L3 when a quiet-hours flow is detected); this layer doesn't
 *   re-implement them.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { logger } from '../logger';
import type { AlertLevel } from '../sensors/flow-engine';
import type { Channel, Notifier, NotificationPayload } from './types';
import { PushNotifier } from './providers/push';
import { EmailNotifier } from './providers/email';
import { SmsNotifier } from './providers/sms';

const NOTIFIERS: Notifier[] = [
  new PushNotifier(),
  new EmailNotifier(),
  new SmsNotifier(),
];

export function channelsForLevel(level: AlertLevel): Channel[] {
  if (level >= 3) return ['push', 'email', 'sms'];
  if (level >= 2) return ['push', 'email'];
  if (level >= 1) return ['push'];
  return [];
}

export interface NotifyInput {
  level:        AlertLevel;
  eventId:      number;
  sensorRowId:  number;
  sensorKey:    string;
  sensorAlias:  string;
  rateM3h:      number;
  /** Sensor's snoozed_until ISO string, or null. */
  snoozedUntil: string | null;
}

/**
 * Fire-and-forget: caller does not await. Errors are logged but never
 * thrown (we don't want a notification failure to break ingestion).
 */
export function notify(input: NotifyInput): void {
  const channels = resolveChannels(input);
  if (channels.length === 0) {
    if (input.level >= 1) {
      logger.info({ eventId: input.eventId, level: input.level }, 'Notification suppressed (snoozed)');
    }
    return;
  }

  const message = buildMessage(input);

  // Persist dispatch rows synchronously (we want the ack tokens written
  // before the providers fire so an instant ack-click can find the row).
  const dispatchRows = persistDispatches(input.eventId, input.level, channels);

  // Fire providers in parallel — each is responsible for catching its own
  // errors. We wrap with allSettled to silence any uncaught rejections.
  const sends = channels.map((ch, i) => {
    const notifier = NOTIFIERS.find((n) => n.channel === ch);
    if (!notifier) return Promise.resolve();
    const payload: NotificationPayload = {
      title:        message.title,
      body:         message.body,
      level:        input.level,
      eventId:      input.eventId,
      sensorId:     input.sensorRowId,
      sensorKey:    input.sensorKey,
      sensorAlias:  input.sensorAlias,
      rateM3h:      input.rateM3h,
      ackToken:     dispatchRows[i].ackToken,
    };
    return notifier.send(payload).catch((err) => {
      logger.warn({ err, channel: ch, eventId: input.eventId }, 'Notification provider failed');
    });
  });

  Promise.allSettled(sends).then(() => {
    logger.info(
      { eventId: input.eventId, level: input.level, channels },
      'Notification dispatch complete',
    );
  });
}

function resolveChannels(input: NotifyInput): Channel[] {
  const candidates = channelsForLevel(input.level);
  if (candidates.length === 0) return [];

  // Snooze suppresses L1/L2; L3 always fires.
  if (input.level < 3 && input.snoozedUntil) {
    const until = new Date(input.snoozedUntil.replace(' ', 'T') + 'Z');
    if (until.getTime() > Date.now()) return [];
  }
  return candidates;
}

function buildMessage(input: NotifyInput): { title: string; body: string } {
  const lpm = (input.rateM3h * 1000 / 60).toFixed(1);   // m³/h → L/min
  switch (input.level) {
    case 1:
      return {
        title: `${input.sensorAlias} — water flowing`,
        body:  `Water has been flowing through ${input.sensorAlias} (${lpm} L/min).`,
      };
    case 2:
      return {
        title: `${input.sensorAlias} — water flowing 30+ min`,
        body:  `Water has been flowing through ${input.sensorAlias} for over 30 minutes (${lpm} L/min).`,
      };
    case 3:
      return {
        title: `🚨 ${input.sensorAlias} — possible leak`,
        body:  `Water has been flowing through ${input.sensorAlias} for over an hour (${lpm} L/min). Investigate immediately.`,
      };
    default:
      return { title: input.sensorAlias, body: 'Flow event' };
  }
}

interface DispatchRow {
  id:        number;
  channel:   Channel;
  ackToken:  string;
}

function persistDispatches(eventId: number, level: AlertLevel, channels: Channel[]): DispatchRow[] {
  const db   = getDb();
  const stmt = db.prepare(`
    INSERT INTO notification_dispatches (event_id, channel, level, ack_token)
    VALUES (?, ?, ?, ?)
  `);

  return db.transaction((): DispatchRow[] => {
    const rows: DispatchRow[] = [];
    for (const ch of channels) {
      const token = randomUUID();
      const r = stmt.run(eventId, ch, level, token);
      rows.push({ id: Number(r.lastInsertRowid), channel: ch, ackToken: token });
    }
    return rows;
  })();
}
