import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AuthService } from '../auth/auth.service';

export interface AiWarmup {
  state: 'off' | 'loading' | 'ready' | 'failed';
  step: number;
  steps: number;
  startedAt: string | null;
  readyAt: string | null;
  /** Chat uses Claude Haiku, so it doesn't wait for this HomeHub's own models. */
  claude: boolean;
}

const WHILE_LOADING_MS = 10_000;
const OTHERWISE_MS = 60_000;
/** How long "ready" shows after loading this tab saw. */
const READY_SHOWN_MS = 8_000;
const DISMISSED_KEY = 'homehub-ai-failed-dismissed';

/**
 * After every start (an update, a power cut, a reboot), HomeHub loads its AI models, which takes a
 * few minutes on a Pi. Until then Chat is slow; lights, scenes, schedules and voice aren't affected.
 * This asks how far it has got, so the app can say so.
 */
@Injectable({ providedIn: 'root' })
export class AiWarmupService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  readonly status = signal<AiWarmup | null>(null);
  /** This tab saw it loading, and it finished just now. */
  readonly justReady = signal(false);
  private readonly dismissedFailure = signal(this.readDismissed());
  readonly now = signal(Date.now());
  private timer: ReturnType<typeof setTimeout> | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;

  /** Chat waits for this HomeHub's models: loading, and Chat doesn't use Claude. */
  readonly loading = computed(() => { const s = this.status(); return s?.state === 'loading' && !s.claude; });
  readonly failed = computed(() => {
    const s = this.status();
    return s?.state === 'failed' && !s.claude && this.dismissedFailure() !== s.startedAt;
  });

  /** "1:23" since loading started. */
  readonly elapsed = computed(() => {
    const started = Date.parse(this.status()?.startedAt ?? '');
    if (!started) return '';
    const s = Math.max(0, Math.floor((this.now() - started) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });

  constructor() {
    effect(() => {
      if (this.auth.isLoggedIn()) this.check();
      else { this.stop(); this.status.set(null); }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.auth.isLoggedIn()) this.check();
    });
  }

  check(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.http.get<AiWarmup>('/api/system/ai-warmup').subscribe({
      next: (s) => this.update(s),
      // Restarting, or an older HomeHub without this: ask again later.
      error: () => this.schedule(OTHERWISE_MS),
    });
  }

  dismissFailure(): void {
    const at = this.status()?.startedAt ?? '';
    this.dismissedFailure.set(at);
    try { sessionStorage.setItem(DISMISSED_KEY, at); } catch { /* private mode */ }
  }

  private update(s: AiWarmup): void {
    const was = this.status()?.state;
    this.status.set(s);
    if (was === 'loading' && s.state === 'ready' && !s.claude) {
      this.justReady.set(true);
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = setTimeout(() => this.justReady.set(false), READY_SHOWN_MS);
    }
    if (s.state === 'loading') {
      this.clock ??= setInterval(() => this.now.set(Date.now()), 1000);
    } else if (this.clock) {
      clearInterval(this.clock);
      this.clock = null;
    }
    this.schedule(s.state === 'loading' ? WHILE_LOADING_MS : OTHERWISE_MS);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (this.auth.isLoggedIn()) this.check(); }, ms);
  }

  private stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.clock) { clearInterval(this.clock); this.clock = null; }
  }

  private readDismissed(): string | null {
    try { return sessionStorage.getItem(DISMISSED_KEY); } catch { return null; }
  }
}
