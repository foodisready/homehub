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

// ── Admin seed ─────────────────────────────────────────────────

export async function seedAdminIfEmpty(): Promise<void> {
  if (userCount() > 0) return;

  const name     = process.env.ADMIN_USER     || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'changeme';
  await createUser(name, password, 'admin');

  // Only log a warning — never log the actual password
  console.warn(`[homehub] Created default admin user "${name}". Change the password immediately.`);
}
