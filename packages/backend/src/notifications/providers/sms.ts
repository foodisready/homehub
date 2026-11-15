/**
 * SMS provider — BYOK Twilio via direct REST API call.
 *
 * Skips the Twilio SDK to keep the dependency tree small (~80 transitive
 * deps avoided). The Twilio Messages API is straightforward: POST to
 * /2010-04-01/Accounts/{SID}/Messages.json with HTTP Basic auth and
 * URL-encoded form body.
 *
 * Settings keys (SMS is disabled if `twilio_account_sid` is empty):
 *   twilio_account_sid   Twilio Account SID (starts with 'AC')
 *   twilio_auth_token    Twilio Auth Token
 *   twilio_from          From number in E.164 (e.g. '+15555551234')
 *   sms_recipients       comma-separated list of recipient numbers (E.164)
 *
 * Falls back to env vars (TWILIO_ACCOUNT_SID etc.) when settings are empty.
 * If neither is set, falls back to log-only — preserving Phase 2 stub
 * behavior so existing tests still pass.
 */

import type { Notifier, NotificationPayload } from '../types';
import { getDb } from '../../db';
import { logger } from '../../logger';

export interface TwilioConfig {
  accountSid:  string;
  authToken:   string;
  from:        string;
  recipients:  string[];
}

export class SmsNotifier implements Notifier {
  readonly channel = 'sms' as const;

  async send(payload: NotificationPayload): Promise<void> {
    const cfg = readTwilioConfig();

    if (!cfg.accountSid || !cfg.from || cfg.recipients.length === 0) {
      logger.warn(
        { sensor: payload.sensorKey, level: payload.level, eventId: payload.eventId, ackToken: payload.ackToken },
        `[sms-stub] CRITICAL would SMS: ${payload.title} — ${payload.body}`,
      );
      return;
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`;
    const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64');

    // SMS-trim: Twilio messages over 160 chars get billed multi-segment.
    const text = `${payload.title}\n${payload.body}`.slice(0, 480);

    // Twilio sends per-recipient; fan out in parallel and tolerate per-recipient failures.
    const results = await Promise.allSettled(cfg.recipients.map(async (to) => {
      const body = new URLSearchParams({ To: to, From: cfg.from, Body: text });
      const res  = await fetch(url, {
        method:  'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type':  'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Twilio ${res.status}: ${errText.slice(0, 200)}`);
      }
    }));

    const failures = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    if (failures.length > 0) {
      logger.warn(
        { eventId: payload.eventId, total: cfg.recipients.length, failed: failures.length, errors: failures.map((f) => String(f.reason)) },
        'Some SMS sends failed',
      );
    } else {
      logger.info({ eventId: payload.eventId, recipients: cfg.recipients.length }, 'SMS sent');
    }
  }
}

export function readTwilioConfig(): TwilioConfig {
  const get = (key: string): string => {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? '';
  };
  const orEnv = (settingKey: string, envKey: string): string =>
    get(settingKey) || process.env[envKey] || '';

  const recipientsRaw = orEnv('sms_recipients', 'SMS_RECIPIENTS');

  return {
    accountSid: orEnv('twilio_account_sid', 'TWILIO_ACCOUNT_SID'),
    authToken:  orEnv('twilio_auth_token',  'TWILIO_AUTH_TOKEN'),
    from:       orEnv('twilio_from',        'TWILIO_FROM'),
    recipients: recipientsRaw.split(',').map((s) => s.trim()).filter(Boolean),
  };
}

/** Twilio is set up enough to send texts or make calls. */
export const twilioReady = (cfg = readTwilioConfig()): boolean => !!(cfg.accountSid && cfg.authToken && cfg.from && cfg.recipients.length);

const twilio = async (cfg: TwilioConfig, resource: 'Messages' | 'Calls', form: Record<string, string>): Promise<void> => {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/${resource}.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
};

/** A text to each number in the SMS list. Returns how many went. */
export async function sendTexts(text: string, cfg = readTwilioConfig()): Promise<number> {
  if (!twilioReady(cfg)) return 0;
  const results = await Promise.allSettled(cfg.recipients.map((to) => twilio(cfg, 'Messages', { To: to, From: cfg.from, Body: text.slice(0, 480) })));
  const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  if (failed.length) logger.warn({ failed: failed.length, errors: failed.map((f) => String(f.reason)) }, 'Some texts failed');
  return results.length - failed.length;
}

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));

/**
 * A phone call to one number that says `text` twice in Twilio's voice. The words go in the
 * request (TwiML), so Twilio never has to reach HomeHub.
 */
export async function placeCall(to: string, text: string, cfg = readTwilioConfig()): Promise<void> {
  const say = `<Say voice="Polly.Joanna">${xml(text)}</Say>`;
  await twilio(cfg, 'Calls', { To: to, From: cfg.from, Twiml: `<Response>${say}<Pause length="1"/>${say}</Response>` });
}
