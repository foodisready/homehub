/**
 * BYOK credential management for the notification providers.
 * GET returns config with secrets MASKED (only `hasSecret: bool` flags).
 * PUT writes only the keys present in the body — empty strings clear the
 * setting; missing keys are left untouched.
 *
 * Storage: the existing `settings` table (matches the Tuya pattern).
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { logger } from '../logger';

export const notificationSettingsRouter = Router();

const SMTP_KEYS = [
  'smtp_host', 'smtp_port', 'smtp_secure',
  'smtp_user', 'smtp_pass',
  'smtp_from', 'email_recipients',
] as const;

const TWILIO_KEYS = [
  'twilio_account_sid', 'twilio_auth_token',
  'twilio_from', 'sms_recipients',
] as const;

const SECRET_KEYS = new Set(['smtp_pass', 'twilio_auth_token']);

type SettingKey = typeof SMTP_KEYS[number] | typeof TWILIO_KEYS[number];

function getSetting(key: string): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string } | undefined;
  return row?.value ?? '';
}

function setSetting(key: string, value: string): void {
  getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

// GET /api/notifications/settings — secrets returned as `hasX` booleans.
notificationSettingsRouter.get('/', (_req: Request, res: Response) => {
  const out: Record<string, string | boolean | number> = {};
  for (const key of [...SMTP_KEYS, ...TWILIO_KEYS]) {
    const v = getSetting(key);
    if (SECRET_KEYS.has(key)) {
      out[`has_${key}`] = !!v;
    } else {
      out[key] = v;
    }
  }
  res.json(out);
});

// PUT /api/notifications/settings — only keys present in the body are written.
//   - empty string clears the value
//   - missing keys are left as-is
//   - secret keys, if present and empty, are also cleared (use to revoke)
notificationSettingsRouter.put('/', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Partial<Record<SettingKey, string>>;
  const validKeys = new Set<string>([...SMTP_KEYS, ...TWILIO_KEYS]);

  let written = 0;
  const tx = getDb().transaction((entries: [string, string][]) => {
    for (const [k, v] of entries) {
      setSetting(k, v.trim());
      written++;
    }
  });

  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(body)) {
    if (!validKeys.has(k)) continue;
    if (typeof v !== 'string')   continue;
    entries.push([k, v]);
  }

  tx(entries);
  logger.info({ written, keys: entries.map(([k]) => k) }, 'Notification settings updated');
  res.json({ ok: true, written });
});
