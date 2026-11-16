import { getDb } from '../db';

/**
 * Which AI understands what the rules don't: the model on this HomeHub (the default; free,
 * private, works without the internet), or Claude Haiku with the household's own Anthropic key.
 *
 * Stored in the settings table. The key's row name contains "key", so backups hide it
 * (db/json-backup.ts SECRET_SETTING) and it's never sent back to the browser.
 */

export const AI_CHOICE_KEY = 'ai_choice';
export const ANTHROPIC_KEY_SETTING = 'anthropic_api_key';
export const AI_USAGE_KEY = 'ai_usage';

export const CLAUDE_MODEL = 'claude-haiku-5-5';
export const CLAUDE_LABEL = 'Claude Haiku';
/** US dollars per million tokens, prompts up to 100,000 tokens (HomeHub's are about 2,000). */
export const PRICE_PER_MTOK = { input: 0.10, output: 0.50 };

export type AiMode = 'local' | 'claude';

function read<T>(key: string): T | null {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function aiMode(): AiMode {
  return read<{ mode?: string }>(AI_CHOICE_KEY)?.mode === 'claude' ? 'claude' : 'local';
}

export function claudeKey(): string | null {
  const k = read<string>(ANTHROPIC_KEY_SETTING);
  return typeof k === 'string' && k.trim() ? k.trim() : null;
}

/** The key to use for this message, or null to use the model on this HomeHub. */
export function claudeInUse(): string | null {
  return aiMode() === 'claude' ? claudeKey() : null;
}

export function setAiMode(mode: AiMode): void { write(AI_CHOICE_KEY, { mode }); }
export function setClaudeKey(key: string): void { write(ANTHROPIC_KEY_SETTING, key.trim()); }
export function removeClaudeKey(): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(ANTHROPIC_KEY_SETTING);
  setAiMode('local');
}

/** The last characters of the key, so a person can tell which one is saved. */
export function keyHint(key: string | null): string | null {
  return key ? `…${key.slice(-4)}` : null;
}

/** Plausible shape of an Anthropic API key. The real check is asking Anthropic. */
export function looksLikeKey(key: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key.trim());
}

// ── Usage, this month ─────────────────────────────────────────────

export interface AiUsage {
  /** 'YYYY-MM' in the home's time zone. */
  month:        string;
  requests:     number;
  inputTokens:  number;
  outputTokens: number;
  /** Messages that went to this HomeHub's model because Claude couldn't be reached. */
  fallbacks:    number;
  lastError?:   string;
  lastErrorAt?: string;
}

function monthOf(now: Date): string {
  const tz = process.env.TIMEZONE || process.env.TZ || undefined;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(now);
    return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}`;
  } catch {
    return now.toISOString().slice(0, 7);
  }
}

export function aiUsage(now = new Date()): AiUsage {
  const month = monthOf(now);
  const u = read<AiUsage>(AI_USAGE_KEY);
  const fresh: AiUsage = { month, requests: 0, inputTokens: 0, outputTokens: 0, fallbacks: 0 };
  if (!u || u.month !== month) return { ...fresh, ...(u?.lastError ? { lastError: u.lastError, lastErrorAt: u.lastErrorAt } : {}) };
  return { ...fresh, ...u };
}

export function recordClaudeUse(inputTokens: number, outputTokens: number, now = new Date()): void {
  const u = aiUsage(now);
  write(AI_USAGE_KEY, { ...u, requests: u.requests + 1, inputTokens: u.inputTokens + inputTokens, outputTokens: u.outputTokens + outputTokens });
}

/** Claude couldn't answer, so this HomeHub's model did. */
export function recordClaudeFailure(error: string, now = new Date()): void {
  const u = aiUsage(now);
  write(AI_USAGE_KEY, { ...u, fallbacks: u.fallbacks + 1, lastError: error.slice(0, 300), lastErrorAt: now.toISOString() });
}

export function clearClaudeError(): void {
  const u = aiUsage();
  delete u.lastError;
  delete u.lastErrorAt;
  write(AI_USAGE_KEY, u);
}

export function costUsd(u: Pick<AiUsage, 'inputTokens' | 'outputTokens'>): number {
  return (u.inputTokens * PRICE_PER_MTOK.input + u.outputTokens * PRICE_PER_MTOK.output) / 1_000_000;
}

/** A short reason a person can act on, from an Anthropic error. Never includes the key. */
export function claudeErrorText(status: number | undefined, message: string): string {
  if (status === 401) return 'Anthropic rejected the key. Check it was copied whole, or make a new one.';
  if (status === 403) return 'The key isn’t allowed to use Claude Haiku.';
  if (status === 429) return 'Anthropic is limiting requests, or the account’s spending limit was reached.';
  if (status === 400 && /credit|billing|balance/i.test(message)) return 'The Anthropic account is out of credit.';
  if (status !== undefined && status >= 500) return 'Anthropic had a problem answering.';
  if (status === undefined) return 'Couldn’t reach Anthropic. Is the internet down?';
  return `Anthropic answered with an error (${status}).`;
}
