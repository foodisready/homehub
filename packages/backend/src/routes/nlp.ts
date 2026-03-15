import { Router, Request, Response } from 'express';
import { processMessage, type ChatMessage } from '../nlp/nlp.service';
import { logger } from '../logger';

export const nlpRouter = Router();

// POST /api/nlp
nlpRouter.post('/', async (req: Request, res: Response) => {
  const { message, history = [] } = req.body as { message?: string; history?: ChatMessage[] };

  if (!message?.trim()) {
    return res.status(400).json({ error: 'message is required', code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await processMessage(message.trim(), history);
    res.json(result);
  } catch (err: any) {
    logger.error(err, 'NLP processing failed');
    res.status(503).json({ error: 'NLP service unavailable. Is Ollama running?', code: 'NLP_ERROR' });
  }
});
