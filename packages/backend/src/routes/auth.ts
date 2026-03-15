import { Router, Request, Response } from 'express';
import {
  validateCredentials,
  issueTokens,
  verifyRefreshToken,
  findUserById,
} from '../auth/auth.service';
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
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required', code: 'VALIDATION_ERROR' });
  }

  const user = await validateCredentials(username, password);
  if (!user) {
    logger.warn({ username }, 'Failed login attempt');
    return res.status(401).json({ error: 'Invalid credentials', code: 'UNAUTHORIZED' });
  }

  const { accessToken, refreshToken } = issueTokens(user);
  res.cookie(REFRESH_COOKIE, refreshToken, COOKIE_OPTS);

  logger.info({ userId: user.id, name: user.name }, 'User logged in');
  res.json({
    accessToken,
    user: { id: user.id, name: user.name, role: user.role },
  });
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
    res.json({ accessToken });
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
