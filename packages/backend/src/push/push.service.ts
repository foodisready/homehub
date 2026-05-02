import webpush from 'web-push';
import { getDb } from '../db';
import { logger } from '../logger';

let initialized = false;

function init(): void {
  if (initialized) return;
  const pub     = process.env.VAPID_PUBLIC_KEY;
  const priv    = process.env.VAPID_PRIVATE_KEY;
  const contact = process.env.VAPID_CONTACT ?? 'mailto:admin@homehub.local';
  if (!pub || !priv) {
    logger.warn('VAPID keys not set — push notifications disabled');
    return;
  }
  webpush.setVapidDetails(contact, pub, priv);
  initialized = true;
}

interface PushSubRow {
  endpoint: string;
  p256dh:   string;
  auth:     string;
}

function dispatchToSubs(subs: PushSubRow[], title: string, body: string, data?: Record<string, unknown>): void {
  init();
  if (!initialized) return;
  const db = getDb();
  const payload = JSON.stringify({ title, body, data });

  for (const sub of subs) {
    webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload,
    ).catch((err: any) => {
      // 410 Gone = subscription expired, remove it
      if (err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
        logger.info({ endpoint: sub.endpoint }, 'Removed expired push subscription');
      } else {
        logger.warn({ err: err.message }, 'Push notification failed');
      }
    });
  }
}

export function sendPushToAll(title: string, body: string, data?: Record<string, unknown>): void {
  const subs = getDb()
    .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions')
    .all() as PushSubRow[];
  dispatchToSubs(subs, title, body, data);
}

/** Targeted push — used by AuraFlow to fan out to all users who opted into a given channel. */
export function sendPushToUsers(userIds: number[], title: string, body: string, data?: Record<string, unknown>): void {
  if (userIds.length === 0) return;
  const placeholders = userIds.map(() => '?').join(',');
  const subs = getDb()
    .prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (${placeholders})`)
    .all(...userIds) as PushSubRow[];
  dispatchToSubs(subs, title, body, data);
}

export const vapidPublicKey = () => process.env.VAPID_PUBLIC_KEY ?? '';
