import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getDb } from '../db';

const BCRYPT_ROUNDS = 12;
const ACCESS_TTL    = '8h';
const REFRESH_TTL   = '7d';

const JWT_SECRET         = process.env.JWT_SECRET         || 'dev-secret-change-me';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me';

export type Role = 'admin' | 'member';

export interface UserRow {
  id: number;
  name: string;
  password_hash: string;
  role: Role;
  created_at: string;
}

export interface TokenPayload {
  sub: number;
  name: string;
  role: Role;
}

// ── User management ────────────────────────────────────────────

export async function createUser(name: string, password: string, role: Role): Promise<UserRow> {
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const db   = getDb();
  const result = db.prepare(
    'INSERT INTO users (name, password_hash, role) VALUES (?, ?, ?)'
  ).run(name, hash, role);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid) as UserRow;
}

export function findUserByName(name: string): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE name = ?').get(name) as UserRow | undefined;
}

export function findUserById(id: number): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function listUsers(): Omit<UserRow, 'password_hash'>[] {
  return getDb().prepare('SELECT id, name, role, created_at FROM users ORDER BY name').all() as
    Omit<UserRow, 'password_hash'>[];
}

export async function validateCredentials(name: string, password: string): Promise<UserRow | null> {
  const user = findUserByName(name);
  if (!user) return null;
  const match = await bcrypt.compare(password, user.password_hash);
  return match ? user : null;
}

export async function updatePassword(userId: number, newPassword: string): Promise<void> {
  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
}

export function deleteUser(userId: number): boolean {
  const result = getDb().prepare('DELETE FROM users WHERE id = ?').run(userId);
  return result.changes > 0;
}

export function userCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  return row.count;
}

// ── Token issuing ──────────────────────────────────────────────

export function issueTokens(user: UserRow): { accessToken: string; refreshToken: string } {
  const payload: TokenPayload = { sub: user.id, name: user.name, role: user.role };
  const accessToken  = jwt.sign(payload, JWT_SECRET,         { expiresIn: ACCESS_TTL });
  const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: REFRESH_TTL });
  return { accessToken, refreshToken };
}

export function verifyAccessToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as unknown as TokenPayload;
}

export function verifyRefreshToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_REFRESH_SECRET) as unknown as TokenPayload;
}

// ── Admin seed and first-run setup ─────────────────────────────

/**
 * With ADMIN_PASSWORD set (and not the .env.example placeholder), create that
 * admin on first start, as before. Without it, HomeHub waits for someone to
 * create the admin account in the browser (createFirstAdmin).
 */
export async function seedAdminIfEmpty(): Promise<void> {
  if (userCount() > 0) return;

  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.startsWith('change-me')) {
    console.warn('[homehub] No users yet. Open HomeHub in a browser to create the admin account.');
    return;
  }
  const name = process.env.ADMIN_USER || 'admin';
  await createUser(name, password, 'admin');
  // Only log the name — never the password
  console.warn(`[homehub] Created admin user "${name}" from ADMIN_PASSWORD.`);
}

export const needsSetup = (): boolean => userCount() === 0;

export class SetupError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

let settingUp = false;

/** Create the first admin. Refused once any user exists, so it works exactly once. */
export async function createFirstAdmin(name: string, password: string): Promise<UserRow> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 32) throw new SetupError('Enter a username of up to 32 characters', 400);
  if (password.length < 8) throw new SetupError('Use a password of at least 8 characters', 400);
  // bcrypt is async, so guard against two first visitors racing past the check.
  if (settingUp || !needsSetup()) throw new SetupError('HomeHub is already set up. Sign in instead.', 409);
  settingUp = true;
  try {
    const user = await createUser(trimmed, password, 'admin');
    console.warn(`[homehub] Created admin user "${trimmed}" in the browser.`);
    return user;
  } finally {
    settingUp = false;
  }
}

/** The account the MCP server acts as: the first admin. */
export function serviceUser(): UserRow | undefined {
  return getDb().prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get() as UserRow | undefined;
}
