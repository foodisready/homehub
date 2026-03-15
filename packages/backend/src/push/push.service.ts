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

export function sendPushToAll(title: string, body: string, data?: Record<string, unknown>): void {
  init();
  if (!initialized) return;

  const db   = getDb();
  const subs = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all() as PushSubRow[];

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

export const vapidPublicKey = () => process.env.VAPID_PUBLIC_KEY ?? '';
