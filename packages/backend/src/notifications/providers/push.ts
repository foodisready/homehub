import type { Notifier, NotificationPayload } from '../types';
import { sendPushToUsers, sendPushToAll } from '../../push/push.service';
import { getDb } from '../../db';

export class PushNotifier implements Notifier {
  readonly channel = 'push' as const;

  async send(payload: NotificationPayload): Promise<void> {
    const userIds = pushSubscribedUserIdsFromPrefs(payload.level);

    const data = {
      eventId:    payload.eventId,
      sensorId:   payload.sensorId,
      sensorKey:  payload.sensorKey,
      level:      payload.level,
      ackToken:   payload.ackToken,
    };

    if (userIds.length > 0) {
      sendPushToUsers(userIds, payload.title, payload.body, data);
    } else {
      // No explicit per-user prefs configured — broadcast to every push subscription.
      // This is the right default: a leak alert should reach the household.
      sendPushToAll(payload.title, payload.body, data);
    }
  }
}

/**
 * Resolve which users want push at this alert level. Falls back to broadcast
 * when no `notification_preferences` rows exist (caller handles that case).
 */
function pushSubscribedUserIdsFromPrefs(level: number): number[] {
  const rows = getDb().prepare(`
    SELECT DISTINCT np.user_id AS user_id
    FROM notification_preferences np
    WHERE np.channel   = 'push'
      AND np.enabled   = 1
      AND np.min_level <= ?
  `).all(level) as { user_id: number }[];
  return rows.map((r) => r.user_id);
}
