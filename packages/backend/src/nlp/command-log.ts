import { getDb } from '../db';
import { logger } from '../logger';

export type CommandHandler = 'rules' | 'model';

const MAX_ROWS   = 1000;
const MAX_LENGTH = 200;
const RECENT     = 50;

/** Keep a short local history, to show how often the rules miss. Never blocks a command. */
export function recordCommand(text: string, handledBy: CommandHandler): void {
  try {
    const db = getDb();
    db.prepare('INSERT INTO chat_commands (text, handled_by) VALUES (?, ?)')
      .run(text.slice(0, MAX_LENGTH), handledBy);
    db.prepare(
      'DELETE FROM chat_commands WHERE id NOT IN (SELECT id FROM chat_commands ORDER BY id DESC LIMIT ?)'
    ).run(MAX_ROWS);
  } catch (err) {
    logger.warn({ err }, 'Could not record chat command');
  }
}

const toEntry = (row: { text: string; created_at: string }) =>
  ({ text: row.text, createdAt: row.created_at.replace(' ', 'T') + 'Z' });

/** Keep what speech recognition heard, including failures, to show why voice commands miss. */
export function recordVoiceCommand(text: string, understood: boolean): void {
  try {
    const db = getDb();
    db.prepare('INSERT INTO voice_commands (text, understood) VALUES (?, ?)')
      .run(text.slice(0, MAX_LENGTH), understood ? 1 : 0);
    db.prepare(
      'DELETE FROM voice_commands WHERE id NOT IN (SELECT id FROM voice_commands ORDER BY id DESC LIMIT ?)'
    ).run(MAX_ROWS);
  } catch (err) {
    logger.warn({ err }, 'Could not record voice command');
  }
}

export function getCommandStats() {
  const db = getDb();
  const counts = db.prepare('SELECT handled_by, COUNT(*) AS count FROM chat_commands GROUP BY handled_by')
    .all() as { handled_by: CommandHandler; count: number }[];
  const count = (handler: CommandHandler) => counts.find((c) => c.handled_by === handler)?.count ?? 0;

  const recent = db.prepare(
    "SELECT text, created_at FROM chat_commands WHERE handled_by = 'model' ORDER BY id DESC LIMIT ?"
  ).all(RECENT) as { text: string; created_at: string }[];

  const voice = db.prepare(
    'SELECT COUNT(*) AS total, COALESCE(SUM(understood), 0) AS understood FROM voice_commands'
  ).get() as { total: number; understood: number };
  const missed = db.prepare(
    'SELECT text, created_at FROM voice_commands WHERE understood = 0 ORDER BY id DESC LIMIT ?'
  ).all(RECENT) as { text: string; created_at: string }[];

  return {
    total:       count('rules') + count('model'),
    rules:       count('rules'),
    model:       count('model'),
    recentModel: recent.map(toEntry),
    voice: {
      total:        voice.total,
      understood:   voice.understood,
      missed:       voice.total - voice.understood,
      recentMissed: missed.map(toEntry),
    },
  };
}
