/**
 * Where loading the AI models after a start has got to, so the app can say that Chat will be
 * slow for a few minutes (and why), and when it's ready. Apps ask GET /api/system/ai-warmup.
 *
 * - off:     nothing is being loaded: a backup HomeHub, or a computer that lets models go after
 *            5 minutes, so loading them now would be wasted. Nothing to show.
 * - loading: on `step` of STEPS, since `startedAt`.
 * - ready:   since `readyAt`.
 * - failed:  no model loaded: Ollama didn't answer.
 */
export type WarmupState = 'off' | 'loading' | 'ready' | 'failed';

/** Loading the models, then reading the instructions for the rewrite, the form and chat. */
export const WARMUP_STEPS = 4;

export interface WarmupStatus {
  state: WarmupState;
  step: number;
  steps: number;
  startedAt: string | null;
  readyAt: string | null;
}

let status: WarmupStatus = { state: 'off', step: 0, steps: WARMUP_STEPS, startedAt: null, readyAt: null };

export function warmupStatus(): WarmupStatus {
  return { ...status };
}

function set(next: Partial<WarmupStatus>): void {
  status = { ...status, ...next };
}

export function warmupStarted(now = new Date()): void {
  set({ state: 'loading', step: 1, startedAt: now.toISOString(), readyAt: null });
}

export function warmupStep(step: number): void {
  if (status.state === 'loading' && step > status.step) set({ step: Math.min(step, WARMUP_STEPS) });
}

export function warmupDone(ok: boolean, now = new Date()): void {
  set(ok ? { state: 'ready', step: WARMUP_STEPS, readyAt: now.toISOString() } : { state: 'failed', readyAt: null });
}

/** For tests. */
export function resetWarmup(): void {
  status = { state: 'off', step: 0, steps: WARMUP_STEPS, startedAt: null, readyAt: null };
}
