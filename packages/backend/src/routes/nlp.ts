import { Router, Request, Response } from 'express';
import { processMessage, processMessageStream, type ChatMessage } from '../nlp/nlp.service';
import { getCommandStats } from '../nlp/command-log';
import { logger } from '../logger';

export const nlpRouter = Router();

// GET /api/nlp/stats  (how often the rules answered, and what they missed)
nlpRouter.get('/stats', (_req: Request, res: Response) => {
  res.json(getCommandStats());
});

// POST /api/nlp  (non-streaming, kept for compatibility)
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

// POST /api/nlp/stream  (Server-Sent Events streaming)
nlpRouter.post('/stream', async (req: Request, res: Response) => {
  const { message, history = [] } = req.body as { message?: string; history?: ChatMessage[] };

  if (!message?.trim()) {
    return res.status(400).json({ error: 'message is required', code: 'VALIDATION_ERROR' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    for await (const event of processMessageStream(message.trim(), history)) {
      send(event);
      if (event.type === 'done' || event.type === 'error') break;
    }
  } catch (err: any) {
    logger.error(err, 'NLP stream failed');
    send({ type: 'error', message: 'NLP service unavailable.' });
  }

  res.end();
});
