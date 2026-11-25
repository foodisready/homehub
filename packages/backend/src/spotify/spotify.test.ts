/**
 * Spotify search and library: setting up the household's app, signing in with PKCE, refreshing,
 * search and library pages, against a pretend Spotify on a local port and a temp DB.
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this file stays on its temp DB.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-spotify-test-'));
const CLIENT = '0123456789abcdef0123456789abcdef';
const id22 = (c: string) => c.repeat(22);

let db: Database.Database;
let mod: typeof import('./spotify');

/** A pretend Spotify: its sign-in checks the PKCE verifier against the challenge, like the real one. */
class FakeSpotify {
  server!: http.Server;
  port = 0;
  challenges = new Map<string, string>(); // code → challenge
  tokens = 0;
  refreshes = 0;
  revoked = false;
  /** The next API call answers 401 once (a token refused early). */
  refuseOnce = false;
  lastQuery = '';

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => this.answer(req, body, res));
    });
    await new Promise<void>((ok) => this.server.listen(0, '127.0.0.1', () => ok()));
    this.port = (this.server.address() as AddressInfo).port;
  }

  private json(res: http.ServerResponse, status: number, v: unknown) { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); }

  private answer(req: http.IncomingMessage, body: string, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/accounts/api/token') {
      const f = new URLSearchParams(body);
      if (f.get('client_id') !== CLIENT) return this.json(res, 400, { error: 'invalid_client' });
      if (f.get('grant_type') === 'authorization_code') {
        const challenge = this.challenges.get(f.get('code') ?? '');
        const got = crypto.createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url');
        if (!challenge || challenge !== got || f.get('redirect_uri') !== 'https://home.example.ts.net/spotify-callback') return this.json(res, 400, { error: 'invalid_grant' });
        this.tokens++;
        return this.json(res, 200, { access_token: `at${this.tokens}`, refresh_token: 'rt1', expires_in: 3600 });
      }
      if (f.get('grant_type') === 'refresh_token') {
        if (this.revoked || f.get('refresh_token') !== 'rt1') return this.json(res, 400, { error: 'invalid_grant' });
        this.refreshes++;
        return this.json(res, 200, { access_token: `fresh${this.refreshes}`, expires_in: 3600 });
      }
      return this.json(res, 400, { error: 'unsupported_grant_type' });
    }
    const auth = req.headers.authorization ?? '';
    if (!/^Bearer (at|fresh)\d+$/.test(auth)) return this.json(res, 401, { error: { status: 401 } });
    if (this.refuseOnce) { this.refuseOnce = false; return this.json(res, 401, { error: { status: 401 } }); }
    const img = [{ url: 'https://i.scdn.co/image/big', width: 640 }, { url: 'https://i.scdn.co/image/mid', width: 300 }, { url: 'https://i.scdn.co/image/small', width: 64 }];
    switch (url.pathname) {
      case '/api/me': return this.json(res, 200, { id: 'household', display_name: 'Morgan' });
      case '/api/search':
        this.lastQuery = url.search;
        return this.json(res, 200, {
          tracks: { items: [{ uri: `spotify:track:${id22('a')}`, name: 'Night Fever', artists: [{ name: 'Bee Gees' }], album: { images: img } }, null], total: 1, next: null },
          albums: { items: [{ uri: `spotify:album:${id22('b')}`, name: 'Spirits Having Flown', artists: [{ name: 'Bee Gees' }], images: img }], total: 1, next: null },
          playlists: { items: [null, { uri: `spotify:playlist:${id22('c')}`, name: 'Disco Night', owner: { display_name: 'Spotify' }, images: null }, { uri: 'spotify:playlist:bad', name: 'Broken' }], total: 2, next: null },
        });
      case '/api/me/tracks': return this.json(res, 200, { items: [{ track: { uri: `spotify:track:${id22('d')}`, name: 'Liked One', artists: [{ name: 'A' }, { name: 'B' }] } }], total: 1, next: null });
      case '/api/me/playlists': return this.json(res, 200, { items: [{ uri: `spotify:playlist:${id22('e')}`, name: 'Mine', owner: { display_name: 'Morgan' }, images: img }], total: 51, next: 'x' });
      case '/api/me/albums': return this.json(res, 200, { items: [{ album: { uri: `spotify:album:${id22('f')}`, name: 'Saved Album', artists: [{ name: 'C' }], images: [] } }], total: 1, next: null });
      default: return this.json(res, 404, {});
    }
  }
}

const sp = new FakeSpotify();

