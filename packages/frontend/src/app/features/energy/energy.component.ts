import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { SettingsTilesComponent, type SettingsTile } from '../settings/settings-tiles.component';
import { EnergyLiveComponent } from './energy-live.component';
import { EnergyMonthsComponent } from './energy-months.component';
import { EnergyOverviewComponent } from './energy-overview.component';
import { EnergyWhereComponent } from './energy-where.component';
import { EnergyPanelComponent } from './energy-panel.component';
import { ThermostatHistoryComponent } from './thermostat-history.component';
import { kwhText, monthName, type PanelView, type Usage } from './energy.types';

type Area = 'where' | 'heat' | 'whole' | 'months' | 'live';
const AREAS: Area[] = ['where', 'heat', 'whole', 'months', 'live'];
const TITLE: Record<Area, string> = {
  where: 'Where it goes', heat: 'Heating and cooling', whole: 'Whole home', months: 'By month', live: 'Measured live',
};
const hrs = (h: number) => `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;

/**
 * Energy: the month in a few numbers at the top, then a tile for each part (where it goes,
 * heating and cooling, the whole home, by month, measured live), each saying how it's doing
 * and opening as its own page. The open page is in the address (?area=), so the phone's Back
 * button goes back to the tiles. The month chosen applies to all of it.
 */
@Component({
  selector: 'app-energy',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, SettingsTilesComponent, EnergyOverviewComponent, EnergyPanelComponent, EnergyWhereComponent, EnergyMonthsComponent, ThermostatHistoryComponent, EnergyLiveComponent],
  styles: [`
    .top { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1.1rem; }
    h1 { font-size: 1.4rem; font-weight: 700; margin: 0; }
    .hh-pagebar { flex-wrap: wrap; }
    .hh-pagebar h2 { flex: 1; min-width: 8rem; }
    .nav { display: inline-flex; align-items: center; gap: 0.35rem; }
    .nav button { background: var(--surface); border: 1px solid var(--border); color: var(--text); width: 2.2rem; height: 2.2rem; padding: 0; border-radius: 50%; font-size: 1rem; }
    .nav button:disabled { opacity: 0.35; }
    .nav span { min-width: 9.5rem; text-align: center; font-weight: 600; }
    .stack { display: flex; flex-direction: column; gap: 1.1rem; }
    .muted { color: var(--text-muted); font-size: 0.85rem; }
    .refetch { opacity: 0.6; transition: opacity 0.15s; }
    .tiles { margin-top: 1.25rem; }
    .area { animation: hh-slide .28s cubic-bezier(.2, .8, .2, 1); }
    @media (prefers-reduced-motion: reduce) { .area { animation: none; } }
    @media (max-width: 420px) { .nav span { min-width: 7.5rem; font-size: 0.9rem; } }
  `],
  template: `
    <div class="page">
      @if (area(); as a) {
        <div class="hh-pagebar">
          <button type="button" class="hh-back" (click)="closeArea()" aria-label="Back to Energy">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <h2>{{ title[a] }}</h2>
          @if (a !== 'live' && (a !== 'whole' || panel()?.set)) { <ng-container *ngTemplateOutlet="nav" /> }
        </div>
        <div class="area" [class.refetch]="loading()">
          @switch (a) {
            @case ('where') { @if (usage(); as u) { <app-energy-where [usage]="u" [admin]="admin()" (changed)="load()" /> } }
            @case ('whole') { @if (usage(); as u) { <app-energy-panel [u]="u" [admin]="admin()" (changed)="load(); loadPanel()" /> } }
            @case ('months') { @if (usage(); as u) { <app-energy-months [usage]="u" (pick)="go($event)" /> } }
            @case ('heat') {
              <div class="stack">
                @for (t of thermostats(); track t.id) {
                  <div class="card" [id]="'thermostat-' + t.id"><app-thermostat-history [deviceId]="t.id" [alias]="t.alias" /></div>
                } @empty { <p class="muted">No thermostats yet.</p> }
              </div>
            }
            @case ('live') { <app-energy-live /> }
          }
          @if (a !== 'heat' && a !== 'live' && !usage()) { <p class="muted">{{ failed() ? 'The energy figures couldn’t be loaded. Reload the page to try again.' : 'Loading…' }}</p> }
        </div>
      } @else {
        <div class="top">
          <h1>Energy</h1>
          <ng-container *ngTemplateOutlet="nav" />
        </div>

        @if (usage(); as u) {
          <div [class.refetch]="loading()">
            <app-energy-overview [usage]="u" [admin]="admin()" (changed)="load()" />
            <div class="tiles"><app-settings-tiles [tiles]="tiles()" [searchable]="false" (open)="openArea($event)" /></div>
          </div>
        } @else if (failed()) {
          <p class="muted">The energy figures couldn’t be loaded. Reload the page to try again.</p>
        } @else {
          <p class="muted">Loading…</p>
        }
      }
    </div>

    <ng-template #nav>
      <div class="nav" role="group" aria-label="Month">
        <button type="button" (click)="move(-1)" aria-label="Month before">‹</button>
        <span aria-live="polite">{{ monthLabel() }}</span>
        <button type="button" (click)="move(1)" [disabled]="month() >= (usage()?.thisMonth ?? month())" aria-label="Month after">›</button>
      </div>
    </ng-template>
  `,
})
export class EnergyComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly title = TITLE;
  readonly admin = computed(() => this.auth.user()?.role === 'admin');
  readonly month = signal('');
  readonly usage = signal<Usage | null>(null);
  readonly loading = signal(false);
  readonly failed = signal(false);
  readonly thermostats = signal<{ id: number; alias: string }[]>([]);
  /** Plugs that measure their own power. */
  readonly measuring = signal(0);
  readonly panel = signal<PanelView | null>(null);

  /** The open page, from the address; null shows the tiles. */
  readonly area = signal<Area | null>(null);
  private openedHere = false;

  readonly monthLabel = computed(() => {
    const m = this.month() || this.usage()?.month;
    if (!m) return '';
    const label = monthName(m, 'long', true);
    return this.usage()?.partial && this.usage()?.month === m ? `${label} so far` : label;
  });

  /** A tile for each part, with how it's doing this month. */
  readonly tiles = computed<SettingsTile[]>(() => {
    const u = this.usage();
    if (!u) return [];
    const out: SettingsTile[] = [];
    const group = 'This month';

    // Where it goes: the biggest user, and what isn't counted yet.
    const counted = [
      ...u.devices.filter((d) => d.kwh !== null && d.kwh > 0).map((d) => ({ name: d.alias, kwh: d.kwh! })),
      ...u.hvac.filter((h) => h.kwh !== null && h.kwh > 0).map((h) => ({ name: h.kind === 'heating' ? 'Heating' : 'Cooling', kwh: h.kwh! })),
    ].sort((a, b) => b.kwh - a.kwh);
    const total = counted.reduce((s, r) => s + r.kwh, 0);
    const waiting = u.devices.filter((d) => d.kwh === null && d.onHours > 0).length
      + u.hvac.filter((h) => h.kwh === null && h.hours > 0).length;
    const top = counted[0] && total > 0 ? `Most: ${counted[0].name} · ${Math.round((counted[0].kwh / total) * 100)}%` : 'Nothing counted yet';
    out.push({
      key: 'where', name: TITLE.where, group, icon: 'pie', hue: '#4f8cff',
      status: waiting ? `${waiting} not counted · ${top.replace('Most: ', 'most: ')}` : top,
      look: waiting > 0, words: 'devices rooms watts wattage lamps plugs not counted biggest',
    });

    // Heating and cooling: running hours this month, from the thermostats.
    if (this.thermostats().length) {
      const heat = u.hvac.filter((h) => h.kind === 'heating').reduce((s, h) => s + h.hours, 0);
      const cool = u.hvac.filter((h) => h.kind === 'cooling').reduce((s, h) => s + h.hours, 0);
      const n = this.thermostats().length;
      const parts = [heat > 0 ? `Heating ${hrs(heat)}` : '', cool > 0 ? `Cooling ${hrs(cool)}` : ''].filter(Boolean);
      const noSystem = u.hvac.some((h) => h.kwh === null && h.hours > 0);
      out.push({
        key: 'heat', name: TITLE.heat, group, icon: 'flame', hue: '#ff8a3d',
        status: noSystem ? 'Set what it runs on to count it' : parts.length ? parts.join(' · ') : `${n} ${n === 1 ? 'thermostat' : 'thermostats'} · not running`,
        look: noSystem, words: 'thermostat furnace heat pump air conditioning running hours history temperature',
      });
    }

    // The whole home: measured by a panel monitor, or how to add one.
    const p = this.panel();
    const whole = u.panel?.wholeKwh;
    out.push({
      key: 'whole', name: TITLE.whole, group, icon: 'house', hue: '#3ddc97',
      status: !p?.set ? 'Not set up · measure everything' : p.error ? 'The meter isn’t answering' : whole != null ? `${kwhText(whole)} measured` : 'Measuring',
      look: p?.set && (p.error || p.problems?.length) ? 'problem' : false,
      words: 'panel monitor shelly meter mains circuit clamp',
    });

    // By month: how much history there is, and the biggest month.
    const recorded = u.months.filter((m) => m.recorded && m.kwh > 0);
    const most = recorded.reduce<typeof recorded[number] | null>((a, m) => (!a || m.kwh > a.kwh ? m : a), null);
    out.push({
      key: 'months', name: TITLE.months, group, icon: 'chart', hue: '#9b8cff',
      status: recorded.length > 1 && most ? `${recorded.length} months · most in ${monthName(most.month)}` : u.recordedFrom ? `Since ${new Date(u.recordedFrom).toLocaleDateString([], { month: 'long', timeZone: u.timezone })}` : 'The last 12 months',
      words: 'history year chart compare',
    });

    if (this.measuring()) {
      const n = this.measuring();
      out.push({
        key: 'live', name: TITLE.live, group, icon: 'bolt', hue: '#5ad1e6',
        status: n === 1 ? '1 plug measures its power' : `${n} plugs measure their power`,
        words: 'watts power now plug meter',
      });
    }
    return out;
  });

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      const a = q.get('area') as Area | null;
      // From a thermostat's History link: its heating and cooling page.
      const next = a && AREAS.includes(a) ? a : q.get('thermostat') ? 'heat' : null;
      if (!next) this.openedHere = false;
      if (next !== this.area()) window.scrollTo({ top: 0 });
      this.area.set(next);
    });
    this.load();
    this.loadPanel();
    this.http.get<{ thermostats: { id: number; alias: string }[] }>('/api/thermostats').subscribe({
      next: (r) => {
        this.thermostats.set(r.thermostats.map((t) => ({ id: t.id, alias: t.alias })));
        const wanted = this.route.snapshot.queryParamMap.get('thermostat');
        if (wanted && r.thermostats.length > 1) setTimeout(() => document.getElementById(`thermostat-${wanted}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 400);
      },
      error: () => undefined,
    });
    this.http.get<{ hasEmeter: boolean }[]>('/api/devices').subscribe({ next: (ds) => this.measuring.set(ds.filter((d) => d.hasEmeter).length), error: () => undefined });
  }

  load(): void {
    this.loading.set(true);
    const q = this.month() ? `?month=${this.month()}` : '';
    this.http.get<Usage>(`/api/energy/usage${q}`).subscribe({
      next: (u) => { this.usage.set(u); this.month.set(u.month); this.loading.set(false); this.failed.set(false); },
      error: () => { this.loading.set(false); this.failed.set(true); },
    });
  }

  loadPanel(): void {
    this.http.get<PanelView>('/api/energy/panel').subscribe({ next: (v) => this.panel.set(v), error: () => this.panel.set({ set: false }) });
  }

  openArea(key: string): void {
    this.openedHere = true;
    void this.router.navigate([], { relativeTo: this.route, queryParams: { area: key } });
  }

  closeArea(): void {
    if (this.openedHere) { this.openedHere = false; history.back(); return; }
    void this.router.navigate([], { relativeTo: this.route, queryParams: { area: null, thermostat: null }, replaceUrl: true });
  }

  go(month: string): void {
    if (month === this.month()) return;
    this.month.set(month);
    this.load();
  }

  move(by: number): void {
    const [y, m] = this.month().split('-').map(Number);
    const d = new Date(y, m - 1 + by, 15);
    const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (next > (this.usage()?.thisMonth ?? next)) return;
    this.go(next);
  }
}
