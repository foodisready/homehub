import { Component, DestroyRef, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { HealthItem, HealthReport, SystemService, SystemVersion } from '../../core/services/system.service';
import { SettingsTilesComponent, type SettingsTile } from '../settings/settings-tiles.component';

const REFRESH_MS = 30_000;
const SWITCH_POLL_MS = 3_000;
const SWITCH_DEADLINE_MS = 6 * 60_000;

const GROUPS: HealthItem['group'][] = ['HomeHub', 'Devices', 'Voice', 'Data', 'Computer', 'Settings'];

/** Each area as a tile: its icon and colour. */
const AREA: Record<HealthItem['group'], Pick<SettingsTile, 'icon' | 'hue'>> = {
  HomeHub:  { icon: 'hub', hue: '#4f8cff' },
  Devices:  { icon: 'devices', hue: '#3ddc97' },
  Voice:    { icon: 'mic', hue: '#ff8a3d' },
  Data:     { icon: 'backup', hue: '#5ad1e6' },
  Computer: { icon: 'chip', hue: '#9b8cff' },
  Settings: { icon: 'sliders', hue: '#8e9ab4' },
};
const RANK: Record<HealthItem['level'], number> = { error: 0, warn: 1, info: 2, ok: 3 };
const RING = 2 * Math.PI * 40;

/**
 * Health: whether HomeHub is working, in words anyone can act on. A ring sums it up, a tile for each
 * area says how it's doing, and opening one lists its checks, problems first, each with what to do.
 * The open area is in the address (?area=), so the phone's Back button goes back to the tiles.
 */
@Component({
  selector: 'app-health',
  standalone: true,
  imports: [RouterLink, NgTemplateOutlet, SettingsTilesComponent],
  styles: [`
    h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 1rem; }
    .summary { display: flex; align-items: center; gap: 1rem; padding: 1rem 1.1rem; margin-bottom: 1.25rem; border-radius: 20px; }
    .ring { width: 5.6rem; height: 5.6rem; flex-shrink: 0; position: relative; }
    .ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
    .ring circle { fill: none; stroke-width: 10; }
    .ring .track { stroke: var(--border); }
    .ring .arc { stroke: var(--green); stroke-linecap: round; transition: stroke-dasharray .5s ease; }
    .attention .ring .arc { stroke: #f5b83d; }
    .problem .ring .arc { stroke: var(--red); }
    .ring .num { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; line-height: 1.05; }
    .ring b { font-size: 1.5rem; font-variant-numeric: tabular-nums; }
    .ring small { font-size: 0.6rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
    .sum-text { min-width: 0; }
    .summary h2 { font-size: 1.05rem; margin: 0; }
    .summary p { margin: 0.2rem 0 0.6rem; font-size: 0.8rem; color: var(--text-muted); line-height: 1.35; }
    .area { animation: hh-slide .28s cubic-bezier(.2, .8, .2, 1); }
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
    .detail { font-size: 0.84rem; color: var(--text-muted); margin-top: 0.15rem; line-height: 1.45; overflow-wrap: anywhere; }
    .detail a { margin-left: 0.25rem; }
    .muted { color: var(--text-muted); font-size: 0.88rem; }
    .err { color: var(--red); font-size: 0.88rem; }
    .btn-sm { padding: 0.35rem 0.8rem; font-size: 0.8rem; }
    .ghost { background: transparent; border: 1px solid var(--border); color: var(--text-muted); }
    a.btn-sm { text-decoration: none; border-radius: 6px; display: inline-block; }
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
      @if (area(); as a) {
        <div class="hh-pagebar">
          <button type="button" class="hh-back" (click)="closeArea()" aria-label="Back to Health">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <h2>{{ a }}</h2>
        </div>
        @if (report()) {
          <div class="card list area">
            @for (i of areaItems(); track i.id) {
              <div class="item">
                <span class="dot" [class]="'dot ' + i.level" [attr.aria-label]="levelText[i.level]"></span>
                <div class="body">
                  <div class="label">{{ i.label }}</div>
                  <div class="detail">{{ i.detail }}@if (i.link && i.level !== 'ok') {<a [routerLink]="i.link">Open</a>}</div>
                  <ng-container *ngTemplateOutlet="itemAction; context: { $implicit: i }" />
                </div>
              </div>
            } @empty {
              <p class="muted" style="padding:0.8rem 0">Nothing to check here right now.</p>
            }
          </div>
          @if (a === 'HomeHub' && version(); as v) {
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
        } @else {
          <p class="muted">Checking…</p>
        }
      } @else {
      <h1>Health</h1>

      @if (report(); as r) {
        <div class="card summary" [class]="'card summary ' + r.status" role="status">
          <div class="ring" role="img" [attr.aria-label]="fine() + ' of ' + r.items.length + ' checks fine'">
            <svg viewBox="0 0 100 100" aria-hidden="true">
              <circle cx="50" cy="50" r="40" class="track" />
              <circle cx="50" cy="50" r="40" class="arc" [attr.stroke-dasharray]="arc()" />
            </svg>
            <div class="num"><b>{{ needs() || fine() }}</b><small>{{ needs() ? (needs() === 1 ? 'needs a look' : 'need a look') : 'all fine' }}</small></div>
          </div>
          <div class="sum-text">
            <h2>{{ headline() }}</h2>
            <p>{{ fine() }} of {{ r.items.length }} checks fine · HomeHub {{ r.version }} · checked {{ checkedText() }}</p>
            <button class="btn-sm ghost" type="button" (click)="load()" [disabled]="loading()">
              {{ loading() ? 'Checking…' : 'Check again' }}
            </button>
          </div>
        </div>
        <app-settings-tiles [tiles]="tiles()" [searchable]="false" (open)="openArea($event)" />
      } @else if (error()) {
        <p class="err">{{ error() }}</p>
        <button class="btn-sm ghost" type="button" (click)="load()">Try again</button>
      } @else {
        <p class="muted">Checking…</p>
      }
      }
    </div>

    <ng-template #itemAction let-i>
      @if (isAdmin() && i.id === 'watchdog' && (i.level === 'ok' || i.level === 'info')) {
        <div class="actions"><a class="btn-sm ghost" routerLink="/health/watchdog">{{ i.level === 'info' ? 'Set up' : 'Change' }}</a></div>
      }
      @if (isAdmin() && i.action === 'restart-voice-bridge') {
        <div class="actions">
          <button class="btn-sm ghost" type="button" (click)="restartBridge()" [disabled]="restartingBridge()">
            {{ restartingBridge() ? 'Asking…' : 'Restart voice bridge' }}
          </button>
          <span class="detail">If speakers stop answering. It also picks up new nicknames by itself within a minute.</span>
        </div>
      }
      @if (i.id === 'voice-bridge' && bridgeError()) { <div class="err" style="margin-top:0.5rem">{{ bridgeError() }}</div> }
    </ng-template>

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
  readonly restartingBridge = signal(false);
  readonly bridgeError = signal('');
  private switchTimer?: ReturnType<typeof setInterval>;

  readonly levelText: Record<HealthItem['level'], string> = { ok: 'Working', warn: 'Needs a look', error: 'Problem', info: 'Note' };

  private readonly items = computed(() => this.report()?.items ?? []);
  /** Checks that are fine (or just a note), and those that need a look. */
  readonly fine = computed(() => this.items().filter((i) => i.level === 'ok' || i.level === 'info').length);
  readonly needs = computed(() => this.items().length - this.fine());
  readonly arc = computed(() => {
    const n = this.items().length;
    return `${n ? (RING * this.fine()) / n : 0} ${RING}`;
  });
  readonly headline = computed(() => {
    const bad = this.items().filter((i) => i.level === 'error').length;
    const n = this.needs();
    if (bad) return bad === 1 ? 'Something is wrong' : `${bad} things are wrong`;
    return n ? (n === 1 ? '1 thing needs a look' : `${n} things need a look`) : 'Everything is working';
  });

  /** A tile for each area that has checks, with how it's doing. */
  readonly tiles = computed<SettingsTile[]>(() => GROUPS.flatMap((g) => {
    const items = this.items().filter((i) => i.group === g);
    if (!items.length) return [];
    const bad = items.filter((i) => i.level === 'error' || i.level === 'warn').sort((a, b) => RANK[a.level] - RANK[b.level]);
    return [{
      key: g, name: g, group: 'By area', ...AREA[g],
      status: bad.length === 1 ? `${bad[0].label}: ${bad[0].level === 'error' ? 'a problem' : 'needs a look'}`
        : bad.length === 2 ? bad.map((i) => i.label).join(' · ') : bad.length ? `${bad.length} things need a look` : this.fineText(g, items),
      look: bad.some((i) => i.level === 'error') ? 'problem' as const : bad.length > 0,
      words: items.map((i) => i.label).join(' '),
    }];
  }));

  /** What an area that's fine says on its tile: its main measure where it has one. */
  private fineText(g: HealthItem['group'], items: HealthItem[]): string {
    const detail = (id: string) => items.find((i) => i.id === id)?.detail;
    const first = (t?: string) => t?.split(/\.(\s|$)/)[0];
    if (g === 'Devices') return first(detail('devices')) ?? `All ${items.length} fine`;
    if (g === 'Data') { const m = detail('backups')?.match(/^Last made ([^.]+)\./); if (m) return `Backup ${m[1]}`; }
    if (g === 'Computer') { const d = first(detail('disk')); if (d) return d; }
    return items.length === 1 ? items[0].label : `All ${items.length} fine`;
  }

  // ── Areas as pages ─────────────────────────────────────────
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  /** The open area, from the address; null shows the tiles. */
  readonly area = signal<HealthItem['group'] | null>(null);
  private openedHere = false;

  /** The open area's checks, problems first. */
  readonly areaItems = computed(() => this.items().filter((i) => i.group === this.area())
    .sort((a, b) => RANK[a.level] - RANK[b.level]));

  openArea(key: string): void {
    this.openedHere = true;
    void this.router.navigate([], { relativeTo: this.route, queryParams: { area: key } });
  }

  closeArea(): void {
    if (this.openedHere) { this.openedHere = false; history.back(); return; }
    void this.router.navigate([], { relativeTo: this.route, queryParams: { area: null }, replaceUrl: true });
  }

  readonly checkedText = computed(() => {
    const at = this.report() ? Date.parse(this.report()!.checkedAt) : 0;
    const s = Math.max(0, Math.round((this.now() - at) / 1000));
    return s < 10 ? 'just now' : s < 60 ? `${s} seconds ago` : `${Math.round(s / 60)} min ago`;
  });

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      const a = q.get('area') as HealthItem['group'] | null;
      const next = a && GROUPS.includes(a) ? a : null;
      if (!next) this.openedHere = false;
      if (next !== this.area()) window.scrollTo({ top: 0 });
      this.area.set(next);
    });
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

  /** Asks the voice bridge to restart at its next check-in; the list then shows it happening. */
  restartBridge(): void {
    this.restartingBridge.set(true);
    this.bridgeError.set('');
    this.svc.restartVoiceBridge().subscribe({
      next: () => { this.restartingBridge.set(false); this.load(); },
      error: (err) => {
        this.restartingBridge.set(false);
        this.bridgeError.set(err?.error?.error ?? "Couldn't ask the voice bridge to restart. Try again.");
      },
    });
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
