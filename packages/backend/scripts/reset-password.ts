/**
 * Usage:
 *   npx ts-node scripts/reset-password.ts <username> <new-password>
 *
 * Example:
 *   npx ts-node scripts/reset-password.ts admin homehub-dev
 */
import bcrypt from 'bcrypt';
import Database from 'better-sqlite3';
import path from 'path';

const [,, username, password] = process.argv;

if (!username || !password) {
  console.error('Usage: npx ts-node scripts/reset-password.ts <username> <new-password>');
  process.exit(1);
}

const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'db.sqlite');
const db = new Database(dbPath);

const user = db.prepare('SELECT id FROM users WHERE name = ?').get(username) as { id: number } | undefined;
if (!user) {
  console.error(`User "${username}" not found.`);
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);
db.prepare('UPDATE users SET password_hash = ? WHERE name = ?').run(hash, username);
console.log(`Password for "${username}" reset successfully.`);
