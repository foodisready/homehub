import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Observable, of } from 'rxjs';
import { ThermostatService, shown, toC, type Ranges } from './thermostat.service';

/**
 * A thermostat's two ranges, in the device's Edit popup: comfortable (for advice and the card)
 * and never beyond (for Chat, voice, schedules and scenes). Saved with the popup's Save.
 */
@Component({
  selector: 'app-thermostat-ranges',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: 0.6rem 0.75rem; margin: 0.6rem 0 0; }
    legend { font-size: 0.8rem; font-weight: 600; padding: 0 0.3rem; }
    .r { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; font-size: 0.85rem; margin-top: 0.35rem; }
    .r .what { width: 9.5rem; }
    .r input { width: 4.2rem; }
    p { font-size: 0.75rem; color: var(--text-muted); margin: 0.35rem 0 0; }
  `],
  template: `
    <fieldset>
      <legend>Temperatures</legend>
      <div class="r">
        <span class="what">Comfortable</span>
        <input type="number" [(ngModel)]="comfortLow" [step]="stepSize()" aria-label="Lowest comfortable temperature" /> to
        <input type="number" [(ngModel)]="comfortHigh" [step]="stepSize()" aria-label="Highest comfortable temperature" /> °{{ unit() }}
      </div>
      <p>Where you like it when you're home and awake. HomeHub's savings advice keeps to it.</p>
      <div class="r">
        <span class="what">Never beyond</span>
        <input type="number" [(ngModel)]="allowedLow" [step]="stepSize()" aria-label="Lowest allowed temperature" /> to
        <input type="number" [(ngModel)]="allowedHigh" [step]="stepSize()" aria-label="Highest allowed temperature" /> °{{ unit() }}
      </div>
      <p>The furthest Chat, voice, schedules and scenes can set it, at night and while you're out too. You can still go further on the thermostat or its card.</p>
    </fieldset>
  `,
})
export class ThermostatRangesComponent implements OnInit {
  readonly deviceId = input.required<number>();
  private readonly svc = inject(ThermostatService);
  private readonly view = computed(() => this.svc.views().get(this.deviceId()));
  readonly unit = computed(() => this.view()?.unit ?? 'F');
  readonly stepSize = computed(() => (this.unit() === 'F' ? 1 : 0.5));
  private readonly loaded = signal(false);
  private readonly cd = inject(ChangeDetectorRef);
  // The saved ranges arrive a moment after the popup opens: fill the boxes then, once.
  private readonly fillWhenLoaded = effect(() => {
    if (this.view() && !untracked(this.loaded)) untracked(() => this.fill());
  });

  comfortLow = 0; comfortHigh = 0; allowedLow = 0; allowedHigh = 0;
  private start = '';

  ngOnInit(): void {
    this.svc.watch(this.deviceId());
  }

  /** Copies the saved ranges into the boxes. */
  private fill(): void {
    const t = this.view();
    if (!t) return;
    const u = t.unit;
    [this.comfortLow, this.comfortHigh, this.allowedLow, this.allowedHigh] =
      [shown(t.comfort.low, u), shown(t.comfort.high, u), shown(t.allowed.low, u), shown(t.allowed.high, u)];
    this.start = this.key();
    this.loaded.set(true);
    this.cd.markForCheck();
  }

  private key(): string { return [this.comfortLow, this.comfortHigh, this.allowedLow, this.allowedHigh].join(','); }

  /** Saves if anything changed; the server says what's wrong if it doesn't fit. */
  save(): Observable<unknown> {
    if (!this.loaded() || this.key() === this.start) return of(null);
    const u = this.unit();
    const ranges: Ranges = {
      comfort: { low: toC(Number(this.comfortLow), u), high: toC(Number(this.comfortHigh), u) },
      allowed: { low: toC(Number(this.allowedLow), u), high: toC(Number(this.allowedHigh), u) },
    };
    return this.svc.saveRanges(this.deviceId(), ranges);
  }
}
