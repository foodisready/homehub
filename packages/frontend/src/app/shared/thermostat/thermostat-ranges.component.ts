import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Observable, forkJoin, map, of } from 'rxjs';
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
    @media (max-width: 520px) { .r .what { width: 100%; font-weight: 500; } }
    .r input { width: 4.2rem; }
    p { font-size: 0.75rem; color: var(--text-muted); margin: 0.35rem 0 0; }
    .r select { width: auto; }
    .r input[aria-label="Heating size"] { width: 6.5rem; }
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
    <fieldset>
      <legend>Heating and cooling system</legend>
      @if (others().length) {
        <div class="r">
          <span class="what">Unit</span>
          <select [(ngModel)]="sharesWith" aria-label="Which heating and cooling unit">
            <option [ngValue]="null">Its own</option>
            @for (o of others(); track o.id) { <option [ngValue]="o.id">Same unit as {{ o.alias }}</option> }
          </select>
        </div>
      }
      @if (sharesWith !== null) {
        <p>It's a zone on {{ otherName(sharesWith) }}'s unit: it uses that unit's system, and on the Energy page the unit's running time is counted once, not once for each zone.</p>
      } @else {
      <div class="r">
        <span class="what">Heating</span>
        <select [(ngModel)]="heat" aria-label="Heating system">
          <option value="">Not set</option><option value="gas">Gas furnace</option><option value="heat_pump">Heat pump</option><option value="electric">Electric heat</option>
        </select>
        @if (heat) { <input type="number" min="0" [(ngModel)]="heatSize" [placeholder]="heatDefault()" aria-label="Heating size" /> {{ heatUnit() }} }
      </div>
      <div class="r">
        <span class="what">Cooling</span>
        <select [(ngModel)]="cool" aria-label="Cooling system">
          <option value="">None or not set</option><option value="ac">Central air</option><option value="heat_pump">Heat pump</option>
        </select>
        @if (cool) { <input type="number" min="0" step="0.5" [(ngModel)]="coolSize" [placeholder]="'3'" aria-label="Cooling size in tons" /> tons }
      </div>
      <p>For the Energy page's estimate of what heating and cooling cost, from its running hours. The size is on the unit's label: a furnace's input in BTU/h (often 40,000–100,000), a heat pump or air conditioner in tons (2–5; 36,000 BTU/h is 3 tons). Blank uses a typical size. If thermostats are zones on one unit, set the unit on one of them, and choose "Same unit as" on the others.</p>
      }
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
  private readonly http = inject(HttpClient);
  heat = ''; heatSize: number | null = null; cool = ''; coolSize: number | null = null;
  /** The thermostat whose unit this one is a zone on, or null for its own. */
  sharesWith: number | null = null;
  /** The other thermostats, to share a unit with. */
  readonly others = signal<Array<{ id: number; alias: string }>>([]);
  otherName(id: number): string { return this.others().find((o) => o.id === id)?.alias ?? 'another thermostat'; }
  private systemStart = '';
  readonly heatUnit = () => (this.heat === 'gas' ? 'BTU/h' : this.heat === 'electric' ? 'kW' : 'tons');
  readonly heatDefault = () => (this.heat === 'gas' ? '60000' : this.heat === 'electric' ? '10' : '3');
  private readonly cd = inject(ChangeDetectorRef);
  // The saved ranges arrive a moment after the popup opens: fill the boxes then, once.
  private readonly fillWhenLoaded = effect(() => {
    if (this.view() && !untracked(this.loaded)) untracked(() => this.fill());
  });

  comfortLow = 0; comfortHigh = 0; allowedLow = 0; allowedHigh = 0;
  private start = '';

  ngOnInit(): void {
    this.svc.watch(this.deviceId());
    this.http.get<{ thermostats: Array<{ id: number; alias: string }> }>('/api/thermostats').subscribe({
      next: (r) => { this.others.set(r.thermostats.filter((t) => t.id !== this.deviceId()).map(({ id, alias }) => ({ id, alias }))); this.cd.markForCheck(); },
      error: () => undefined,
    });
    this.http.get<{ heat: string | null; heatSize: number | null; cool: string | null; coolSize: number | null; sharesWith?: { id: number } | null }>(`/api/thermostats/${this.deviceId()}/system`).subscribe({
      next: (s) => {
        this.sharesWith = s.sharesWith?.id ?? null;
        [this.heat, this.heatSize, this.cool, this.coolSize] = s.sharesWith ? ['', null, '', null] : [s.heat ?? '', s.heatSize, s.cool ?? '', s.coolSize];
        this.systemStart = this.systemKey();
        this.cd.markForCheck();
      },
      error: () => undefined,
    });
  }

  private systemKey(): string { return [this.sharesWith, this.heat, this.heatSize, this.cool, this.coolSize].join(','); }

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

  /** Saves what changed, ranges and system; the server says what's wrong if it doesn't fit. */
  save(): Observable<unknown> {
    const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
    const system = this.systemKey() === this.systemStart ? of(null) : this.http.put(`/api/thermostats/${this.deviceId()}/system`, this.sharesWith !== null
      ? { sharesWith: this.sharesWith, heat: null, heatSize: null, cool: null, coolSize: null }
      : { heat: this.heat || null, heatSize: this.heat ? num(this.heatSize) : null, cool: this.cool || null, coolSize: this.cool ? num(this.coolSize) : null });
    return forkJoin([this.saveRanges(), system]).pipe(map(() => null));
  }

  private saveRanges(): Observable<unknown> {
    if (!this.loaded() || this.key() === this.start) return of(null);
    const u = this.unit();
    const ranges: Ranges = {
      comfort: { low: toC(Number(this.comfortLow), u), high: toC(Number(this.comfortHigh), u) },
      allowed: { low: toC(Number(this.allowedLow), u), high: toC(Number(this.allowedHigh), u) },
    };
    return this.svc.saveRanges(this.deviceId(), ranges);
  }
}
