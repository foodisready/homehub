/**
 * Encrypted backups and backup emails, against a temp SQLite DB with a fake
 * email sender: nothing is really sent.
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this file
 * stays on its temp DB even under a runner that hoists static imports.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-backup-email-test-'));
const BACKUP_DIR = path.join(TMP_BASE, 'backups');
const PASS = 'correct horse battery';
const DAY = 24 * 60 * 60 * 1000;

let getDb: () => Database.Database;
let jb: typeof import('./json-backup');
let bc: typeof import('./backup-crypto');
let be: typeof import('./backup-email');

type Sent = import('../notifications/providers/email').EmailMessage;
let outbox: Sent[] = [];
let failWith: string | null = null;

const db = () => getDb();
const setting = (key: string) => (db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
const putSetting = (key: string, value: string) =>
  db().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

async function rejectsWithCode(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (err: { code?: string }) => err.code === code);
}

describe('backup emails', () => {
  const savedVersion = process.env.HOMEHUB_VERSION;

  before(async () => {
    process.env.DB_PATH = path.join(TMP_BASE, 'db.sqlite');
    ({ getDb } = await import('./index'));
    jb = await import('./json-backup');
    bc = await import('./backup-crypto');
    be = await import('./backup-email');
    getDb();
    be.setEmailSenderForTests(async (msg) => {
      if (failWith) throw new Error(failWith);
      outbox.push(msg);
    });
  });

  after(() => {
    if (savedVersion === undefined) delete process.env.HOMEHUB_VERSION; else process.env.HOMEHUB_VERSION = savedVersion;
    getDb().close();
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    db().pragma('foreign_keys = OFF');
    for (const t of ['schedules', 'settings', 'devices', 'users']) db().prepare(`DELETE FROM ${t}`).run();
    db().pragma('foreign_keys = ON');
    db().prepare("INSERT INTO users (id, name, password_hash, role) VALUES (1, 'admin', 'bcrypt-hash', 'admin')").run();
    db().prepare(`INSERT INTO devices (id, alias, ip, driver_type, driver_config) VALUES (1, 'Kitchen lights', '10.0.0.1', 'shelly', ?)`)
      .run(JSON.stringify({ auth: { user: 'admin', pass: 'shelly-pass' } }));
    outbox = [];
    failWith = null;
    process.env.HOMEHUB_VERSION = 'v0.1.30';
  });

  const setUpEmail = () => {
    putSetting('smtp_host', 'smtp.example.test');
    putSetting('email_recipients', 'me@example.test');
  };

  describe('encryption', () => {
    it('round-trips with the passphrase, ignoring spaces at either end', async () => {
      const key = await bc.makeBackupKey(PASS);
      const file = bc.encryptBackup('{"hello":"world"}', key, '2026-11-07T10:00:00.000Z');
      assert.ok(!file.includes('world'), 'the content is not readable');
      const enc = bc.asEncrypted(file);
      assert.ok(enc);
      assert.equal(await bc.decryptBackup(enc, `  ${PASS} `), '{"hello":"world"}');
    });

    it('refuses a wrong or missing passphrase, and a changed file', async () => {
      const key = await bc.makeBackupKey(PASS);
      const file = bc.encryptBackup('{"a":1}', key, '2026-11-07T10:00:00.000Z');
      await rejectsWithCode(bc.decryptBackup(bc.asEncrypted(file)!, 'wrong horse battery'), 'PASSPHRASE_WRONG');
      await rejectsWithCode(bc.decryptBackup(bc.asEncrypted(file)!, undefined), 'PASSPHRASE_REQUIRED');

      const changedDate = { ...bc.asEncrypted(file)!, created_at: '2020-01-01T00:00:00.000Z' };
      await rejectsWithCode(bc.decryptBackup(changedDate, PASS), 'PASSPHRASE_WRONG');

      const enc = bc.asEncrypted(file)!;
      const data = Buffer.from(enc.data, 'base64');
      data[0] ^= 1;
      await rejectsWithCode(bc.decryptBackup({ ...enc, data: data.toString('base64') }, PASS), 'PASSPHRASE_WRONG');
    });

    it('refuses short or repetitive passphrases', async () => {
      await rejectsWithCode(bc.makeBackupKey('short'), 'PASSPHRASE_WEAK');
      await rejectsWithCode(bc.makeBackupKey('aaaaaaaaaaaaaa'), 'PASSPHRASE_WEAK');
    });

    it('refuses scrypt settings that would use too much memory', async () => {
      const key = await bc.makeBackupKey(PASS);
      const enc = bc.asEncrypted(bc.encryptBackup('{}', key, '2026-11-07T10:00:00.000Z'))!;
      await assert.rejects(bc.decryptBackup({ ...enc, kdf: { ...enc.kdf, N: 2 ** 24 } }, PASS), /damaged|newer/);
    });

    it('tells plain backups from encrypted ones', () => {
      assert.equal(bc.asEncrypted('{"format":"homehub-backup"}'), null);
      assert.equal(bc.asEncrypted('not json'), null);
    });
  });

  describe('sending', () => {
    it('needs email set up and a passphrase, and never sends unencrypted', async () => {
      await assert.rejects(be.emailBackup({ reason: 'manual' }), /Set up email/);
      setUpEmail();
      await rejectsWithCode(be.emailBackup({ reason: 'manual' }), 'PASSPHRASE_NOT_SET');
      assert.equal(outbox.length, 0);
    });

    it('emails a saved backup that restores with the passphrase', async () => {
      setUpEmail();
      await be.setBackupPassphrase(PASS);
      const { name } = jb.createBackup('before the move');

      const result = await be.emailBackup({ name, reason: 'manual' });

      assert.deepEqual(result.recipients, ['me@example.test']);
      assert.equal(outbox.length, 1);
      const [attachment] = outbox[0].attachments!;
      assert.equal(attachment.filename, name.replace(/\.json$/, '.encrypted.json'));
      assert.ok(!attachment.content.includes('shelly-pass'), 'device logins are not readable in the email');
      assert.match(outbox[0].text, /Upload a backup/);

      const plain = await bc.decryptBackup(bc.asEncrypted(attachment.content)!, PASS);
      assert.equal(plain, jb.readFull(name), 'the attachment is exactly the saved backup');
      db().prepare('DELETE FROM devices').run();
      const uploaded = jb.importBackup(plain);
      jb.restoreBackup(uploaded.name);
      assert.equal((db().prepare('SELECT alias FROM devices').get() as { alias: string }).alias, 'Kitchen lights');

      const last = be.backupEmailStatus().last!;
      assert.equal(last.ok, true);
      assert.equal(last.reason, 'manual');
    });

    it('keeps the key and email settings out of backups, and a restore keeps them', async () => {
      setUpEmail();
      await be.setBackupPassphrase(PASS);
      be.setAutoEmail(true);
      const keyBefore = setting('backup_email_key');

      const { name } = jb.createBackup();
      const keys = JSON.parse(jb.readFull(name)).tables.settings.map((r: { key: string }) => r.key);
      assert.ok(keys.includes('smtp_host'));
      assert.ok(!keys.some((k: string) => k.startsWith('backup_email_')), `no backup_email_ settings in ${keys.join(', ')}`);

      jb.restoreBackup(name);
      assert.equal(setting('backup_email_key'), keyBefore);
      assert.equal(setting('backup_email_auto'), '1');
    });

    it('records a failed send and says why', async () => {
      setUpEmail();
      await be.setBackupPassphrase(PASS);
      failWith = 'Invalid login: 535 Authentication failed';
      await assert.rejects(be.emailBackup({ reason: 'manual' }), (err: { code?: string; message: string }) =>
        err.code === 'EMAIL_FAILED' && /535/.test(err.message));
      const last = be.backupEmailStatus().last!;
      assert.equal(last.ok, false);
      assert.match(last.error!, /535/);
    });

    it("won't turn on automatic emails without a passphrase and email", async () => {
      assert.throws(() => be.setAutoEmail(true), /passphrase/);
      await be.setBackupPassphrase(PASS);
      assert.throws(() => be.setAutoEmail(true), /Set up email/);
      be.setAutoEmail(false);
    });
  });

  describe('passphrase hint', () => {
    it('goes in the email and the file, and is shown when the passphrase is asked for', async () => {
      setUpEmail();
      await be.setBackupPassphrase(PASS, 'the horse and the battery');
      assert.equal(be.backupEmailStatus().hint, 'the horse and the battery');
      await be.emailBackup({ reason: 'manual' });
      assert.match(outbox[0].text, /Your hint: "the horse and the battery"/);
      const enc = bc.asEncrypted(outbox[0].attachments![0].content)!;
      assert.equal(enc.hint, 'the horse and the battery');
      await assert.rejects(bc.decryptBackup(enc, undefined), (err: { code?: string; extra?: { hint?: string } }) =>
        err.code === 'PASSPHRASE_REQUIRED' && err.extra?.hint === 'the horse and the battery');
      await assert.rejects(bc.decryptBackup(enc, 'not it at all'), (err: { code?: string; extra?: { hint?: string } }) =>
        err.code === 'PASSPHRASE_WRONG' && err.extra?.hint === 'the horse and the battery');
      assert.ok(await bc.decryptBackup(enc, PASS), 'the hint does not stop the file opening');
    });

    it('refuses a hint that gives the passphrase away, even with different spacing or case', async () => {
      await rejectsWithCode(be.setBackupPassphrase(PASS, `it is ${PASS}`), 'HINT_INVALID');
      await rejectsWithCode(be.setBackupPassphrase(PASS, 'CorrectHorse-Battery!'), 'HINT_INVALID');
      await rejectsWithCode(be.setBackupPassphrase(PASS, 'x'.repeat(101)), 'HINT_INVALID');
      assert.equal(be.backupEmailStatus().passphraseSet, false, 'nothing is saved when the hint is refused');
    });

    it('a new passphrase without a hint clears the old hint, and the hint stays out of backups', async () => {
      await be.setBackupPassphrase(PASS, 'old reminder');
      const { name } = jb.createBackup();
      const keys = JSON.parse(jb.readFull(name)).tables.settings.map((r: { key: string }) => r.key);
      assert.ok(!keys.includes('backup_email_hint'));
      await be.setBackupPassphrase('a different passphrase');
      assert.equal(be.backupEmailStatus().hint, '');
    });
  });

  describe('automatic emails', () => {
    const base = {
      auto: true, passphraseSet: true, emailReady: true, paused: false, last: null, sent: null, version: 'v0.1.30',
    };
    const now = Date.parse('2026-11-20T12:00:00Z');
    const ago = (ms: number) => new Date(now - ms).toISOString();

    it('sends the first one straight away, then weekly', () => {
      assert.equal(be.dueReason(now, base), 'weekly');
      assert.equal(be.dueReason(now, { ...base, sent: { at: ago(6 * DAY), version: 'v0.1.30' } }), null);
      assert.equal(be.dueReason(now, { ...base, sent: { at: ago(7 * DAY), version: 'v0.1.30' } }), 'weekly');
    });

    it('sends one after an update, but not for a development build', () => {
      const sent = { at: ago(DAY), version: 'v0.1.29' };
      assert.equal(be.dueReason(now, { ...base, sent }), 'update');
      assert.equal(be.dueReason(now, { ...base, sent, version: 'dev' }), null);
    });

    it('waits while off, paused or not set up, and after a failure', () => {
      assert.equal(be.dueReason(now, { ...base, auto: false }), null);
      assert.equal(be.dueReason(now, { ...base, paused: true }), null);
      assert.equal(be.dueReason(now, { ...base, passphraseSet: false }), null);
      assert.equal(be.dueReason(now, { ...base, emailReady: false }), null);
      const failed = { at: ago(60 * 60 * 1000), ok: false, reason: 'weekly' as const, file: 'x', error: 'down' };
      assert.equal(be.dueReason(now, { ...base, last: failed }), null);
      assert.equal(be.dueReason(now, { ...base, last: { ...failed, at: ago(7 * 60 * 60 * 1000) } }), 'weekly');
      assert.equal(be.dueReason(now, { ...base, last: { ...failed, reason: 'manual' } }), 'weekly', 'a failed manual email does not hold back the weekly one');
    });

    it('sends a fresh backup once, and again after an update', async () => {
      setUpEmail();
      await be.setBackupPassphrase(PASS);
      be.setAutoEmail(true);

      await be.checkBackupEmail();
      await be.checkBackupEmail();
      assert.equal(outbox.length, 1, 'once, not on every check');
      assert.match(outbox[0].attachments![0].filename, /^homehub-\d{4}-\d{2}-\d{2}-\d{6}\.encrypted\.json$/);
      assert.equal(jb.listBackups().length, 0, 'automatic emails do not add files to the list');

      process.env.HOMEHUB_VERSION = 'v0.1.31';
      await be.checkBackupEmail();
      assert.equal(outbox.length, 2);
      assert.match(outbox[1].text, /after each update\. This one is from v0\.1\.31/);
    });

    it('does not send while automations are paused', async () => {
      setUpEmail();
      await be.setBackupPassphrase(PASS);
      be.setAutoEmail(true);
      putSetting('automations_paused', '1');
      await be.checkBackupEmail();
      assert.equal(outbox.length, 0);
    });
  });
});
