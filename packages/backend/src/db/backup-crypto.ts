import crypto from 'crypto';
import { promisify } from 'util';
import { BackupError } from './backup-error';

/**
 * Encrypted backups, for sending a backup somewhere less private than this
 * computer, such as an email inbox.
 *
 * The key comes from a passphrase the user chooses, stretched with scrypt.
 * HomeHub keeps only the stretched key (and its salt), never the passphrase,
 * so it can encrypt automatic backups without asking. Restoring an encrypted
 * file always needs the passphrase.
 *
 * The file is JSON, so it uploads like any other backup:
 *   { format, version, created_at, kdf: { scrypt params, salt }, cipher, iv, tag, data }
 * AES-256-GCM authenticates the data and every header field that matters, so
 * a wrong passphrase and a changed file are both caught.
 */

export const ENCRYPTED_FORMAT = 'homehub-backup-encrypted';
const VERSION = 1;
const CIPHER = 'aes-256-gcm';
/** 64 MB of memory per guess: about half a second on a Raspberry Pi 4, slow for anyone guessing. */
const KDF = { N: 2 ** 16, r: 8, p: 1 };
export const MIN_PASSPHRASE = 10;

/** What HomeHub stores to encrypt without the passphrase. */
export interface BackupKey {
  salt: string;   // base64
  N: number;
  r: number;
  p: number;
  key: string;    // base64, 32 bytes
}

interface Header {
  format: string;
  version: number;
  created_at: string;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: string;
  iv: string;
}

export interface EncryptedBackup extends Header {
  about?: string;
  tag: string;
  data: string;
}

const scrypt = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike, salt: crypto.BinaryLike, keylen: number, options: crypto.ScryptOptions,
) => Promise<Buffer>;

/** Spaces at either end are easy to type by accident on a phone, so they don't count. */
function normalise(passphrase: string): string {
  return passphrase.normalize('NFC').trim();
}

async function stretch(passphrase: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return scrypt(normalise(passphrase), salt, 32, { N, r, p, maxmem: 256 * N * r });
}

/** Check a new passphrase and turn it into the key HomeHub stores. */
export async function makeBackupKey(passphrase: string): Promise<BackupKey> {
  if (typeof passphrase !== 'string' || normalise(passphrase).length < MIN_PASSPHRASE) {
    throw new BackupError(`Use at least ${MIN_PASSPHRASE} characters for the backup passphrase`, 400, 'PASSPHRASE_WEAK');
  }
  if (new Set(normalise(passphrase)).size < 4) {
    throw new BackupError('That passphrase is too easy to guess. Use a few words or a mix of characters.', 400, 'PASSPHRASE_WEAK');
  }
  const salt = crypto.randomBytes(16);
  const key = await stretch(passphrase, salt, KDF.N, KDF.r, KDF.p);
  return { salt: salt.toString('base64'), ...KDF, key: key.toString('base64') };
}

/** The header fields the tag protects, in a fixed order. */
function aad(h: Header): Buffer {
  return Buffer.from([h.format, h.version, h.created_at, h.kdf.name, h.kdf.N, h.kdf.r, h.kdf.p, h.kdf.salt, h.cipher, h.iv].join('|'));
}

export function encryptBackup(plaintext: string, k: BackupKey, createdAt: string): string {
  const iv = crypto.randomBytes(12);
  const header: Header = {
    format: ENCRYPTED_FORMAT,
    version: VERSION,
    created_at: createdAt,
    kdf: { name: 'scrypt', N: k.N, r: k.r, p: k.p, salt: k.salt },
    cipher: CIPHER,
    iv: iv.toString('base64'),
  };
  const cipher = crypto.createCipheriv(CIPHER, Buffer.from(k.key, 'base64'), iv);
  cipher.setAAD(aad(header));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const file: EncryptedBackup = {
    ...header,
    about: 'An encrypted HomeHub backup. To restore it, open Settings → Backups in HomeHub, select Upload a backup, and enter your backup passphrase.',
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
  return JSON.stringify(file, null, 2) + '\n';
}

/** The parsed file when the text is an encrypted backup, otherwise null. */
export function asEncrypted(text: string): EncryptedBackup | null {
  try {
    const d = JSON.parse(text) as EncryptedBackup;
    return d && typeof d === 'object' && d.format === ENCRYPTED_FORMAT ? d : null;
  } catch {
    return null;
  }
}

const b64 = (v: unknown, bytes?: number): Buffer => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) throw new BackupError('This encrypted backup is damaged');
  const buf = Buffer.from(v, 'base64');
  if (bytes !== undefined && buf.length !== bytes) throw new BackupError('This encrypted backup is damaged');
  return buf;
};

/** The backup inside an encrypted file, as text. */
export async function decryptBackup(file: EncryptedBackup, passphrase: string | undefined): Promise<string> {
  if (typeof file.version !== 'number' || file.version > VERSION) {
    throw new BackupError('This backup is from a newer version of HomeHub');
  }
  const { kdf } = file;
  const sane = kdf && kdf.name === 'scrypt'
    && Number.isInteger(kdf.N) && kdf.N >= 2 ** 14 && kdf.N <= 2 ** 20 && (kdf.N & (kdf.N - 1)) === 0
    && Number.isInteger(kdf.r) && kdf.r >= 1 && kdf.r <= 16
    && Number.isInteger(kdf.p) && kdf.p >= 1 && kdf.p <= 4
    && file.cipher === CIPHER && typeof file.created_at === 'string';
  if (!sane) throw new BackupError('This encrypted backup is damaged, or from a newer HomeHub');
  const salt = b64(kdf.salt);
  const iv = b64(file.iv, 12);
  const tag = b64(file.tag, 16);
  const data = b64(file.data);
  if (salt.length < 16) throw new BackupError('This encrypted backup is damaged');

  if (!passphrase || !normalise(passphrase)) {
    throw new BackupError('This backup is encrypted. Enter the backup passphrase to open it.', 400, 'PASSPHRASE_REQUIRED');
  }
  const key = await stretch(passphrase, salt, kdf.N, kdf.r, kdf.p);
  try {
    const decipher = crypto.createDecipheriv(CIPHER, key, iv);
    decipher.setAAD(aad(file));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new BackupError("That passphrase doesn't open this backup (or the file was changed)", 400, 'PASSPHRASE_WRONG');
  }
}
