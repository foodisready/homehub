import { Router, Request, Response } from 'express';
import {
  validateCredentials,
  issueTokens,
  verifyRefreshToken,
  findUserById,
  needsSetup,
  createFirstAdmin,
  SetupError,
} from '../auth/auth.service';
import { startLoginAttempt } from '../auth/login-limiter';
import { checkInvite, redeemInvite, InviteError } from '../auth/invites';
import { logger } from '../logger';

export const authRouter = Router();

const REFRESH_COOKIE = 'refreshToken';

const COOKIE_OPTS = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path:     '/api/auth/refresh',
  maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days in ms
};

// POST /api/auth/login
authRouter.post('/login', async (req: Request, res: Response) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'username and password are required', code: 'VALIDATION_ERROR' });
  }

  const address = req.socket.remoteAddress ?? 'unknown';
  const attempt = startLoginAttempt(address, username);
  if (!attempt.allowed) {
    const minutes = Math.ceil(attempt.retryAfterSeconds / 60);
    logger.warn({ username, address }, 'Login blocked by rate limit');
    res.set('Retry-After', String(attempt.retryAfterSeconds));
    return res.status(429).json({
      error: `Too many failed login attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      code:  'RATE_LIMITED',
    });
  }

  const user = await validateCredentials(username, password);
  if (!user) {
    logger.warn({ username }, 'Failed login attempt');
    return res.status(401).json({ error: 'Invalid credentials', code: 'UNAUTHORIZED' });
  }

  attempt.succeeded();
  const { accessToken, refreshToken } = issueTokens(user);
  res.cookie(REFRESH_COOKIE, refreshToken, COOKIE_OPTS);

  logger.info({ userId: user.id, name: user.name }, 'User logged in');
  res.json({
    accessToken,
    user: { id: user.id, name: user.name, role: user.role },
  });
});

// GET /api/auth/setup — whether HomeHub still needs its first admin account
authRouter.get('/setup', (_req: Request, res: Response) => {
  res.json({ needed: needsSetup() });
});

// POST /api/auth/setup — create the first admin, then sign them in. Works only while there are no users.
authRouter.post('/setup', async (req: Request, res: Response) => {
  const { username, password } = req.body as { username?: unknown; password?: unknown };
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'username and password are required', code: 'VALIDATION_ERROR' });
  }
  try {
    const user = await createFirstAdmin(username, password);
    const { accessToken, refreshToken } = issueTokens(user);
    res.cookie(REFRESH_COOKIE, refreshToken, COOKIE_OPTS);
    logger.info({ userId: user.id, name: user.name, address: req.socket.remoteAddress }, 'First admin created');
    res.status(201).json({ accessToken, user: { id: user.id, name: user.name, role: user.role } });
  } catch (err) {
    if (err instanceof SetupError) {
      return res.status(err.status).json({ error: err.message, code: err.status === 409 ? 'ALREADY_SET_UP' : 'VALIDATION_ERROR' });
    }
    throw err;
  }
});

// ── Family invites ───────────────────────────────────────────────
// The code travels in the body, not the URL, so it doesn't land in logs.

/** Guesses count against the login limit, like wrong passwords. */
function inviteAttempt(req: Request, res: Response) {
  const attempt = startLoginAttempt(req.socket.remoteAddress ?? 'unknown', '(invite)');
  if (!attempt.allowed) {
    res.set('Retry-After', String(attempt.retryAfterSeconds));
    res.status(429).json({ error: 'Too many tries. Wait a few minutes, then try again.', code: 'RATE_LIMITED' });
    return null;
  }
  return attempt;
}

// POST /api/auth/invite { code } — whether an invite still works
authRouter.post('/invite', (req: Request, res: Response) => {
  const attempt = inviteAttempt(req, res);
  if (!attempt) return;
  try {
    const result = checkInvite(req.body?.code);
    attempt.succeeded();
    res.json(result);
  } catch (err) {
    if (err instanceof InviteError) return res.status(err.status).json({ error: err.message, code: 'INVALID_INVITE' });
    throw err;
  }
});

// POST /api/auth/join { code, username, password } — make a family login from an invite, then sign in
authRouter.post('/join', async (req: Request, res: Response) => {
  const attempt = inviteAttempt(req, res);
  if (!attempt) return;
  const { code, username, password } = (req.body ?? {}) as Record<string, unknown>;
  try {
    const user = await redeemInvite(code, username, password);
    attempt.succeeded();
    const { accessToken, refreshToken } = issueTokens(user);
    res.cookie(REFRESH_COOKIE, refreshToken, COOKIE_OPTS);
    logger.info({ userId: user.id, name: user.name }, 'Family member joined with an invite');
    res.status(201).json({ accessToken, user: { id: user.id, name: user.name, role: user.role } });
  } catch (err) {
    if (err instanceof InviteError) {
      // A name already taken or a short password is the person's typo, not a guess.
      if (err.status === 400 || err.status === 409) attempt.succeeded();
      return res.status(err.status).json({ error: err.message, code: err.status === 409 ? 'CONFLICT' : err.status === 400 ? 'VALIDATION_ERROR' : 'INVALID_INVITE' });
    }
    throw err;
  }
});

// POST /api/auth/refresh
authRouter.post('/refresh', (req: Request, res: Response) => {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!token) {
    return res.status(401).json({ error: 'No refresh token', code: 'UNAUTHORIZED' });
  }

  try {
    const payload = verifyRefreshToken(token);
    const user    = findUserById(payload.sub);
    if (!user) return res.status(401).json({ error: 'User not found', code: 'UNAUTHORIZED' });

    const { accessToken, refreshToken: newRefresh } = issueTokens(user);
    // Rotate the refresh token
    res.cookie(REFRESH_COOKIE, newRefresh, COOKIE_OPTS);
    res.json({ accessToken, user: { id: user.id, name: user.name, role: user.role } });
  } catch {
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth/refresh' });
    res.status(401).json({ error: 'Refresh token expired or invalid', code: 'UNAUTHORIZED' });
  }
});

// POST /api/auth/logout
authRouter.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth/refresh' });
  res.status(204).send();
});
