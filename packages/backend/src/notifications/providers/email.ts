/**
 * Email provider (BYOK SMTP).
 *
 * Phase 2 ships a log-only stub so the router/dispatch path is fully
 * exercisable. Swapping in nodemailer or Resend is a one-file change once
 * the user pastes credentials in settings:
 *
 *   1. add `nodemailer` to deps
 *   2. read SMTP creds from the `settings` table
 *   3. replace `logger.info(...)` below with `transporter.sendMail(...)`
 *
 * The `Notifier` interface stays the same, so `router.ts` is untouched.
 */

import type { Notifier, NotificationPayload } from '../types';
import { logger } from '../../logger';

export class EmailNotifier implements Notifier {
  readonly channel = 'email' as const;

  async send(payload: NotificationPayload): Promise<void> {
    logger.info(
      {
        sensor:    payload.sensorKey,
        level:     payload.level,
        eventId:   payload.eventId,
        ackToken:  payload.ackToken,
      },
      `[email-stub] would send: ${payload.title} — ${payload.body}`,
    );
  }
}
