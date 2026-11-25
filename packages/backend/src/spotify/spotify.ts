/**
 * Spotify search and your library, for choosing music to play on the Sonos speakers.
 *
 * Sonos keeps its Spotify login inside the Sonos account, out of reach, so this uses Spotify's
 * own Web API with the household's personal Spotify app (Development Mode): the owner makes it on
 * developer.spotify.com and gives HomeHub its Client ID. Each person then signs in once
 * (Authorization Code with PKCE: no app secret). Their refresh token is kept on this HomeHub,
 * in its own table, which backups don't include.
 *
 * What's found is played through Sonos as a Spotify address (spotify:track:…), the same way a
 * pasted share link is; HomeHub never streams anything itself.
 *
 * Development Mode (Feb 2026): search returns at most 10 a time; a playlist's songs can only be
 * listed for playlists the person owns, so playlists are played whole, by address.
 */
import crypto from 'node:crypto';
import { getDb } from '../db';
import { logger } from '../logger';

// The real Spotify, unless a test points elsewhere (SPOTIFY_ACCOUNTS_URL / SPOTIFY_API_URL, for a local pretend one).
let accountsBase = process.env.SPOTIFY_ACCOUNTS_URL || 'https://accounts.spotify.com';
let apiBase = process.env.SPOTIFY_API_URL || 'https://api.spotify.com/v1';
/** For tests: a pretend Spotify. */
export function setSpotifyForTests(accounts: string, api: string): void { accountsBase = accounts; apiBase = api; }

export const SCOPES = 'playlist-read-private playlist-read-collaborative user-library-read';
const CLIENT_ID_KEY = 'spotify_client_id';
const TIMEOUT_MS = 8000;

export class SpotifyError extends Error {
  constructor(message: string, readonly code: 'NOT_SET_UP' | 'NOT_CONNECTED' | 'SIGN_IN_FAILED' | 'FAILED' | 'LIMITED', readonly status = 502) { super(message); }
}

// ── The household's Spotify app ────────────────────────────────

export function clientId(): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(CLIENT_ID_KEY) as { value: string } | undefined;
  return row?.value ?? '';
}

/** A Client ID is 32 hexadecimal characters. Empty removes it. */
export function setClientId(id: string): void {
  const v = id.trim();
  if (v && !/^[0-9a-f]{32}$/i.test(v)) throw new SpotifyError('A Spotify Client ID is 32 letters and numbers, from your app’s page on developer.spotify.com.', 'FAILED', 400);
  if (!v) getDb().prepare('DELETE FROM settings WHERE key = ?').run(CLIENT_ID_KEY);
  else getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CLIENT_ID_KEY, v.toLowerCase());
}

/**
 * Where Spotify sends the person back after signing in: HomeHub's own page, on an address
 * Spotify accepts (https, or a loopback address for testing). Null when this address won't do.
 */
export function redirectUriFor(origin: string): string | null {
  let u: URL;
  try { u = new URL(origin); } catch { return null; }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null;
  return `${u.origin}/spotify-callback`;
}

// ── Signing in ─────────────────────────────────────────────────

interface Pending { userId: number; verifier: string; redirectUri: string; at: number }
const pending = new Map<string, Pending>();
const PENDING_MS = 10 * 60_000;

/** Starts a sign-in: the address on Spotify to open. */
export function signInUrl(userId: number, redirectUri: string): string {
  const id = clientId();
  if (!id) throw new SpotifyError('Spotify isn’t set up on this HomeHub yet: an administrator adds the Client ID in Settings → Spotify.', 'NOT_SET_UP', 409);
  const now = Date.now();
  for (const [k, p] of pending) if (now - p.at > PENDING_MS) pending.delete(k);
  const state = crypto.randomBytes(16).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  pending.set(state, { userId, verifier, redirectUri, at: now });
  const q = new URLSearchParams({
    client_id: id, response_type: 'code', redirect_uri: redirectUri, code_challenge_method: 'S256', code_challenge: challenge, state, scope: SCOPES,
  });
  return `${accountsBase}/authorize?${q}`;
}

interface TokenAnswer { access_token: string; refresh_token?: string; expires_in: number }

