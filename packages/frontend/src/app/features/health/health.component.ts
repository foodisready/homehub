import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { HealthItem, HealthReport, SystemService, SystemVersion } from '../../core/services/system.service';

const REFRESH_MS = 30_000;
const SWITCH_POLL_MS = 3_000;
const SWITCH_DEADLINE_MS = 6 * 60_000;

const GROUPS: HealthItem['group'][] = ['HomeHub', 'Devices', 'Voice', 'Data', 'Computer', 'Settings'];

const SUMMARY: Record<HealthReport['status'], string> = {
  ok: 'Everything is working',
  attention: 'Something needs a look',
  problem: 'Something is wrong',
};

/**
 * Health: whether HomeHub is working, in words anyone can act on. Problems
 * come first; everything that's fine is listed below them.
 */
@Component({
  selector: 'app-health',
  standalone: true,
  imports: [RouterLink],
  styles: [`
    h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 1rem; }
    .summary { display: flex; align-items: center; gap: 0.85rem; padding: 1rem 1.1rem; margin-bottom: 1.25rem; }
    .summary .badge { width: 2.4rem; height: 2.4rem; border-radius: 50%; display: grid; place-items: center; font-weight: 800; font-size: 1.15rem; flex-shrink: 0; }
    .summary.ok .badge { background: rgba(74,222,128,0.15); color: var(--green); }
    .summary.attention .badge { background: rgba(245,158,11,0.15); color: #f59e0b; }
    .summary.problem .badge { background: rgba(248,113,113,0.15); color: var(--red); }
    .summary h2 { font-size: 1.05rem; margin: 0; }
    .summary p { margin: 0.15rem 0 0; font-size: 0.8rem; color: var(--text-muted); }
    .summary .refresh { margin-left: auto; }
    .section { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); margin: 1.25rem 0 0.4rem; }
    .list { padding: 0.15rem 1rem; }
    .item { display: flex; gap: 0.75rem; padding: 0.7rem 0; border-top: 1px solid var(--border); align-items: flex-start; }
    .item:first-child { border-top: none; }
    .dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 0.4rem; flex-shrink: 0; }
    .dot.ok { background: var(--green); }
    .dot.warn { background: #f59e0b; }
    .dot.error { background: var(--red); }
    .dot.info { background: var(--text-muted); }
    .body { flex: 1; min-width: 0; }
    .label { font-size: 0.92rem; font-weight: 600; }
    .group { font-weight: 400; color: var(--text-muted); font-size: 0.78rem; margin-left: 0.35rem; }
    .detail { font-size: 0.84rem; color: var(--text-muted); margin-top: 0.15rem; line-height: 1.45; overflow-wrap: anywhere; }
    .detail a { margin-left: 0.25rem; }
    .muted { color: var(--text-muted); font-size: 0.88rem; }
    .err { color: var(--red); font-size: 0.88rem; }
    .btn-sm { padding: 0.35rem 0.8rem; font-size: 0.8rem; }
    .ghost { background: transparent; border: 1px solid var(--border); color: var(--text-muted); }
    .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.6rem; align-items: center; }
    .confirm { font-size: 0.84rem; line-height: 1.45; margin-top: 0.6rem; }
    .overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(2,6,23,0.82); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; padding: 1rem; }
    .panel { width: 100%; max-width: 24rem; text-align: center; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1.75rem 1.25rem; }
    .panel h2 { font-size: 1.15rem; margin: 0.9rem 0 0.4rem; }
    .panel p { font-size: 0.88rem; color: var(--text-muted); line-height: 1.5; margin: 0; }
    .panel .btn-sm { margin-top: 1rem; }
    .spinner { width: 2.6rem; height: 2.6rem; margin: 0 auto; border-radius: 50%; border: 3px solid rgba(148,163,184,0.25); border-top-color: var(--accent); animation: spin 0.9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.5s; } }
  `],
  template: `
    <div class="page">
      <h1>Health</h1>

      @if (report(); as r) {
        <div class="card summary" [class]="'card summary ' + r.status" role="status">
          <div class="badge" aria-hidden="true">{{ r.status === 'ok' ? '✓' : '!' }}</div>
          <div>
            <h2>{{ summary() }}</h2>
            <p>HomeHub {{ r.version }} · checked {{ checkedText() }}</p>
          </div>
          <button class="btn-sm ghost refresh" type="button" (click)="load()" [disabled]="loading()">
            {{ loading() ? 'Checking…' : 'Check again' }}
          </button>
        </div>

        @if (problems().length) {
          <div class="section">Needs a look</div>
          <div class="card list">
            @for (i of problems(); track i.id) {
              <div class="item">
                <span class="dot" [class]="'dot ' + i.level" [attr.aria-label]="levelText[i.level]"></span>
                <div class="body">
                  <div class="label">{{ i.label }}@if (i.group !== i.label) {<span class="group">{{ i.group }}</span>}</div>
                  <div class="detail">{{ i.detail }}@if (i.link) {<a [routerLink]="i.link">Open</a>}</div>
                </div>
              </div>
            }
          </div>
        }

        @for (g of okGroups(); track g.name) {
          <div class="section">{{ g.name }}</div>
          <div class="card list">
            @for (i of g.items; track i.id) {
              <div class="item">
                <span class="dot" [class]="'dot ' + i.level" [attr.aria-label]="levelText[i.level]"></span>
                <div class="body">
                  <div class="label">{{ i.label }}</div>
                  <div class="detail">{{ i.detail }}</div>
                </div>
              </div>
            }
          </div>
        }

        @if (version(); as v) {
          <div class="section">Version</div>
          <div class="card list">
            <div class="item">
              <span class="dot" [class]="'dot ' + (v.updateAvailable || v.running === 'dev' ? 'info' : 'ok')"></span>
              <div class="body">
                <div class="label">HomeHub {{ v.running }}</div>
                <div class="detail">
                  @if (v.running === 'dev') { A development build, which doesn't update itself. }
                  @else if (v.updateAvailable) { {{ v.latest }} is available. Update from the card on the Home page. }
                  @else if (v.latest) { Up to date. }
                  @else { Couldn't check for updates. }
                </div>
                @if (isAdmin() && v.previous && v.running !== 'dev') {
                  @if (v.canSwitch) {
                    @if (confirming()) {
                      <div class="confirm">
                        HomeHub goes back to <strong>{{ v.previous }}</strong>, the version it ran before this one, and is
                        unavailable for a minute or two. Your devices, schedules and settings stay. A copy of the database is
                        saved first.
                      </div>
                      <div class="actions">
                        <button class="btn-sm btn-primary" type="button" (click)="goBack(v.previous)">Go back to {{ v.previous }}</button>
                        <button class="btn-sm ghost" type="button" (click)="confirming.set(false)">Cancel</button>
                      </div>
                    } @else {
                      <div class="actions">
                        <button class="btn-sm ghost" type="button" (click)="confirming.set(true)">Go back to {{ v.previous }}…</button>
                        <span class="detail">If something stopped working after the last update.</span>
                      </div>
                    }
                  } @else {
                    <div class="detail">To be able to go back to {{ v.previous }}, run the installer on the HomeHub computer once more.</div>
                  }
                }
                @if (switchError()) { <div class="err" style="margin-top:0.5rem">{{ switchError() }}</div> }
              </div>
            </div>
          </div>
        }
      } @else if (error()) {
        <p class="err">{{ error() }}</p>
        <button class="btn-sm ghost" type="button" (click)="load()">Try again</button>
      } @else {
        <p class="muted">Checking…</p>
      }
    </div>

    @if (switching(); as target) {
      <div class="overlay" role="alertdialog" aria-modal="true" aria-live="polite" aria-labelledby="switch-title">
        <div class="panel">
          <div class="spinner" aria-hidden="true"></div>
          <h2 id="switch-title">Switching HomeHub to {{ target }}</h2>
          <p>{{ restarted() ? 'Restarting…' : 'Downloading it. Please keep this page open.' }}</p>
        </div>
      </div>
    }
  `,
})
export class HealthComponent implements OnInit, OnDestroy {
  private readonly svc = inject(SystemService);
  private readonly auth = inject(AuthService);

