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
  /** Whether a speaker is listening again after the start; missing from a HomeHub before v0.1.98. */
  voice?: VoiceReady;
}

export interface VoiceReady {
  state: 'off' | 'starting' | 'ready' | 'missing';
  startedAt: string;
  readyAt: string | null;
  /** Still loading its speech models, rather than looking for the speakers. */
  loading: boolean;
}

const WHILE_LOADING_MS = 10_000;
const OTHERWISE_MS = 60_000;
/** How long "ready" shows after loading this tab saw. */
const READY_SHOWN_MS = 8_000;
const DISMISSED_KEY = 'homehub-ai-failed-dismissed';
const VOICE_DISMISSED_KEY = 'homehub-voice-missing-dismissed';

/**
 * After every start (an update, a power cut, a reboot), HomeHub loads its AI models, which takes a
 * few minutes on a Pi; until then Chat is slow. The voice bridge restarts too, and the speakers
 * can't hear anyone for about a minute, until it has loaded its speech models and found them.
 * This asks how far both have got, so the app can say so.
 */
@Injectable({ providedIn: 'root' })
export class AiWarmupService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  readonly status = signal<AiWarmup | null>(null);
  /** This tab saw it loading, and it finished just now. */
  readonly justReady = signal(false);
  /** This tab saw voice starting (or missing), and a speaker is listening again just now. */
  readonly voiceJustReady = signal(false);
  private readonly dismissedFailure = signal(this.readDismissed(DISMISSED_KEY));
  private readonly dismissedVoice = signal(this.readDismissed(VOICE_DISMISSED_KEY));
  readonly now = signal(Date.now());
  private timer: ReturnType<typeof setTimeout> | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private voiceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Chat waits for this HomeHub's models: loading, and Chat doesn't use Claude. */
  readonly loading = computed(() => { const s = this.status(); return s?.state === 'loading' && !s.claude; });
  readonly failed = computed(() => {
    const s = this.status();
    return s?.state === 'failed' && !s.claude && this.dismissedFailure() !== s.startedAt;
  });

  /** Voice isn't back yet after the start: the speakers can't hear anyone. */
  readonly voiceStarting = computed(() => this.status()?.voice?.state === 'starting');
  readonly voiceMissing = computed(() => {
    const v = this.status()?.voice;
    return v?.state === 'missing' && this.dismissedVoice() !== v.startedAt;
  });

  /** "1:23" since loading started. */
  readonly elapsed = computed(() => this.since(this.status()?.startedAt));
  /** "0:45" since HomeHub started, while voice is starting. */
  readonly voiceElapsed = computed(() => this.since(this.status()?.voice?.startedAt));

  private since(at: string | null | undefined): string {
    const started = Date.parse(at ?? '');
    if (!started) return '';
    const s = Math.max(0, Math.floor((this.now() - started) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

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

  dismissVoiceMissing(): void {
    const at = this.status()?.voice?.startedAt ?? '';
    this.dismissedVoice.set(at);
    try { sessionStorage.setItem(VOICE_DISMISSED_KEY, at); } catch { /* private mode */ }
  }

  dismissFailure(): void {
    const at = this.status()?.startedAt ?? '';
    this.dismissedFailure.set(at);
    try { sessionStorage.setItem(DISMISSED_KEY, at); } catch { /* private mode */ }
  }

  private update(s: AiWarmup): void {
    const was = this.status()?.state;
    const voiceWas = this.status()?.voice?.state;
    this.status.set(s);
    if (was === 'loading' && s.state === 'ready' && !s.claude) {
      this.justReady.set(true);
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = setTimeout(() => this.justReady.set(false), READY_SHOWN_MS);
    }
    if ((voiceWas === 'starting' || voiceWas === 'missing') && s.voice?.state === 'ready') {
      this.voiceJustReady.set(true);
      if (this.voiceTimer) clearTimeout(this.voiceTimer);
      this.voiceTimer = setTimeout(() => this.voiceJustReady.set(false), READY_SHOWN_MS);
    }
    const waiting = s.state === 'loading' || s.voice?.state === 'starting' || s.voice?.state === 'missing';
    if (waiting) {
      this.clock ??= setInterval(() => this.now.set(Date.now()), 1000);
    } else if (this.clock) {
      clearInterval(this.clock);
      this.clock = null;
    }
    this.schedule(waiting ? WHILE_LOADING_MS : OTHERWISE_MS);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (this.auth.isLoggedIn()) this.check(); }, ms);
  }

  private stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.clock) { clearInterval(this.clock); this.clock = null; }
  }

  private readDismissed(key: string): string | null {
    try { return sessionStorage.getItem(key); } catch { return null; }
  }
}
