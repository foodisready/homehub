import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { logger } from '../logger';
import {
  SpotifyError, clientId, connection, disconnect, finishSignIn, library, redirectUriFor, search, setClientId, signInUrl,
} from '../spotify/spotify';

/** Spotify search and library for the Sonos picker, at /api/spotify (spotify/spotify.ts). */
export const spotifyRouter = Router();

const userOf = (req: Request) => Number(req.user!.sub);

function failed(res: Response, err: unknown): void {
  if (err instanceof SpotifyError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
  logger.warn({ reason: (err as Error).message }, 'Spotify request failed');
  res.status(502).json({ error: 'Spotify didn’t answer as expected. Try again.', code: 'FAILED' });
}

/** GET /api/spotify — is Spotify set up here, and is this person connected? Admins also get the Client ID. */
spotifyRouter.get('/', (req: Request, res: Response) => {
  res.json({ ...connection(userOf(req)), ...(req.user?.role === 'admin' ? { clientId: clientId() } : {}) });
});

/** PUT /api/spotify/client { clientId } — the household's Spotify app (admin). Empty removes it. */
spotifyRouter.put('/client', requireAdmin, (req: Request, res: Response) => {
  const id = (req.body ?? {}).clientId;
  if (typeof id !== 'string') return res.status(400).json({ error: 'clientId must be text', code: 'VALIDATION_ERROR' });
  try {
    setClientId(id);
    logger.info({ by: req.user?.sub, set: !!id.trim() }, 'Spotify Client ID changed');
    res.json({ ...connection(userOf(req)), clientId: clientId() });
  } catch (err) { failed(res, err); }
});

/** POST /api/spotify/sign-in { origin } — where to send this person to sign in to Spotify. */
spotifyRouter.post('/sign-in', (req: Request, res: Response) => {
  const origin = (req.body ?? {}).origin;
  const redirect = typeof origin === 'string' ? redirectUriFor(origin) : null;
  if (!redirect) {
    return res.status(400).json({ error: 'Spotify only signs in on an https address. Open HomeHub from its address starting with https:// (the Tailscale one), then connect.', code: 'NEEDS_HTTPS' });
  }
  try { res.json({ url: signInUrl(userOf(req), redirect) }); } catch (err) { failed(res, err); }
});

/** POST /api/spotify/callback { code, state } — finishes the sign-in Spotify sent back. */
spotifyRouter.post('/callback', async (req: Request, res: Response) => {
  const { code, state } = (req.body ?? {}) as { code?: unknown; state?: unknown };
  if (typeof code !== 'string' || typeof state !== 'string' || code.length > 2000 || state.length > 100) {
    return res.status(400).json({ error: 'That isn’t a Spotify sign-in.', code: 'VALIDATION_ERROR' });
  }
  try { res.json({ connected: true, name: await finishSignIn(userOf(req), code, state) }); } catch (err) { failed(res, err); }
});

/** DELETE /api/spotify — disconnects this person's Spotify from HomeHub. */
spotifyRouter.delete('/', (req: Request, res: Response) => {
  disconnect(userOf(req));
  logger.info({ userId: userOf(req) }, 'Spotify disconnected');
  res.json(connection(userOf(req)));
});

/** GET /api/spotify/search?q= — songs, albums and playlists. */
spotifyRouter.get('/search', async (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q || q.length > 200) return res.status(400).json({ error: 'Type what to search for.', code: 'VALIDATION_ERROR' });
  try { res.json(await search(userOf(req), q)); } catch (err) { failed(res, err); }
});

/** GET /api/spotify/library/:what?offset= — playlists, liked (songs) or albums, 50 at a time. */
spotifyRouter.get('/library/:what', async (req: Request, res: Response) => {
  const what = req.params.what;
  if (what !== 'playlists' && what !== 'liked' && what !== 'albums') return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  const raw = typeof req.query.offset === 'string' ? req.query.offset : '0';
  const offset = /^\d{1,6}$/.test(raw) ? Number(raw) : 0;
  try { res.json(await library(userOf(req), what, offset)); } catch (err) { failed(res, err); }
});
