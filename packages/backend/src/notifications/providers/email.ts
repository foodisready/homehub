/**
 * Email provider — BYOK SMTP via nodemailer.
 *
 * Reads SMTP credentials from the `settings` table on every send (so the
 * user can update them via the dashboard without restarting). Falls back
 * to a log-only path when no host is configured — same behavior as the
 * pre-Phase-2-followup stub, so existing tests still pass without creds.
 *
 * Settings keys (all optional; SMTP is disabled if `smtp_host` is empty):
 *   smtp_host       e.g. 'smtp.resend.com', 'smtp.gmail.com'
 *   smtp_port       number, default 587
 *   smtp_secure     '1' or '0' (true → port 465 TLS, false → STARTTLS), default '0'
 *   smtp_user       SMTP username
 *   smtp_pass       SMTP password (Resend API key, app password, etc.)
 *   smtp_from       From address; e.g. '"AuraFlow" <alerts@example.com>'
 *   email_recipients  comma-separated list of recipient email addresses
 *
 * Falls back to env vars (SMTP_HOST etc.) when the settings rows are empty.
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { Notifier, NotificationPayload } from '../types';
import { getDb } from '../../db';
import { logger } from '../../logger';

interface SmtpConfig {
  host:        string;
  port:        number;
  secure:      boolean;
  user:        string;
  pass:        string;
  from:        string;
  recipients:  string[];
}

export class EmailNotifier implements Notifier {
  readonly channel = 'email' as const;

  async send(payload: NotificationPayload): Promise<void> {
    const cfg = readSmtpConfig();

    if (!cfg.host || cfg.recipients.length === 0) {
      logger.info(
        { sensor: payload.sensorKey, level: payload.level, eventId: payload.eventId, ackToken: payload.ackToken },
        `[email-stub] would send: ${payload.title} — ${payload.body}`,
      );
      return;
    }

    const transporter = buildTransporter(cfg);
    try {
      await transporter.sendMail({
        from:    fromHeader(cfg.from, cfg.user),
        to:      cfg.recipients.join(','),
        subject: payload.title,
        text:    `${payload.body}\n\nEvent ID: ${payload.eventId}\nLevel: ${payload.level}`,
      });
      logger.info({ eventId: payload.eventId, recipients: cfg.recipients.length }, 'Email sent');
    } finally {
      transporter.close();
    }
  }
}

/** Whether email is set up enough to send: a server and at least one recipient. */
export function emailConfigured(): boolean {
  const cfg = readSmtpConfig();
  return !!cfg.host && cfg.recipients.length > 0;
}

/** The addresses alerts and backups go to. */
export function emailRecipients(): string[] {
  return readSmtpConfig().recipients;
}

export interface EmailMessage {
  subject: string;
  text: string;
  attachments?: { filename: string; content: string; contentType?: string }[];
}

/**
 * Send one email to the alert recipients. Unlike alerts, this throws when
 * email isn't set up or the server refuses, so the caller can say so.
 */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  const cfg = readSmtpConfig();
  if (!cfg.host || cfg.recipients.length === 0) throw new Error('Email is not set up');
  const transporter = buildTransporter(cfg);
  try {
    await transporter.sendMail({
      from:        fromHeader(cfg.from, cfg.user),
      to:          cfg.recipients.join(','),
      subject:     msg.subject,
      text:        msg.text,
      attachments: msg.attachments,
    });
  } finally {
    transporter.close();
  }
}

/**
 * The From header. A name without an address, such as "HomeHub", is sent as
 * that name with the account's address, which servers like Gmail require.
 */
export function fromHeader(from: string, user: string): string {
  const f = from.trim();
  if (!f) return user;
  if (f.includes('@') || !user.includes('@')) return f;
  return `"${f.replace(/"/g, '')}" <${user}>`;
}

function readSmtpConfig(): SmtpConfig {
  const get = (key: string): string => {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? '';
  };
  const orEnv = (settingKey: string, envKey: string): string =>
    get(settingKey) || process.env[envKey] || '';

  const recipientsRaw = orEnv('email_recipients', 'EMAIL_RECIPIENTS');

  return {
    host:       orEnv('smtp_host',     'SMTP_HOST'),
    port:       Number(orEnv('smtp_port', 'SMTP_PORT') || 587),
    secure:     orEnv('smtp_secure',   'SMTP_SECURE') === '1',
    user:       orEnv('smtp_user',     'SMTP_USER'),
    pass:       orEnv('smtp_pass',     'SMTP_PASS'),
    from:       orEnv('smtp_from',     'SMTP_FROM'),
    recipients: recipientsRaw.split(',').map((s) => s.trim()).filter(Boolean),
  };
}

function buildTransporter(cfg: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host:   cfg.host,
    port:   cfg.port,
    secure: cfg.secure,
    auth:   cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
}
