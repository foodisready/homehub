/**
 * SMS provider (BYOK Twilio).
 *
 * Phase 2 ships a log-only stub so the router/dispatch path is fully
 * exercisable. Swapping in Twilio is a one-file change once the user
 * pastes Account SID + Auth Token in settings:
 *
 *   1. add `twilio` to deps
 *   2. read Twilio creds from the `settings` table
 *   3. replace `logger.info(...)` below with `client.messages.create(...)`
 *
 * The `Notifier` interface stays the same, so `router.ts` is untouched.
 */

import type { Notifier, NotificationPayload } from '../types';
import { logger } from '../../logger';

export class SmsNotifier implements Notifier {
  readonly channel = 'sms' as const;

  async send(payload: NotificationPayload): Promise<void> {
    logger.warn(
      {
        sensor:    payload.sensorKey,
        level:     payload.level,
        eventId:   payload.eventId,
        ackToken:  payload.ackToken,
      },
      `[sms-stub] CRITICAL would SMS: ${payload.title} — ${payload.body}`,
    );
  }
}
