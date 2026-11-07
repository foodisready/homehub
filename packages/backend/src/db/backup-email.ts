import os from 'os';
import { getDb } from './index';
import { BackupError } from './backup-error';
import { BackupKey, encryptBackup, makeBackupKey } from './backup-crypto';
import { HIDDEN, parseBackup, readFull, snapshot } from './json-backup';
import { automationsPaused } from '../automation/pause';
import { EmailMessage, emailConfigured, emailRecipients, sendEmail } from '../notifications/providers/email';
import { VERSION_RE } from '../system/updater';
import { logger } from '../logger';

/**
 * Email an encrypted backup, so a copy survives the computer HomeHub runs on.
 *
 * - By hand: the ⋯ menu on any backup in Settings → Backups.
 * - Automatically, when turned on: a fresh backup every week, and after each
 *   HomeHub update. Not while automations are paused, so a development or
 *   backup copy of HomeHub doesn't send its own.
 *
 * Nothing is ever emailed unencrypted: a backup holds every device login.
 * All these settings belong to this HomeHub only (json-backup's
 * THIS_HOMEHUB_ONLY), so they never travel inside a backup.
 */

const KEY = 'backup_email_key';
const AUTO = 'backup_email_auto';
/** The last attempt, by hand or automatic. */
const LAST = 'backup_email_last';
/** The last automatic email that went out, for spacing them. */
const SENT = 'backup_email_sent';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** After a failed automatic email, wait this long before trying again. */
const RETRY_MS = 6 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const FIRST_CHECK_MS = 2 * 60 * 1000;

export type EmailReason = 'manual' | 'weekly' | 'update';

export interface LastAttempt {
  at: string;
  ok: boolean;
  reason: EmailReason;
  file: string;
  error?: string;
}
interface Sent { at: string; version: string }

export interface BackupEmailStatus {
  /** An email server and at least one recipient are set up. */
  emailReady: boolean;
  recipients: string[];
  passphraseSet: boolean;
  auto: boolean;
  /** Automations are paused here, so automatic emails wait. */
  paused: boolean;
  last: LastAttempt | null;
}

// ── Settings ─────────────────────────────────────────────────────────

