import { Router } from 'express';

export const healthRouter = Router();

/** The release this backend is, such as v0.1.3, or "dev" outside a release image. The installer shows it. */
healthRouter.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'backend', version: process.env.HOMEHUB_VERSION || 'dev' });
});