  readonly report = signal<HealthReport | null>(null);
  readonly version = signal<SystemVersion | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  private readonly now = signal(Date.now());
  private timer?: ReturnType<typeof setInterval>;

  readonly isAdmin = computed(() => this.auth.user()?.role === 'admin');
  readonly confirming = signal(false);
  readonly switching = signal<string | null>(null);
  readonly restarted = signal(false);
  readonly switchError = signal('');
  private switchTimer?: ReturnType<typeof setInterval>;

  readonly levelText: Record<HealthItem['level'], string> = { ok: 'Working', warn: 'Needs a look', error: 'Problem', info: 'Note' };

  readonly summary = computed(() => (this.report() ? SUMMARY[this.report()!.status] : ''));

  readonly problems = computed(() => {
    const rank = { error: 0, warn: 1, info: 2, ok: 3 };
    return (this.report()?.items ?? []).filter((i) => i.level === 'error' || i.level === 'warn')
      .sort((a, b) => rank[a.level] - rank[b.level]);
  });

  readonly okGroups = computed(() => {
    const items = (this.report()?.items ?? []).filter((i) => i.level === 'ok' || i.level === 'info');
    return GROUPS.map((name) => ({ name, items: items.filter((i) => i.group === name) })).filter((g) => g.items.length);
  });

