import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import {
  aiMode, aiUsage, CLAUDE_MODEL, claudeErrorText, claudeKey, clearClaudeError, costUsd, keyHint, LIMIT_RANGE,
  looksLikeKey, monthlyLimitUsd, overLimit, PRICE_PER_MTOK, removeClaudeKey, setAiMode, setClaudeKey, setMonthlyLimit,
} from '../nlp/ai-choice';

/**
 * Which AI understands what the rules don’t in Chat, mounted at /api/ai (admin only). The key is never sent
 * back: only its last four characters.
 */
export const aiRouter = Router();
aiRouter.use(requireAdmin);

/** Asks Anthropic whether the key works. Costs nothing: it only looks the model up. Replaced in tests. */
let verifyKey = async (key: string): Promise<string | null> => {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  try {
    await new Anthropic({ apiKey: key, timeout: 10_000, maxRetries: 1 }).models.retrieve(CLAUDE_MODEL);
    return null;
  } catch (err) {
    if (err instanceof Anthropic.APIError) return claudeErrorText(err.status, err.message);
    return claudeErrorText(undefined, (err as Error).message);
  }
};
export function setKeyVerifier(fn: typeof verifyKey): void { verifyKey = fn; }

function view() {
  const usage = aiUsage();
  return {
    mode:    aiMode(),
    keyHint: keyHint(claudeKey()),
    model:   CLAUDE_MODEL,
    price:   PRICE_PER_MTOK,
    usage:   { ...usage, costUsd: costUsd(usage) },
    monthlyLimitUsd: monthlyLimitUsd(),
    overLimit:       overLimit(),
  };
}

// GET /api/ai
aiRouter.get('/', (_req: Request, res: Response) => { res.json(view()); });

// PUT /api/ai  { mode?: 'local' | 'claude', apiKey?: string, monthlyLimitUsd?: number | null }
aiRouter.put('/', async (req: Request, res: Response) => {
  const { mode, apiKey, monthlyLimitUsd: limit } = (req.body ?? {}) as { mode?: unknown; apiKey?: unknown; monthlyLimitUsd?: unknown };
  if (mode !== undefined && mode !== 'local' && mode !== 'claude') {
    return res.status(400).json({ error: 'Choose this HomeHub or Claude Haiku.', code: 'VALIDATION_ERROR' });
  }
  if (limit !== undefined && limit !== null &&
      (typeof limit !== 'number' || !Number.isFinite(limit) || limit < LIMIT_RANGE.min || limit > LIMIT_RANGE.max)) {
    return res.status(400).json({ error: `A monthly limit is from $${LIMIT_RANGE.min.toFixed(2)} to $${LIMIT_RANGE.max}.`, code: 'VALIDATION_ERROR' });
  }
  if (apiKey !== undefined) {
    if (typeof apiKey !== 'string' || !looksLikeKey(apiKey)) {
      return res.status(400).json({ error: 'That doesn’t look like an Anthropic API key. It starts with sk-ant-.', code: 'VALIDATION_ERROR' });
    }
    const problem = await verifyKey(apiKey.trim());
    if (problem) return res.status(400).json({ error: problem, code: 'KEY_REJECTED' });
    setClaudeKey(apiKey);
    clearClaudeError();
  }
  if (mode === 'claude' && !claudeKey()) {
    return res.status(400).json({ error: 'Enter an Anthropic API key first.', code: 'NO_KEY' });
  }
  if (mode !== undefined) setAiMode(mode);
  if (limit !== undefined) setMonthlyLimit(limit === null ? null : Math.round(limit * 100) / 100);
  res.json(view());
});

// POST /api/ai/check — is the saved key still accepted?
aiRouter.post('/check', async (_req: Request, res: Response) => {
  const key = claudeKey();
  if (!key) return res.status(400).json({ error: 'No key is saved.', code: 'NO_KEY' });
  const problem = await verifyKey(key);
  if (problem) return res.status(400).json({ error: problem, code: 'KEY_REJECTED' });
  clearClaudeError();
  res.json(view());
});

// DELETE /api/ai/key — forget the key; this HomeHub's model answers from now on
aiRouter.delete('/key', (_req: Request, res: Response) => {
  removeClaudeKey();
  res.json(view());
});
