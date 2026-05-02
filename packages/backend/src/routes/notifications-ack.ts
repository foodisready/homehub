/**
 * Public ack-token endpoint.
 *
 * Mounted *before* the JWT gate in index.ts so a one-tap ack from a push
 * payload (or future email/SMS) doesn't need a logged-in browser session.
 * The token IS the auth — single-use, rate-limited by uniqueness.
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { logger } from '../logger';

export const notificationsAckRouter = Router();

interface DispatchRow {
  id:       number;
  event_id: number;
  channel:  string;
  level:    number;
  acked_at: string | null;
}

export type AckResult =
  | { kind: 'ok';        eventId: number; level: number }
  | { kind: 'invalid' }
  | { kind: 'not_found' }
  | { kind: 'replayed' };

/** Pure-DB core: exported so tests can exercise it without HTTP plumbing. */
export function ackByToken(token: string): AckResult {
  if (!token || token.length < 8) return { kind: 'invalid' };

  const db  = getDb();
  const row = db.prepare('SELECT * FROM notification_dispatches WHERE ack_token = ?')
    .get(token) as DispatchRow | undefined;

  if (!row) return { kind: 'not_found' };
  if (row.acked_at) return { kind: 'replayed' };

  db.prepare("UPDATE notification_dispatches SET acked_at = datetime('now') WHERE id = ?").run(row.id);
  logger.info({ eventId: row.event_id, channel: row.channel, level: row.level }, 'Notification acked via token');
  return { kind: 'ok', eventId: row.event_id, level: row.level };
}

function handleAck(req: Request, res: Response): Response {
  const result = ackByToken(String(req.params.token ?? ''));
  switch (result.kind) {
    case 'ok':        return res.json({ acked: true, eventId: result.eventId, level: result.level });
    case 'invalid':   return res.status(400).json({ error: 'Invalid token',     code: 'VALIDATION_ERROR' });
    case 'not_found': return res.status(404).json({ error: 'Token not found',   code: 'NOT_FOUND' });
    case 'replayed':  return res.status(410).json({ error: 'Token already used', code: 'GONE' });
  }
}

notificationsAckRouter.post('/:token', handleAck);
notificationsAckRouter.get('/:token',  handleAck);