function get(key: string): string | null {
  return (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}
function set(key: string, value: string): void {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
function getJson<T>(key: string): T | null {
  const v = get(key);
  if (!v) return null;
  try { return JSON.parse(v) as T; } catch { return null; }
}

function storedKey(): BackupKey | null {
  const k = getJson<BackupKey>(KEY);
  return k && typeof k.key === 'string' && typeof k.salt === 'string' ? k : null;
}

export function backupEmailStatus(): BackupEmailStatus {
  return {
    emailReady: emailConfigured(),
    recipients: emailRecipients(),
    passphraseSet: !!storedKey(),
    auto: get(AUTO) === '1',
    paused: automationsPaused(),
    last: getJson<LastAttempt>(LAST),
  };
}

/**
 * Choose a new passphrase. Backups already emailed keep the passphrase they
 * were sent with.
 */
export async function setBackupPassphrase(passphrase: string): Promise<void> {
  set(KEY, JSON.stringify(await makeBackupKey(passphrase)));
  logger.info('Backup email passphrase set');
}

export function setAutoEmail(on: boolean): void {
  if (on) {
    if (!storedKey()) throw new BackupError('Choose a backup passphrase first');
    if (!emailConfigured()) throw new BackupError('Set up email first, under Settings → Integrations → Email alerts');
  }
  set(AUTO, on ? '1' : '0');
  logger.info({ on }, 'Automatic backup emails changed');
}

// ── Sending ──────────────────────────────────────────────────────────

/** Replaced in tests, so nothing is really sent. */
let send: (msg: EmailMessage) => Promise<void> = sendEmail;
export function setEmailSenderForTests(fn: (msg: EmailMessage) => Promise<void>): void { send = fn; }

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function messageFor(createdAt: string, reason: EmailReason, version: string): string {
  const when = new Date(createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const why = {
    manual: 'You asked HomeHub to email it.',
    weekly: 'HomeHub emails a backup every week.',
    update: `HomeHub emails a backup after each update. This one is from ${version}.`,
  }[reason];
  return [
    `This is an encrypted backup of HomeHub on ${os.hostname()}, made ${when}. ${why}`,
    '',
    "It has your devices, rooms, schedules, scenes, motion rules, users and device logins. It doesn't include energy history, the Wyze camera sign-in or Matter pairings, which you set up again after restoring.",
    '',
    'To restore it, for example on a new computer:',
    '1. Install HomeHub and open it in a browser.',
    '2. Open Settings → Backups and select Upload a backup.',
    '3. Choose the attached file and enter your backup passphrase.',
    '4. Select Restore on it.',
    '',
    "Without the passphrase this file can't be opened, and HomeHub can't recover it. Keep the passphrase somewhere other than HomeHub's computer.",
  ].join('\n');
}

/**
 * Email a backup: a saved one by name, or (without a name) a fresh one made
 * now. Returns where it went.
 */
export async function emailBackup(opts: { name?: string; reason: EmailReason }): Promise<{ file: string; recipients: string[] }> {
  if (!emailConfigured()) throw new BackupError('Set up email first, under Settings → Integrations → Email alerts');
  const key = storedKey();
  if (!key) throw new BackupError('Choose a backup passphrase first, so the email is encrypted', 400, 'PASSPHRASE_NOT_SET');

  let plaintext: string;
  let createdAt: string;
  let base: string;
  if (opts.name) {
    plaintext = readFull(opts.name);
    const data = parseBackup(plaintext);
    if (plaintext.includes(JSON.stringify(HIDDEN))) {
      throw new BackupError(`This backup has ${HIDDEN} in place of some passwords, so it couldn't be restored. Email a different one.`);
    }
    createdAt = typeof data.created_at === 'string' ? data.created_at : new Date().toISOString();
    base = opts.name.replace(/\.json$/, '');
  } else {
    const data = snapshot(opts.reason === 'update' ? 'Emailed after an update' : 'Emailed weekly');
    plaintext = JSON.stringify(data, null, 2) + '\n';
    createdAt = data.created_at;
    base = `homehub-${stamp(new Date(createdAt))}`;
  }

  const version = process.env.HOMEHUB_VERSION ?? 'dev';
  const file = `${base}.encrypted.json`;
  const day = new Date(createdAt).toLocaleDateString('en-US', { dateStyle: 'medium' });
  const attempt: LastAttempt = { at: new Date().toISOString(), ok: false, reason: opts.reason, file };
  try {
    await send({
      subject: `HomeHub backup from ${os.hostname()}, ${day}`,
      text: messageFor(createdAt, opts.reason, version),
      attachments: [{ filename: file, content: encryptBackup(plaintext, key, createdAt), contentType: 'application/json' }],
    });
  } catch (err) {
    const error = (err as Error).message || String(err);
    set(LAST, JSON.stringify({ ...attempt, error }));
    logger.warn({ err, reason: opts.reason }, 'Backup email failed');
    throw new BackupError(`Couldn't send the email: ${error}`, 502, 'EMAIL_FAILED');
  }
  set(LAST, JSON.stringify({ ...attempt, ok: true }));
  if (opts.reason !== 'manual') set(SENT, JSON.stringify({ at: attempt.at, version } satisfies Sent));
  const recipients = emailRecipients();
  logger.info({ file, reason: opts.reason, recipients: recipients.length }, 'Backup emailed');
  return { file, recipients };
}

// ── Automatic ────────────────────────────────────────────────────────

export interface AutoState {
  auto: boolean;
  passphraseSet: boolean;
  emailReady: boolean;
  paused: boolean;
  last: LastAttempt | null;
  sent: Sent | null;
  version: string;
}

/** Why an automatic email is due now, or null when it isn't. */
export function dueReason(now: number, s: AutoState): Exclude<EmailReason, 'manual'> | null {
  if (!s.auto || !s.passphraseSet || !s.emailReady || s.paused) return null;
  if (s.last && !s.last.ok && s.last.reason !== 'manual' && now - Date.parse(s.last.at) < RETRY_MS) return null;
  if (!s.sent) return 'weekly';
  if (VERSION_RE.test(s.version) && s.sent.version !== s.version) return 'update';
  return now - Date.parse(s.sent.at) >= WEEK_MS ? 'weekly' : null;
}

let checking = false;

/** Send an automatic backup email if one is due. Never throws: it runs on a timer. */
export async function checkBackupEmail(now = Date.now()): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const status = backupEmailStatus();
    const reason = dueReason(now, {
      ...status,
      sent: getJson<Sent>(SENT),
      version: process.env.HOMEHUB_VERSION ?? 'dev',
    });
    if (reason) await emailBackup({ reason });
  } catch (err) {
    if (!(err instanceof BackupError)) logger.error({ err }, 'Automatic backup email check failed');
  } finally {
    checking = false;
  }
}

export function startBackupEmails(): void {
  setTimeout(() => { void checkBackupEmail(); }, FIRST_CHECK_MS).unref();
  setInterval(() => { void checkBackupEmail(); }, CHECK_EVERY_MS).unref();
}
