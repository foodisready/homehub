import { Router, Request, Response } from 'express';
import { processMessage, processMessageStream, type ChatMessage } from '../nlp/nlp.service';
import { getCommandStats } from '../nlp/command-log';
import { dismissMiss, listMisses, teach, TeachError, type MissSource } from '../nlp/teach';
import { requireAdmin } from '../middleware/auth';
import { BUILT_IN, MAX_CUSTOM, MAX_LENGTH, MOMENTS, ReplyError, getReplyChoices, saveReplyChoices } from '../nlp/replies';
import { logger } from '../logger';
import { activityMiddleware } from '../activity/activity';
import { VOICE_LANGUAGES, bridgeForSettings, getVoiceSettings, setVoiceSettings } from '../system/voice-bridge';
import { BRIDGE_LATE_MS } from '../system/health';

export const nlpRouter = Router();

// Changes made from Chat are recorded as such in Activity.
nlpRouter.use(activityMiddleware('chat'));

// GET /api/nlp/stats  (how often the rules answered, and what they missed)
nlpRouter.get('/stats', (_req: Request, res: Response) => {
  res.json(getCommandStats());
});

// GET /api/nlp/voice — Settings → Voice control: on or off, and languages. Admin only.
nlpRouter.get('/voice', requireAdmin, (_req: Request, res: Response) => {
  res.json({
    ...getVoiceSettings(),
    languagesOffered: VOICE_LANGUAGES,
    // What the bridge said last, so Settings can say whether it's there and what it's doing.
    bridge: bridgeForSettings(Date.now(), BRIDGE_LATE_MS),
  });
});

// PUT /api/nlp/voice { enabled, languages } — the bridge restarts to apply it, within a minute.
nlpRouter.put('/voice', requireAdmin, (req: Request, res: Response) => {
  try {
    const saved = setVoiceSettings(req.body);
    logger.info({ ...saved, by: req.user?.name }, 'Voice settings changed');
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message, code: 'VALIDATION_ERROR' });
  }
});

// GET /api/nlp/misses — commands the rules didn't understand, to teach. Admin only.
nlpRouter.get('/misses', requireAdmin, (_req: Request, res: Response) => {
  res.json(listMisses());
});

const missRef = (body: Record<string, unknown>): { source: MissSource; id: number } | null =>
  (body.source === 'voice' || body.source === 'chat') && Number.isInteger(body.id)
    ? { source: body.source, id: body.id as number }
    : null;

// POST /api/nlp/teach { source, id, phrase, deviceIds | sceneId }
nlpRouter.post('/teach', requireAdmin, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const ref = missRef(body);
  if (!ref) return res.status(400).json({ error: 'source and id are required', code: 'VALIDATION_ERROR' });
  try {
    res.json(teach({ ...ref, phrase: body.phrase, deviceIds: body.deviceIds, sceneId: body.sceneId }));
  } catch (err) {
    if (err instanceof TeachError) return res.status(400).json({ error: err.message, code: 'TEACH_ERROR' });
    logger.error({ err }, 'Teaching failed');
    res.status(500).json({ error: 'Could not save that', code: 'INTERNAL_ERROR' });
  }
});

// POST /api/nlp/misses/dismiss { source, id } — leave a miss out of the list
nlpRouter.post('/misses/dismiss', requireAdmin, (req: Request, res: Response) => {
  const ref = missRef((req.body ?? {}) as Record<string, unknown>);
  if (!ref) return res.status(400).json({ error: 'source and id are required', code: 'VALIDATION_ERROR' });
  try {
    dismissMiss(ref.source, ref.id);
    res.status(204).end();
  } catch (err) {
    if (err instanceof TeachError) return res.status(404).json({ error: err.message, code: 'NOT_FOUND' });
    throw err;
  }
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
  // A slow model can think for minutes without a word. Proxies (nginx, Tailscale)
  // close a quiet connection after about a minute, so say something meanwhile.
  // Lines starting with ":" are comments that the browser ignores.
  const heartbeat = setInterval(() => res.write(': waiting\n\n'), 15_000);

  try {
    for await (const event of processMessageStream(message.trim(), history)) {
      send(event);
      if (event.type === 'done' || event.type === 'error') break;
    }
  } catch (err: any) {
    logger.error(err, 'NLP stream failed');
    send({ type: 'error', message: 'NLP service unavailable.' });
  } finally {
    clearInterval(heartbeat);
  }

  res.end();
});

// GET /api/nlp/replies — the built-in replies to choose from and the current choices. Admin only.
nlpRouter.get('/replies', requireAdmin, (_req: Request, res: Response) => {
  res.json({ moments: MOMENTS, builtIn: BUILT_IN, chosen: getReplyChoices(), maxCustom: MAX_CUSTOM, maxLength: MAX_LENGTH });
});

// PUT /api/nlp/replies { on: { builtIn: [ids], custom: [text] }, off: …, timer: …, scene: …, not_understood: … }
nlpRouter.put('/replies', requireAdmin, (req: Request, res: Response) => {
  try {
    res.json({ chosen: saveReplyChoices(req.body) });
  } catch (err) {
    if (err instanceof ReplyError) return res.status(400).json({ error: err.message, code: 'REPLY_ERROR' });
    logger.error({ err }, 'Saving replies failed');
    res.status(500).json({ error: 'Could not save the replies', code: 'INTERNAL_ERROR' });
  }
});
