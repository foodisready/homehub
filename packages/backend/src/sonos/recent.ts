/**
 * Recently played on the Sonos speakers, to play again: what HomeHub started (a favorite, a Sonos
 * playlist, a Spotify link), and radio stations seen playing, however they were started. Sonos's
 * own "Recently played" lives in the Sonos account online, which HomeHub can't read.
 */
import { getDb } from '../db';
import { logger } from '../logger';

export type RecentKind = 'favorite' | 'playlist' | 'spotify' | 'station';

export interface RecentItem {
  key: string;
  kind: RecentKind;
  title: string;
  note: string | null;
  art: string | null;
  playedAt: string;
}

/** How to play it again: a favorite or playlist by id and name, a Spotify link, or a station's address. */
export type RecentPayload =
  | { id: string; title: string }
  | { link: string }
  | { uri: string; meta: string };

interface Row { key: string; kind: RecentKind; title: string; note: string | null; art: string | null; payload: string; played_at: string }

/** How many are kept. */
export const MAX_RECENT = 20;

export function noteRecent(item: { key: string; kind: RecentKind; title: string; note?: string | null; art?: string | null; payload: RecentPayload }): void {
  try {
    const db = getDb();
    db.prepare(`INSERT INTO sonos_recent (key, kind, title, note, art, payload, played_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, title = excluded.title, note = excluded.note, art = COALESCE(excluded.art, sonos_recent.art),
      payload = excluded.payload, played_at = excluded.played_at`)
      .run(item.key, item.kind, item.title.slice(0, 200), item.note?.slice(0, 200) ?? null, item.art ?? null, JSON.stringify(item.payload));
    db.prepare(`DELETE FROM sonos_recent WHERE key NOT IN (SELECT key FROM sonos_recent ORDER BY played_at DESC, rowid DESC LIMIT ${MAX_RECENT})`).run();
  } catch (err) {
    logger.warn({ reason: (err as Error).message }, 'Could not note a recently played item');
  }
}

/** A station seen playing: noted again only after a while, so the Music page's reads don't rewrite it every few seconds. */
const lastSeen = new Map<string, number>();
export function noteStationSeen(uri: string, meta: string, title: string, art: string | null): void {
  const key = `station:${uri.split('?')[0]}`;
  const now = Date.now();
  if ((lastSeen.get(key) ?? 0) > now - 10 * 60_000) return;
  lastSeen.set(key, now);
  // Started from a favorite: it's in the list already, as that favorite.
  try {
    if (getDb().prepare("SELECT 1 FROM sonos_recent WHERE kind = 'favorite' AND title = ?").get(title)) return;
  } catch { /* noted as a station */ }
  noteRecent({ key, kind: 'station', title, note: 'Radio station', art, payload: { uri, meta } });
}

export function recentList(): RecentItem[] {
  return (getDb().prepare('SELECT * FROM sonos_recent ORDER BY played_at DESC, rowid DESC').all() as Row[])
    .map((r) => ({ key: r.key, kind: r.kind, title: r.title, note: r.note, art: r.art, playedAt: r.played_at }));
}

export function recentFor(key: string): { kind: RecentKind; title: string; payload: RecentPayload } | null {
  const r = getDb().prepare('SELECT * FROM sonos_recent WHERE key = ?').get(key) as Row | undefined;
  if (!r) return null;
  try { return { kind: r.kind, title: r.title, payload: JSON.parse(r.payload) as RecentPayload }; } catch { return null; }
}
