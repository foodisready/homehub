import { Component, OnInit, OnDestroy, signal, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { HealthReport, SystemService, SystemVersion } from '../../core/services/system.service';

const POLL_IDLE_MS    = 60_000;
const POLL_UPDATE_MS  = 3_000;
const UPDATE_DEADLINE = 5 * 60_000;
const RELOAD_AFTER_MS = 2_500;

type Phase = 'idle' | 'confirm' | 'updating' | 'done' | 'failed';

/**
 * The Update card on the dashboard, shown when a newer release exists. While
 * an update runs, an overlay covers the page: HomeHub restarts, so switching
 * things then would fail. When the new version answers, the page reloads to
 * pick up the new version's screens.
 */
@Component({
  selector: 'app-system-status',
  standalone: true,
  imports: [RouterLink],
  styles: [`
    .health {
      display: flex; align-items: center; gap: 0.6rem; margin-bottom: 1.25rem;
      padding: 0.7rem 1rem; border-radius: 8px; font-size: 0.88rem; color: var(--text);
      background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.55);
    }
    .health.problem { background: rgba(248,113,113,0.08); border-color: rgba(248,113,113,0.6); }
    .health .mark { font-weight: 800; color: #f59e0b; }
    .health.problem .mark { color: var(--red); }
    .health .go { margin-left: auto; white-space: nowrap; }
    .card {
      background: rgba(30,64,175,0.08);
      border: 1px solid #1e40af;
      border-radius: 8px;
      padding: 0.85rem 1rem;
      margin-bottom: 1.25rem;
      display: flex; align-items: center; justify-content: space-between; gap: 0.75rem 1rem; flex-wrap: wrap;
    }
    .info { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
    .label { font-size: 0.85rem; color: var(--text-muted); }
    .label strong { color: var(--text); }
    .badge { font-size: 0.7rem; padding: 0.2rem 0.55rem; border-radius: 999px; background: #1e40af; color: #fff; }
    .right { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    .confirm-text { font-size: 0.85rem; color: var(--text); }
    .btn {
      font-size: 0.85rem; padding: 0.4rem 0.85rem; border-radius: 6px;
      border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer;
    }
    .btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Covers the whole app, nav included, so nothing can be tapped mid-update. */
    .overlay {
      position: fixed; inset: 0; z-index: 1000;
      background: rgba(2, 6, 23, 0.82); backdrop-filter: blur(3px);
      display: flex; align-items: center; justify-content: center; padding: 1rem;
    }
    .panel {
      width: 100%; max-width: 24rem; text-align: center;
      background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
      padding: 1.75rem 1.25rem;
    }
    .panel h2 { font-size: 1.15rem; margin: 0.9rem 0 0.4rem; }
    .panel p { font-size: 0.88rem; color: var(--text-muted); line-height: 1.5; margin: 0; }
    .spinner {
      width: 2.6rem; height: 2.6rem; margin: 0 auto; border-radius: 50%;
      border: 3px solid rgba(148,163,184,0.25); border-top-color: var(--accent);
      animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.5s; } }
    .icon { font-size: 2.2rem; line-height: 1; }
    .icon.ok { color: #4ade80; }
    .icon.err { color: #f87171; }
    .elapsed { font-size: 0.78rem; margin-top: 0.75rem !important; }
    .panel .btn { margin-top: 1rem; }
  `],
  template: `
    @if (healthNotice(); as h) {
      <a class="health" [class.problem]="h.problem" routerLink="/health">
        <span class="mark" aria-hidden="true">!</span>
        <span>{{ h.text }}</span>
        <span class="go">Health ›</span>
      </a>
    }

    @if (version(); as v) {
      @if (v.updateAvailable && isAdmin() && phase() !== 'done') {
        <div class="card">
          <div class="info">
            <span class="label">HomeHub <strong>{{ v.running }}</strong></span>
            @if (v.latest) { <span class="label">latest <strong>{{ v.latest }}</strong></span> }
            <span class="badge">Update available</span>
          </div>
          <div class="right">
            @if (phase() === 'confirm') {
              <span class="confirm-text">HomeHub is unavailable for a minute or two while it updates.</span>
              <button class="btn primary" type="button" (click)="start()">Update now</button>
              <button class="btn" type="button" (click)="phase.set('idle')">Cancel</button>
            } @else {
              <button class="btn primary" type="button" (click)="phase.set('confirm')"
                      [disabled]="!v.updaterAvailable" [title]="!v.updaterAvailable ? 'The updater service is not set up' : ''">
                Update HomeHub
              </button>
            }
          </div>
        </div>
      }
    }

    @if (phase() === 'updating' || phase() === 'done' || phase() === 'failed') {
      <div class="overlay" role="alertdialog" aria-modal="true" aria-live="polite" aria-labelledby="update-title">
        <div class="panel">
          @switch (phase()) {
            @case ('updating') {
              <div class="spinner" aria-hidden="true"></div>
              <h2 id="update-title">Updating HomeHub to {{ target() }}</h2>
              <p>{{ stepText() }}</p>
              <p class="elapsed">{{ elapsedText() }}</p>
            }
            @case ('done') {
              <div class="icon ok" aria-hidden="true">✓</div>
              <h2 id="update-title">HomeHub {{ target() }} is ready</h2>
              <p>Reloading…</p>
            }
            @case ('failed') {
              <div class="icon err" aria-hidden="true">!</div>
              <h2 id="update-title">The update didn't finish</h2>
              <p>{{ error() }}</p>
              <button class="btn" type="button" (click)="reload()">Reload the page</button>
            }
          }
        </div>
      </div>
    }
  `,
})
export class SystemStatusComponent implements OnInit, OnDestroy {
  private svc  = inject(SystemService);
  private auth = inject(AuthService);

  readonly version = signal<SystemVersion | null>(null);
  readonly health  = signal<HealthReport | null>(null);
  /** Admins see a one-line notice when Health finds something wrong. */
  readonly healthNotice = computed(() => {
    const h = this.health();
    if (!h || h.status === 'ok' || !this.isAdmin()) return null;
    const bad = h.items.filter((i) => i.level === 'error' || i.level === 'warn');
    const text = bad.length === 1 ? `${bad[0].label}: needs a look` : `${bad.length} things need a look`;
    return { text, problem: h.status === 'problem' };
  });
  readonly phase   = signal<Phase>('idle');
  readonly target  = signal('');
  readonly error   = signal('');
  /** Whether the backend has gone away yet: it restarts partway through. */
  private readonly restarted = signal(false);
  private readonly started   = signal(0);
  private readonly now       = signal(Date.now());

  readonly isAdmin = computed(() => this.auth.user()?.role === 'admin');
  readonly stepText = computed(() => this.restarted()
    ? 'Restarting with the new version…'
    : 'Downloading the new version. Please keep this page open.');
  readonly elapsedText = computed(() => {
    const s = Math.max(0, Math.round((this.now() - this.started()) / 1000));
    return s < 60 ? `${s} seconds` : `${Math.floor(s / 60)} min ${s % 60} s`;
  });

  private idleTimer?:   ReturnType<typeof setInterval>;
  private updateTimer?: ReturnType<typeof setInterval>;
  private clock?:       ReturnType<typeof setInterval>;

  ngOnInit(): void {
    this.refresh();
    this.idleTimer = setInterval(() => this.refresh(), POLL_IDLE_MS);
  }

  ngOnDestroy(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.stopPolling();
  }

  private refresh(): void {
    if (this.phase() === 'updating') return;
    this.svc.version().subscribe({
      next:  (v) => this.version.set(v),
      error: () => { /* unreachable: leave the card as it was */ },
    });
    if (this.isAdmin()) {
      this.svc.health().subscribe({ next: (h) => this.health.set(h), error: () => undefined });
    }
  }

  start(): void {
    const v = this.version();
    if (!v?.updateAvailable) return;
    this.target.set(v.latest ?? '');
    this.error.set('');
    this.restarted.set(false);
    this.started.set(Date.now());
    this.now.set(Date.now());
    this.phase.set('updating');
    this.clock = setInterval(() => this.now.set(Date.now()), 1000);

    this.svc.update().subscribe({
      next: () => this.poll(),
      error: (err) => {
        const code = err?.error?.code;
        // No answer, or a gateway error with no reason: HomeHub was replaced
        // mid-request, which means the update is under way.
        if (!code) { this.restarted.set(true); this.poll(); return; }
        this.fail(
          code === 'UPDATER_OFFLINE'  ? "The updater service isn't running. Run the installer on the HomeHub computer to update instead."
          : code === 'UPDATER_DISABLED' ? "The updater service isn't set up. Run the installer on the HomeHub computer to update instead."
          : code === 'UPDATER_FAILED'   ? 'The updater refused the request. Run the installer on the HomeHub computer to update instead.'
          : err?.error?.error ?? "HomeHub couldn't start the update.",
        );
      },
    });
  }

  /* The backend restarts partway through, so requests fail for a while; then
   * it answers with the new version. Give it 5 minutes. */
  private poll(): void {
    const deadline = Date.now() + UPDATE_DEADLINE;
    this.updateTimer = setInterval(() => {
      this.svc.version().subscribe({
        next: (v) => {
          if (v.running === this.target() || (this.restarted() && !v.updateAvailable)) {
            this.version.set(v);
            this.stopPolling();
            this.phase.set('done');
            setTimeout(() => this.reload(), RELOAD_AFTER_MS);
          } else if (Date.now() > deadline) {
            this.fail(`HomeHub is still running ${v.running} after 5 minutes. Run the installer on the HomeHub computer to update instead.`);
          }
        },
        error: () => {
          this.restarted.set(true);
          if (Date.now() > deadline) this.fail("HomeHub hasn't come back after 5 minutes. Check that the HomeHub computer is on, then reload this page.");
        },
      });
    }, POLL_UPDATE_MS);
  }

  private fail(message: string): void {
    this.stopPolling();
    this.error.set(message);
    this.phase.set('failed');
  }

  private stopPolling(): void {
    if (this.updateTimer) { clearInterval(this.updateTimer); this.updateTimer = undefined; }
    if (this.clock) { clearInterval(this.clock); this.clock = undefined; }
  }

  reload(): void {
    location.reload();
  }
}