  readonly checkedText = computed(() => {
    const at = this.report() ? Date.parse(this.report()!.checkedAt) : 0;
    const s = Math.max(0, Math.round((this.now() - at) / 1000));
    return s < 10 ? 'just now' : s < 60 ? `${s} seconds ago` : `${Math.round(s / 60)} min ago`;
  });

  ngOnInit(): void {
    this.load();
    this.svc.version().subscribe({ next: (v) => this.version.set(v), error: () => undefined });
    this.timer = setInterval(() => {
      this.now.set(Date.now());
      if (Date.now() - Date.parse(this.report()?.checkedAt ?? '0') >= REFRESH_MS) this.load();
    }, 5_000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.switchTimer) clearInterval(this.switchTimer);
  }

  /** Goes back a version, then waits for HomeHub to come back on it and reloads. */
  goBack(version: string): void {
    this.confirming.set(false);
    this.switchError.set('');
    this.restarted.set(false);
    this.switching.set(version);
    this.svc.switchTo(version).subscribe({
      next: () => this.waitFor(version),
      error: (err) => {
        this.switching.set(null);
        this.switchError.set(err?.error?.error ?? "HomeHub couldn't start going back.");
      },
    });
  }

  private waitFor(version: string): void {
    const deadline = Date.now() + SWITCH_DEADLINE_MS;
    this.switchTimer = setInterval(() => {
      this.svc.version().subscribe({
        next: (v) => {
          if (v.running === version) { this.stopSwitch(); location.reload(); return; }
          // Still the old version: the download may have failed.
          this.svc.switchStatus().subscribe({
            next: (s) => {
              if (s && !s.busy && s.last?.version === version && !s.last.ok) {
                this.stopSwitch();
                this.switchError.set(s.last.step === 'download'
                  ? `${version} couldn't be downloaded, so nothing changed. Check the internet connection and try again.`
                  : `Going back to ${version} didn't finish. Run the installer on the HomeHub computer.`);
              }
            },
            error: () => undefined,
          });
          if (Date.now() > deadline) { this.stopSwitch(); this.switchError.set(`HomeHub is still on ${v.running}. Try again, or run the installer on the HomeHub computer.`); }
        },
        error: () => {
          this.restarted.set(true);
          if (Date.now() > deadline) { this.stopSwitch(); this.switchError.set("HomeHub hasn't come back. Check that its computer is on, then reload this page."); }
        },
      });
    }, SWITCH_POLL_MS);
  }

  private stopSwitch(): void {
    if (this.switchTimer) { clearInterval(this.switchTimer); this.switchTimer = undefined; }
    this.switching.set(null);
  }

  load(): void {
    if (this.loading()) return;
    this.loading.set(true);
    this.svc.health().subscribe({
      next: (r) => { this.report.set(r); this.error.set(''); this.loading.set(false); this.now.set(Date.now()); },
      error: () => {
        this.loading.set(false);
        if (!this.report()) this.error.set("HomeHub didn't answer. Check that its computer is on.");
      },
    });
  }
}