describe('Spotify search and library', () => {
  let server: http.Server;
  let base = '';
  let role = 'admin';
  let userId = 1;

  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    db = (await import('../db')).getDb();
    db.prepare("INSERT INTO users (id, name, password_hash, role) VALUES (1, 'Morgan', 'x', 'admin'), (2, 'Sam', 'x', 'member')").run();
    mod = await import('./spotify');
    await sp.start();
    mod.setSpotifyForTests(`http://127.0.0.1:${sp.port}/accounts`, `http://127.0.0.1:${sp.port}/api`);
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { sub: userId, name: 't', role } as never; next(); });
    app.use('/api/spotify', (await import('../routes/spotify')).spotifyRouter);
    await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
    sp.server.close();
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  const get = async (u: string) => { const r = await fetch(`${base}/api/spotify${u}`); return { status: r.status, body: await r.json() as Record<string, unknown> }; };
  const send = async (method: string, u: string, body: unknown) => {
    const r = await fetch(`${base}/api/spotify${u}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };

  /** Signs in as Spotify would: open the sign-in address, "approve", come back with code and state. */
  async function signIn(): Promise<{ status: number; body: Record<string, unknown> }> {
    const { body } = await send('POST', '/sign-in', { origin: 'https://home.example.ts.net' });
    const u = new URL(body.url as string);
    const code = crypto.randomBytes(8).toString('hex');
    sp.challenges.set(code, u.searchParams.get('code_challenge')!);
    return send('POST', '/callback', { code, state: u.searchParams.get('state') });
  }

  it('isn’t set up until an administrator gives the Client ID', async () => {
    assert.deepEqual((await get('')).body, { setUp: false, connected: false, name: null, clientId: '' });
    assert.equal((await send('POST', '/sign-in', { origin: 'https://home.example.ts.net' })).status, 409);
    assert.equal((await send('PUT', '/client', { clientId: 'not-an-id' })).status, 400);
    role = 'member';
    assert.equal((await send('PUT', '/client', { clientId: CLIENT })).status, 403, 'members can’t');
    role = 'admin';
    assert.equal((await send('PUT', '/client', { clientId: CLIENT.toUpperCase() })).status, 200);
    assert.equal(mod.clientId(), CLIENT);
  });

  it('signs in only on https (or loopback), with PKCE and a state', async () => {
    assert.equal((await send('POST', '/sign-in', { origin: 'http://192.168.86.88' })).body.code, 'NEEDS_HTTPS');
    assert.equal(mod.redirectUriFor('http://127.0.0.1:4200'), 'http://127.0.0.1:4200/spotify-callback');
    assert.equal(mod.redirectUriFor('http://localhost:4200'), null, 'Spotify doesn’t take localhost');
    const { body } = await send('POST', '/sign-in', { origin: 'https://home.example.ts.net' });
    const u = new URL(body.url as string);
    assert.equal(u.pathname, '/accounts/authorize');
    for (const [k, v] of [['client_id', CLIENT], ['response_type', 'code'], ['redirect_uri', 'https://home.example.ts.net/spotify-callback'], ['code_challenge_method', 'S256']]) {
      assert.equal(u.searchParams.get(k), v, k);
    }
    assert.match(u.searchParams.get('scope')!, /user-library-read/);
    assert.ok(u.searchParams.get('state') && u.searchParams.get('code_challenge'));
  });

  it('finishes the sign-in, keeps it without showing it, and refuses a made-up one', async () => {
    assert.equal((await send('POST', '/callback', { code: 'x', state: 'never-started' })).status, 400);
    const done = await signIn();
    assert.deepEqual(done.body, { connected: true, name: 'Morgan' });
    const status = await get('');
    assert.deepEqual(status.body, { setUp: true, connected: true, name: 'Morgan', clientId: CLIENT });
    assert.ok(!JSON.stringify(status.body).includes('rt1'), 'tokens never leave HomeHub');
    // Another person isn't signed in by someone else's sign-in.
    userId = 2; role = 'member';
    assert.deepEqual((await get('')).body, { setUp: true, connected: false, name: null });
    assert.equal((await get('/search?q=bee')).status, 409);
    userId = 1; role = 'admin';
  });

  it('searches songs, albums and playlists, 10 at most, leaving out anything unplayable', async () => {
    const r = (await get('/search?q=bee%20gees')).body as unknown as import('./spotify').SearchResult;
    assert.match(sp.lastQuery, /limit=10/);
    assert.match(sp.lastQuery, /type=track%2Calbum%2Cplaylist/);
    assert.deepEqual(r.tracks, [{ uri: `spotify:track:${id22('a')}`, kind: 'track', title: 'Night Fever', note: 'Bee Gees', art: 'https://i.scdn.co/image/mid' }]);
    assert.equal(r.albums[0].title, 'Spirits Having Flown');
    assert.deepEqual(r.playlists.map((p) => [p.title, p.note, p.art]), [['Disco Night', 'Playlist · Spotify', null]]);
    assert.equal((await get('/search?q=')).status, 400);
  });

  it('reads liked songs, playlists and saved albums', async () => {
    const liked = (await get('/library/liked')).body as { items: { title: string; note: string }[] };
    assert.deepEqual(liked.items.map((i) => [i.title, i.note]), [['Liked One', 'A, B']]);
    const lists = (await get('/library/playlists?offset=50')).body as { total: number; offset: number; items: unknown[] };
    assert.deepEqual([lists.total, lists.offset, lists.items.length], [51, 50, 1]);
    assert.equal(((await get('/library/albums')).body as { items: { title: string }[] }).items[0].title, 'Saved Album');
    assert.equal((await get('/library/other')).status, 404);
  });

  it('gets a new token when it runs out or is refused, and asks to connect again when Spotify signs it out', async () => {
    db.prepare('UPDATE spotify_accounts SET expires_at = 1 WHERE user_id = 1').run();
    assert.equal((await get('/library/liked')).status, 200);
    assert.equal(sp.refreshes, 1, 'expired: refreshed');
    assert.equal((db.prepare('SELECT refresh_token FROM spotify_accounts WHERE user_id = 1').get() as { refresh_token: string }).refresh_token, 'rt1', 'the refresh token is kept');
    sp.refuseOnce = true;
    const again = await get('/library/liked');
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(sp.refreshes, 2);
    sp.revoked = true;
    db.prepare('UPDATE spotify_accounts SET expires_at = 1 WHERE user_id = 1').run();
    const r = await get('/library/liked');
    assert.equal(r.status, 409);
    assert.match(String(r.body.error), /Connect Spotify again/);
    assert.equal(((await get('')).body as { connected: boolean }).connected, false);
    sp.revoked = false;
  });

  it('disconnects', async () => {
    await signIn();
    assert.equal(((await send('DELETE', '', {})).body as { connected: boolean }).connected, false);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM spotify_accounts').get() as { n: number }).n, 0);
  });
});
