import { Router, Request, Response } from 'express';
import { addMatterDevice } from '../matter/service';
import { logger } from '../logger';

// matter.js loads only when Matter is used.
const matter = () => import('../matter/controller');

/** Adding Matter devices. Admin only, mounted at /api/matter. */
export const matterRouter = Router();

// POST /api/matter/pair { code } — pair a shared device and add each part that can be switched
matterRouter.post('/pair', async (req: Request, res: Response) => {
  const code = req.body?.code;
  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: 'Enter the pairing code.', code: 'VALIDATION_ERROR' });
  }
  try {
    const devices = await addMatterDevice(code);
    logger.info({ by: req.user?.name, devices: devices.length }, 'Matter device paired from Settings');
    res.status(201).json({ devices });
  } catch (err) {
    const { MatterError } = await matter();
    if (err instanceof MatterError) return res.status(err.status).json({ error: err.message, code: 'MATTER_PAIRING_FAILED' });
    throw err;
  }
});

