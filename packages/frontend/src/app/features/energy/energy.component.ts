import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { EnergyLiveComponent } from './energy-live.component';
import { EnergyMonthsComponent } from './energy-months.component';
import { EnergyOverviewComponent } from './energy-overview.component';
import { EnergyWhereComponent } from './energy-where.component';
import { ThermostatHistoryComponent } from './thermostat-history.component';
import { monthName, type Usage } from './energy.types';

/**
 * Energy: where the electricity goes, for a month. An estimate for each device HomeHub
 * switches, measured where a plug measures, heating and cooling from the thermostat, the
 * last 12 months, and live power for plugs that measure. The month chosen at the top
 * applies to all of it.
 */
@Component({
  selector: 'app-energy',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EnergyOverviewComponent, EnergyWhereComponent, EnergyMonthsComponent, ThermostatHistoryComponent, EnergyLiveComponent],
  styles: [`
    .top { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1.1rem; }
    h1 { font-size: 1.4rem; font-weight: 700; margin: 0; }
    h2 { font-size: 0.8rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-muted); margin: 1.8rem 0 0.7rem; }
    .nav { display: inline-flex; align-items: center; gap: 0.35rem; }
    .nav button { background: var(--surface); border: 1px solid var(--border); color: var(--text); width: 2.2rem; height: 2.2rem; padding: 0; border-radius: 50%; font-size: 1rem; }
    .nav button:disabled { opacity: 0.35; }
    .nav span { min-width: 9.5rem; text-align: center; font-weight: 600; }
    .stack { display: flex; flex-direction: column; gap: 1.1rem; }
    .muted { color: var(--text-muted); font-size: 0.85rem; }
    .refetch { opacity: 0.6; transition: opacity 0.15s; }
  `],
  template: `
    <div class="page">
      <div class="top">
        <h1>Energy</h1>
        <div class="nav" role="group" aria-label="Month">
          <button type="button" (click)="move(-1)" aria-label="Month before">‹</button>
          <span aria-live="polite">{{ monthLabel() }}</span>
          <button type="button" (click)="move(1)" [disabled]="month() >= (usage()?.thisMonth ?? month())" aria-label="Month after">›</button>
        </div>
      </div>

      @if (usage(); as u) {
        <div [class.refetch]="loading()">
          <app-energy-overview [usage]="u" [admin]="admin()" (changed)="load()" />
          <h2>Where it goes</h2>
          <app-energy-where [usage]="u" [admin]="admin()" (changed)="load()" />
          <h2>By month</h2>
          <app-energy-months [usage]="u" (pick)="go($event)" />
        </div>
      } @else if (failed()) {
        <p class="muted">The energy figures couldn’t be loaded. Reload the page to try again.</p>
      } @else {
        <p class="muted">Loading…</p>
      }

      @if (thermostats().length) {
        <h2>Heating and cooling</h2>
        <div class="stack">
          @for (t of thermostats(); track t.id) {
            <div class="card" [id]="'thermostat-' + t.id"><app-thermostat-history [deviceId]="t.id" [alias]="t.alias" /></div>
          }
        </div>
      }

      @if (measuring()) {
        <h2>Measured live</h2>
        <app-energy-live />
      }
    </div>
  `,
})
export class EnergyComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);

  readonly admin = computed(() => this.auth.user()?.role === 'admin');
  readonly month = signal('');
  readonly usage = signal<Usage | null>(null);
  readonly loading = signal(false);
  readonly failed = signal(false);
  readonly thermostats = signal<{ id: number; alias: string }[]>([]);
  readonly measuring = signal(false);

  readonly monthLabel = computed(() => {
    const m = this.month() || this.usage()?.month;
    if (!m) return '';
    const label = monthName(m, 'long', true);
    return this.usage()?.partial && this.usage()?.month === m ? `${label} so far` : label;
  });

  ngOnInit(): void {
    this.load();
    this.http.get<{ thermostats: { id: number; alias: string }[] }>('/api/thermostats').subscribe({
      next: (r) => {
        this.thermostats.set(r.thermostats.map((t) => ({ id: t.id, alias: t.alias })));
        // From a thermostat's History link: bring its card into view.
        const wanted = this.route.snapshot.queryParamMap.get('thermostat');
        if (wanted) setTimeout(() => document.getElementById(`thermostat-${wanted}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 400);
      },
      error: () => undefined,
    });
    this.http.get<{ hasEmeter: boolean }[]>('/api/devices').subscribe({ next: (ds) => this.measuring.set(ds.some((d) => d.hasEmeter)), error: () => undefined });
  }

  load(): void {
    this.loading.set(true);
    const q = this.month() ? `?month=${this.month()}` : '';
    this.http.get<Usage>(`/api/energy/usage${q}`).subscribe({
      next: (u) => { this.usage.set(u); this.month.set(u.month); this.loading.set(false); this.failed.set(false); },
      error: () => { this.loading.set(false); this.failed.set(true); },
    });
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