async function tokenRequest(body: Record<string, string>): Promise<TokenAnswer> {
  let res: Response;
  try {
    res = await fetch(`${accountsBase}/api/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new SpotifyError(`Couldn’t reach Spotify: ${(err as Error).message}`, 'FAILED');
  }
  const json = await res.json().catch(() => ({})) as Partial<TokenAnswer> & { error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new SpotifyError(json.error === 'invalid_grant' ? 'Spotify sign-in has expired. Connect Spotify again.' : `Spotify refused the sign-in${json.error ? ` (${json.error})` : ''}.`,
      json.error === 'invalid_grant' ? 'NOT_CONNECTED' : 'SIGN_IN_FAILED', json.error === 'invalid_grant' ? 409 : 502);
  }
  return json as TokenAnswer;
}

/** Finishes a sign-in with what Spotify sent back. Answers with the person's Spotify name. */
export async function finishSignIn(userId: number, code: string, state: string): Promise<string> {
  const p = pending.get(state);
  if (!p || p.userId !== userId || Date.now() - p.at > PENDING_MS) {
    throw new SpotifyError('That Spotify sign-in has expired or wasn’t started here. Try Connect Spotify again.', 'SIGN_IN_FAILED', 400);
  }
  pending.delete(state);
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, client_id: clientId(), code_verifier: p.verifier });
  if (!t.refresh_token) throw new SpotifyError('Spotify didn’t give HomeHub a lasting sign-in. Try again.', 'SIGN_IN_FAILED');
  save(userId, t);
  const me = await call<{ display_name?: string | null; id?: string }>(userId, '/me');
  const name = me.display_name || me.id || 'Spotify';
  getDb().prepare('UPDATE spotify_accounts SET name = ? WHERE user_id = ?').run(name, userId);
  logger.info({ userId }, 'Spotify connected');
  return name;
}

// ── Each person's sign-in ──────────────────────────────────────

interface Account { user_id: number; refresh_token: string; access_token: string | null; expires_at: number | null; name: string | null }

function account(userId: number): Account | undefined {
  return getDb().prepare('SELECT * FROM spotify_accounts WHERE user_id = ?').get(userId) as Account | undefined;
}

function save(userId: number, t: TokenAnswer): void {
  const expires = Date.now() + Math.max(60, t.expires_in - 60) * 1000;
  const db = getDb();
  if (t.refresh_token) {
    db.prepare(`INSERT INTO spotify_accounts (user_id, refresh_token, access_token, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET refresh_token = excluded.refresh_token, access_token = excluded.access_token, expires_at = excluded.expires_at`)
      .run(userId, t.refresh_token, t.access_token, expires);
  } else {
    // A refresh that keeps the same refresh token.
    db.prepare('UPDATE spotify_accounts SET access_token = ?, expires_at = ? WHERE user_id = ?').run(t.access_token, expires, userId);
  }
}

export function connection(userId: number): { setUp: boolean; connected: boolean; name: string | null } {
  const a = account(userId);
  return { setUp: !!clientId(), connected: !!a, name: a?.name ?? null };
}

export function disconnect(userId: number): void {
  getDb().prepare('DELETE FROM spotify_accounts WHERE user_id = ?').run(userId);
}

/** A fresh access token: the kept one while it lasts, else a new one from the refresh token. */
async function accessToken(userId: number): Promise<string> {
  const a = account(userId);
  if (!a) throw new SpotifyError('Connect your Spotify account first, in Settings → Spotify.', 'NOT_CONNECTED', 409);
  if (a.access_token && a.expires_at && a.expires_at > Date.now()) return a.access_token;
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: a.refresh_token, client_id: clientId() });
    save(userId, t);
    return t.access_token;
  } catch (err) {
    // Signed out on Spotify's side (or the app was changed): ask to connect again.
    if (err instanceof SpotifyError && err.code === 'NOT_CONNECTED') disconnect(userId);
    throw err;
  }
}

async function call<T>(userId: number, path: string, query: Record<string, string | number> = {}): Promise<T> {
  const q = new URLSearchParams(Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]));
  const url = `${apiBase}${path}${[...q].length ? `?${q}` : ''}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken(userId);
    let res: Response;
    try {
      res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new SpotifyError(`Couldn’t reach Spotify: ${(err as Error).message}`, 'FAILED');
    }
    if (res.status === 401 && attempt === 0) {
      // The token was refused early: get a new one and try once more.
      getDb().prepare('UPDATE spotify_accounts SET access_token = NULL, expires_at = NULL WHERE user_id = ?').run(userId);
      continue;
    }
    if (res.status === 429) throw new SpotifyError('Spotify asks HomeHub to slow down. Try again in a minute.', 'LIMITED', 429);
    if (res.status === 403) throw new SpotifyError('Spotify doesn’t allow that for this account. The person who made the Spotify app needs Premium, and each person must be added to the app on developer.spotify.com (up to 5).', 'FAILED', 403);
    if (!res.ok) throw new SpotifyError(`Spotify answered ${res.status}.`, 'FAILED');
    return await res.json() as T;
  }
  throw new SpotifyError('Spotify refused the sign-in. Connect Spotify again.', 'NOT_CONNECTED', 409);
}

// ── Search and library ─────────────────────────────────────────

/** Something to play, as shown in the picker. `uri` is its Spotify address, played through Sonos. */
export interface SpotifyItem {
  uri: string;
  kind: 'track' | 'album' | 'playlist';
  title: string;
  note: string | null;
  /** A web image (https). */
  art: string | null;
}

interface SpImage { url: string; width?: number | null }
interface SpArtist { name: string }
interface SpTrack { uri: string; name: string; artists?: SpArtist[]; album?: { name?: string; images?: SpImage[] } }
interface SpAlbum { uri: string; name: string; artists?: SpArtist[]; images?: SpImage[] }
interface SpPlaylist { uri: string; name: string; owner?: { display_name?: string | null }; images?: SpImage[] | null }
interface SpPage<T> { items: (T | null)[]; total: number; next: string | null }

/** The smallest image that's still at least 160 px, for a cover. */
function imageOf(images?: SpImage[] | null): string | null {
  const list = (images ?? []).filter((i) => /^https:\/\//.test(i.url));
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.find((i) => (i.width ?? 0) >= 160) ?? sorted.at(-1)!).url;
}

const URI = /^spotify:(track|album|playlist):[A-Za-z0-9]{22}$/;
const artists = (a?: SpArtist[]) => (a ?? []).map((x) => x.name).filter(Boolean).join(', ') || null;

const fromTrack = (t: SpTrack): SpotifyItem => ({ uri: t.uri, kind: 'track', title: t.name, note: artists(t.artists), art: imageOf(t.album?.images) });
const fromAlbum = (a: SpAlbum): SpotifyItem => ({ uri: a.uri, kind: 'album', title: a.name, note: artists(a.artists), art: imageOf(a.images) });
const fromPlaylist = (p: SpPlaylist): SpotifyItem => ({ uri: p.uri, kind: 'playlist', title: p.name, note: p.owner?.display_name ? `Playlist · ${p.owner.display_name}` : 'Playlist', art: imageOf(p.images) });

const valid = (i: SpotifyItem) => URI.test(i.uri) && !!i.title;

export interface SearchResult { tracks: SpotifyItem[]; albums: SpotifyItem[]; playlists: SpotifyItem[] }

/** Search: up to 10 songs, albums and playlists (Spotify's limit for personal apps). */
export async function search(userId: number, q: string): Promise<SearchResult> {
  const r = await call<{ tracks?: SpPage<SpTrack>; albums?: SpPage<SpAlbum>; playlists?: SpPage<SpPlaylist> }>(userId, '/search', { q, type: 'track,album,playlist', limit: 10 });
  const pick = <T>(p: SpPage<T> | undefined, f: (x: T) => SpotifyItem) => (p?.items ?? []).filter((x): x is T => !!x).map(f).filter(valid);
  return { tracks: pick(r.tracks, fromTrack), albums: pick(r.albums, fromAlbum), playlists: pick(r.playlists, fromPlaylist) };
}

export interface LibraryPage { items: SpotifyItem[]; total: number; offset: number }

/** The person's playlists, liked songs or saved albums, 50 at a time. */
export async function library(userId: number, what: 'playlists' | 'liked' | 'albums', offset: number): Promise<LibraryPage> {
  const q = { limit: 50, offset };
  if (what === 'playlists') {
    const r = await call<SpPage<SpPlaylist>>(userId, '/me/playlists', q);
    return { items: r.items.filter((x): x is SpPlaylist => !!x).map(fromPlaylist).filter(valid), total: r.total, offset };
  }
  if (what === 'liked') {
    const r = await call<SpPage<{ track: SpTrack | null }>>(userId, '/me/tracks', q);
    return { items: r.items.map((x) => x?.track).filter((x): x is SpTrack => !!x).map(fromTrack).filter(valid), total: r.total, offset };
  }
  const r = await call<SpPage<{ album: SpAlbum | null }>>(userId, '/me/albums', q);
  return { items: r.items.map((x) => x?.album).filter((x): x is SpAlbum => !!x).map(fromAlbum).filter(valid), total: r.total, offset };
}
