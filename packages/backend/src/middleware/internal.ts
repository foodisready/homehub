import { Request, Response, NextFunction } from 'express';

/**
 * Guards internal service-to-service endpoints.
 * Requires `X-Internal-Key: $INTERNAL_API_KEY` header.
 */
export function requireInternalKey(req: Request, res: Response, next: NextFunction): void {
  const key = process.env.INTERNAL_API_KEY;
  if (!key) {
    // If no key is configured, block all internal calls
    res.status(503).json({ error: 'Internal API not configured', code: 'NOT_CONFIGURED' });
    return;
  }
  if (req.headers['x-internal-key'] !== key) {
    res.status(401).json({ error: 'Invalid internal key', code: 'UNAUTHORIZED' });
    return;
  }
  next();
}
