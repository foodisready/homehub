import { Component, OnInit, OnDestroy, signal, computed, inject } from '@angular/core';
import { AuthService } from '../../core/auth/auth.service';
import { SystemService, SystemVersion } from '../../core/services/system.service';

const POLL_IDLE_MS    = 60_000;
const POLL_UPDATE_MS  = 5_000;
const UPDATE_DEADLINE = 5 * 60_000;

@Component({
  selector: 'app-system-status',
  standalone: true,
  styles: [`
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.85rem 1rem;
      margin-bottom: 1.25rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
    }
    .card.update { border-color: #1e40af; background: rgba(30,64,175,0.08); }
    .card.error  { border-color: #6b1d1d; background: rgba(107,29,29,0.08); }

    .info { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
    .label { font-size: 0.85rem; color: var(--text-muted); }
    .label strong { color: var(--text); }
    .badge {
      font-size: 0.7rem; padding: 0.2rem 0.55rem; border-radius: 999px;
      background: #1e40af; color: #fff;
    }

    .right { display: flex; align-items: center; gap: 0.6rem; }
    .btn {
      font-size: 0.85rem; padding: 0.4rem 0.85rem; border-radius: 6px;
      border: 1px solid var(--border); background: var(--surface);
      color: var(--text); cursor: pointer;
    }
    .btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .msg { font-size: 0.8rem; }
    .msg.ok { color: #4ade80; }
    .msg.err { color: #f87171; }
    .msg.muted { color: var(--text-muted); }
  `],
  template: `
    @if (version(); as v) {
      <div class="card" [class.update]="v.updateAvailable && !done()" [class.error]="errored()">
        <div class="info">
          <span class="label">HomeHub <strong>{{ v.running }}</strong></span>
          @if (v.latest && v.latest !== v.running) {
            <span class="label">latest <strong>{{ v.latest }}</strong></span>
          }
          @if (v.updateAvailable && !done() && !updating()) {
            <span class="badge">Update available</span>
          }
        </div>
        <div class="right">
          @if (msg()) {
            <span class="msg" [class.ok]="done()" [class.err]="errored()" [class.muted]="!done() && !errored()">
              {{ msg() }}
            </span>
          }
          @if (isAdmin() && v.updateAvailable && !done()) {
            <button class="btn primary"
                    (click)="onUpdate()"
                    [disabled]="updating() || !v.updaterAvailable"
                    [title]="!v.updaterAvailable ? 'Updater service is not configured' : ''">
              {{ updating() ? 'Updating…' : 'Update HomeHub' }}
            </button>
          }
        </div>
      </div>
    }
  `,
})
export class SystemStatusComponent implements OnInit, OnDestroy {
  private svc  = inject(SystemService);
  private auth = inject(AuthService);

  version  = signal<SystemVersion | null>(null);
  updating = signal(false);
  msg      = signal('');
  errored  = signal(false);
  done     = signal(false);

  isAdmin = computed(() => this.auth.user()?.role === 'admin');

  private idleTimer?:   ReturnType<typeof setInterval>;
  private updateTimer?: ReturnType<typeof setInterval>;
  private updateDeadline = 0;

  ngOnInit(): void {
    this.refresh();
    this.idleTimer = setInterval(() => this.refresh(), POLL_IDLE_MS);
  }

  ngOnDestroy(): void {
    if (this.idleTimer)   clearInterval(this.idleTimer);
    if (this.updateTimer) clearInterval(this.updateTimer);
  }

  private refresh(): void {
    this.svc.version().subscribe({
      next:  (v) => this.version.set(v),
      error: () => { /* server unreachable — leave the card hidden */ },
    });
  }

  onUpdate(): void {
    const v = this.version();
    if (!v || !v.updateAvailable) return;
    if (!confirm(
      `Update HomeHub from ${v.running} to ${v.latest}?\n\n` +
      `The dashboard will be unavailable for ~30–60 seconds while ` +
      `the new images come up.`
    )) return;

    this.updating.set(true);
    this.msg.set('Update started — waiting for new version to come online…');
    this.errored.set(false);
    this.done.set(false);

    const targetVersion = v.latest ?? '';
    this.svc.update().subscribe({
      next: () => this.startUpdatePolling(targetVersion),
      error: (err) => {
        this.updating.set(false);
        this.errored.set(true);
        const code = err?.error?.code;
        this.msg.set(
          code === 'UPDATER_OFFLINE' ? 'Updater service is offline — cannot push update.'
          : code === 'UPDATER_DISABLED' ? 'Updater service not configured. See ota-strategy.md.'
          : code === 'UPDATER_FAILED'   ? 'Updater rejected the request — check Watchtower logs.'
          : err?.error?.error           ?? 'Update dispatch failed.'
        );
      },
    });
  }

  /* After dispatch the backend container will be recreated — our poll
   * will bounce through "fetch failed" responses for ~30s while it
   * comes back up, then return the new running version. We just wait
   * up to 5 minutes total before giving up. */
  private startUpdatePolling(targetVersion: string): void {
    this.updateDeadline = Date.now() + UPDATE_DEADLINE;
    this.updateTimer = setInterval(() => {
      this.svc.version().subscribe({
        next: (v) => {
          this.version.set(v);
          if (v.running === targetVersion || (!v.updateAvailable && targetVersion !== '')) {
            this.stopUpdatePolling();
            this.updating.set(false);
            this.done.set(true);
            this.msg.set(`✓ Update complete — running ${v.running}.`);
          } else if (Date.now() > this.updateDeadline) {
            this.stopUpdatePolling();
            this.updating.set(false);
            this.errored.set(true);
            this.msg.set(
              `Backend hasn't reported ${targetVersion} after 5 minutes. ` +
              `Check container logs.`
            );
          }
        },
        error: () => { /* expected during the restart window */ },
      });
    }, POLL_UPDATE_MS);
  }

  private stopUpdatePolling(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = undefined;
    }
  }
}
