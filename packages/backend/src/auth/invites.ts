import crypto from 'crypto';
import { getDb } from '../db';
import { createUser, type UserRow } from './auth.service';

/**
 * Family invites. An admin shows a QR code; each person who scans it picks
 * their own name and password and gets a family (member) login. No admin has
 * to type anyone's password.
 *
 * An invite works for 24 hours and for up to 10 people, and can be cancelled.
 * The code is 128 random bits and only its hash is stored.
 */

export const INVITE_HOURS = 24;
export const INVITE_MAX_USES = 10;

interface InviteRow {
  id: number;
  code_hash: string;
  created_by: number | null;
  expires_at: string;
  max_uses: number;
  uses: number;
  cancelled: number;
  created_at: string;
}

export interface InviteInfo { id: number; expiresAt: string; uses: number; maxUses: number }

export class InviteError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const hash = (code: string) => crypto.createHash('sha256').update(code).digest('hex');
const info = (r: InviteRow): InviteInfo => ({ id: r.id, expiresAt: r.expires_at, uses: r.uses, maxUses: r.max_uses });

/** A new invite. The code is returned once and never stored. */
export function createInvite(createdBy: number, now = new Date()): InviteInfo & { code: string } {
  const code = crypto.randomBytes(16).toString('base64url');
  const expires = new Date(now.getTime() + INVITE_HOURS * 3600_000).toISOString();
  const id = getDb().prepare('INSERT INTO invites (code_hash, created_by, expires_at, max_uses) VALUES (?, ?, ?, ?)')
    .run(hash(code), createdBy, expires, INVITE_MAX_USES).lastInsertRowid as number;
  return { id, code, expiresAt: expires, uses: 0, maxUses: INVITE_MAX_USES };
}

/** Invites that still work. */
export function activeInvites(now = new Date()): InviteInfo[] {
  return (getDb().prepare('SELECT * FROM invites WHERE cancelled = 0 AND uses < max_uses AND expires_at > ? ORDER BY id DESC')
    .all(now.toISOString()) as InviteRow[]).map(info);
}

export function cancelInvite(id: number): boolean {
  return getDb().prepare('UPDATE invites SET cancelled = 1 WHERE id = ?').run(id).changes > 0;
}

function usable(code: unknown, now: Date): InviteRow {
  if (typeof code !== 'string' || code.length < 10 || code.length > 64) throw new InviteError('This invite link isn’t valid.', 404);
  const row = getDb().prepare('SELECT * FROM invites WHERE code_hash = ?').get(hash(code)) as InviteRow | undefined;
  if (!row) throw new InviteError('This invite link isn’t valid.', 404);
  if (row.cancelled) throw new InviteError('This invite was cancelled. Ask for a new one.', 410);
  if (row.expires_at <= now.toISOString()) throw new InviteError('This invite has expired. Ask for a new one.', 410);
  if (row.uses >= row.max_uses) throw new InviteError('This invite has been used up. Ask for a new one.', 410);
  return row;
}

/** Whether a code still works, for the join page. Throws InviteError if not. */
export function checkInvite(code: unknown, now = new Date()): { expiresAt: string } {
  return { expiresAt: usable(code, now).expires_at };
}

/** Creates a family login from an invite. */
export async function redeemInvite(code: unknown, name: unknown, password: unknown, now = new Date()): Promise<UserRow> {
  const row = usable(code, now);
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 32) throw new InviteError('Enter a name of up to 32 characters.');
  if (typeof password !== 'string' || password.length < 8) throw new InviteError('Use a password of at least 8 characters.');
  const db = getDb();
  if (db.prepare('SELECT 1 FROM users WHERE name = ? COLLATE NOCASE').get(name.trim())) {
    throw new InviteError('Someone already uses that name. Try another.', 409);
  }
  // Count the use first, so two people racing on the last place can't both get in.
  const claimed = db.prepare('UPDATE invites SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND cancelled = 0').run(row.id);
  if (!claimed.changes) throw new InviteError('This invite has been used up. Ask for a new one.', 410);
  try {
    return await createUser(name.trim(), password, 'member');
  } catch (err) {
    db.prepare('UPDATE invites SET uses = uses - 1 WHERE id = ?').run(row.id);
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new InviteError('Someone already uses that name. Try another.', 409);
    throw err;
  }
}
