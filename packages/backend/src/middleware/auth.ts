import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, type TokenPayload } from '../auth/auth.service';

// Extend Express Request to carry the authenticated user
declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

/**
 * Verifies the Bearer token in the Authorization header.
 * Attaches `req.user` on success; returns 401 otherwise.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header', code: 'UNAUTHORIZED' });
    return;
  }

  const token = header.slice(7);
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Token expired or invalid', code: 'UNAUTHORIZED' });
  }
}

/**
 * Requires `req.user.role === 'admin'`.
 * Must be used after `authenticate`.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required', code: 'FORBIDDEN' });
    return;
  }
  next();
}
