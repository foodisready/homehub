import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MODE_NAME, ThermostatService, shown, step, toC, type ThermostatMode, type ThermostatView } from './thermostat.service';

/**
 * A thermostat: the room's temperature, what it's doing, its mode, and its target
 * (two in auto) with − and +. Taps on − and + are sent together once they stop, so
 * three quick taps are one change.
 */
@Component({
  selector: 'app-thermostat-control',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  styles: [`
    .t { display: flex; flex-direction: column; gap: 0.7rem; }
    .now { display: flex; align-items: baseline; gap: 0.6rem; }
    .temp { font-size: 2.2rem; font-weight: 600; line-height: 1; }
    .state { font-size: 0.85rem; color: var(--text-muted); }
    .state.heating { color: #fb923c; }
    .state.cooling { color: #60a5fa; }
    .modes { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; align-self: flex-start; }
    .modes button { background: var(--bg); color: var(--text); border: none; border-radius: 0; padding: 0.45rem 0.85rem; font-size: 0.85rem; }
    .modes button + button { border-left: 1px solid var(--border); }
    .modes button[aria-checked="true"] { background: var(--accent, #2563eb); color: #fff; font-weight: 600; }
    .target { display: flex; align-items: center; gap: 0.6rem; }
    .target .what { width: 4.2rem; font-size: 0.85rem; color: var(--text-muted); }
    .target .value { min-width: 3rem; text-align: center; font-size: 1.4rem; font-weight: 600; }
    .step { width: 2.6rem; height: 2.6rem; padding: 0; font-size: 1.3rem; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 50%; }
    .note { font-size: 0.78rem; color: var(--text-muted); margin: 0; }
    .note.warn { color: #fbbf24; }
    .note.err { color: var(--red); }
  `],
  template: `
    @if (view(); as t) {
      <div class="t" [attr.aria-label]="t.alias">
        <div class="now">
          <span class="temp">{{ t.temperature === null ? '–' : deg(t.temperature) }}</span>
          <span class="state" [class.heating]="t.running === 'heating'" [class.cooling]="t.running === 'cooling'">{{ stateText() }}</span>
        </div>
        @if (!t.online) {
          <p class="note">Not connected. These are the last values it reported.</p>
        } @else {
          <div class="modes" role="radiogroup" [attr.aria-label]="'Mode of ' + t.alias">
            @for (m of t.modes; track m) {
              <button type="button" role="radio" [attr.aria-checked]="t.mode === m" (click)="setMode(m)">{{ modeName(m) }}</button>
            }
          </div>
          @for (key of targets(); track key) {
            <div class="target">
              <span class="what">{{ key === 'heat' ? 'Heat to' : 'Cool to' }}</span>
              <button class="step" type="button" (click)="nudge(key, -1)" [attr.aria-label]="'Lower ' + (key === 'heat' ? 'heating' : 'cooling') + ' target'">−</button>
              <span class="value" aria-live="polite">{{ deg(target(key)) }}</span>
              <button class="step" type="button" (click)="nudge(key, 1)" [attr.aria-label]="'Raise ' + (key === 'heat' ? 'heating' : 'cooling') + ' target'">+</button>
            </div>
          }
          @if (t.mode === 'off') { <p class="note">Off: it won't heat or cool. Choose a mode to start it.</p> }
          @if (t.mode === 'other') { <p class="note">It's in a mode set on the thermostat that HomeHub doesn't change, such as emergency heat. Choose a mode to take over.</p> }
          @if (outsideComfort()) {
            <p class="note warn">Outside your comfortable {{ deg(t.comfort.low) }}–{{ deg(t.comfort.high) }}, which is fine for nights and time away.</p>
          }
        }
        @if (error()) { <p class="note err" role="alert">{{ error() }}</p> }
        <a class="note" [routerLink]="['/energy']" [queryParams]="{ thermostat: t.id }">History and running hours</a>
      </div>
    } @else {
      <p class="note">Loading…</p>
    }
  `,
})
export class ThermostatControlComponent implements OnInit, OnDestroy {
  readonly deviceId = input.required<number>();
  private readonly svc = inject(ThermostatService);

  readonly view = computed<ThermostatView | undefined>(() => this.svc.views().get(this.deviceId()));
  /** Targets tapped but not sent yet, in °C. */
  readonly pending = signal<{ heat?: number; cool?: number }>({});
  readonly error = signal('');
  private timer?: ReturnType<typeof setTimeout>;

  ngOnInit(): void { this.svc.watch(this.deviceId()); }
  ngOnDestroy(): void { if (this.timer) { clearTimeout(this.timer); this.send(); } }

  readonly targets = computed<Array<'heat' | 'cool'>>(() => {
    const t = this.view();
    if (!t) return [];
    if (t.mode === 'heat' && t.heat !== null) return ['heat'];
    if (t.mode === 'cool' && t.cool !== null) return ['cool'];
    if (t.mode === 'auto') return (['heat', 'cool'] as const).filter((k) => t[k] !== null);
    return [];
  });

  readonly stateText = computed(() => {
    const t = this.view();
    if (!t) return '';
    const doing = { heating: 'Heating', cooling: 'Cooling', fan: 'Fan only', idle: 'Idle' } as const;
    return `Inside${t.running ? ' · ' + doing[t.running] : ''}`;
  });

  readonly outsideComfort = computed(() => {
    const t = this.view();
    if (!t) return false;
    return this.targets().some((k) => { const v = this.target(k); return v < t.comfort.low - 0.01 || v > t.comfort.high + 0.01; });
  });

  target(key: 'heat' | 'cool'): number {
    return this.pending()[key] ?? this.view()?.[key] ?? 0;
  }

  deg(c: number): string {
    const t = this.view();
    return t ? `${shown(c, t.unit)}°` : '';
  }

  modeName(m: ThermostatMode): string { return MODE_NAME[m]; }

  setMode(mode: ThermostatMode): void {
    const t = this.view();
    if (!t || t.mode === mode) return;
    this.error.set('');
    this.svc.change(t.id, { mode }).subscribe({ error: (e) => this.error.set(e?.error?.error ?? 'The mode couldn’t be changed.') });
  }

  /** One step down or up, in the home's unit, within the thermostat's limits. In auto, the other target makes room. */
  nudge(key: 'heat' | 'cool', dir: -1 | 1): void {
    const t = this.view();
    if (!t) return;
    const limits = key === 'heat' ? t.heatLimits : t.coolLimits;
    const next = toC(shown(this.target(key), t.unit) + dir * step(t.unit), t.unit);
    if (limits && (next < limits[0] - 0.01 || next > limits[1] + 0.01)) {
      this.error.set(`${t.alias} goes from ${this.deg(limits[0])} to ${this.deg(limits[1])}.`);
      return;
    }
    this.error.set('');
    const p = { ...this.pending(), [key]: next };
    if (t.mode === 'auto') {
      const heat = p.heat ?? t.heat, cool = p.cool ?? t.cool;
      if (heat !== null && cool !== null && cool - heat < t.deadband) {
        if (key === 'heat') p.cool = heat + t.deadband; else p.heat = cool - t.deadband;
      }
    }
    this.pending.set(p);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.send(), 800);
  }

  private send(): void {
    this.timer = undefined;
    const t = this.view();
    const p = this.pending();
    if (!t || (p.heat === undefined && p.cool === undefined)) return;
    this.svc.change(t.id, p).subscribe({
      next: () => this.pending.set({}),
      error: (e) => { this.pending.set({}); this.error.set(e?.error?.error ?? 'The temperature couldn’t be changed.'); },
    });
  }
}
