import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { kwhText, money, monthName, type Usage } from './energy.types';

const CURRENCIES = ['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'HKD', 'CNY', 'VND', 'SGD', 'JPY'];

/**
 * The month in a few numbers: electricity, gas, cost, and how it compares; then plainly what
 * it covers and what it doesn't. An admin sets the prices here.
 */
@Component({
  selector: 'app-energy-overview',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.6rem; }
    .tile { background: var(--bg); border-radius: var(--radius); padding: 0.7rem 0.85rem; }
    .v { font-size: 1.55rem; font-weight: 600; line-height: 1.2; }
    .l { font-size: 0.78rem; color: var(--text-muted); margin-top: 0.15rem; }
    .about { font-size: 0.8rem; color: var(--text-muted); margin: 0.8rem 0 0; line-height: 1.5; }
    .link { background: none; border: none; color: var(--accent); padding: 0; font-size: inherit; text-align: left; }
    form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.6rem; margin-top: 0.8rem; padding-top: 0.8rem; border-top: 1px solid var(--border); }
    label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.78rem; color: var(--text-muted); }
    input { width: 7rem; }
    select { width: 5.5rem; }
    .err { color: var(--red); font-size: 0.8rem; width: 100%; margin: 0; }
    @media (max-width: 520px) {
      .tiles { grid-template-columns: 1fr; gap: 0.4rem; }
      .tile { display: flex; align-items: baseline; gap: 0.7rem; padding: 0.55rem 0.75rem; }
      .v { font-size: 1.2rem; min-width: 5.4rem; }
      .l { margin: 0; }
    }
  `],
  template: `
    <div class="card">
      <div class="tiles">
        <div class="tile">
          <div class="v">{{ kwh(u().totals.kwh) }}</div>
          <div class="l">{{ u().panel?.wholeKwh != null ? 'HomeHub’s devices, estimated,' : 'electricity' }} {{ u().partial ? 'this month so far' : 'in ' + monthLong() }}</div>
        </div>
        @if (u().totals.therms > 0) {
          <div class="tile"><div class="v">{{ u().totals.therms }} therms</div><div class="l">gas, for heating</div></div>
        }
        <div class="tile">
          @if (u().totals.cost !== null) {
            <div class="v">{{ cost(u().totals.cost!) }}</div>
            <div class="l">{{ projected() ? 'so far · about ' + projected() + ' for the month' : 'estimated cost' }}</div>
          } @else if (u().totals.electricityCost !== null && u().totals.gasCost === null) {
            <div class="v">{{ cost(u().totals.electricityCost!) }}</div>
            <div class="l">electricity only ·
              @if (admin()) { <button type="button" class="link" (click)="editing.set(true)">add your gas price</button> } @else { no gas price yet }
            </div>
          } @else {
            <div class="v">–</div>
            <div class="l">
              @if (admin()) { <button type="button" class="link" (click)="editing.set(true)">Add your energy prices</button> to see the cost }
              @else { No price set yet: an admin can add it here }
            </div>
          }
        </div>
        <div class="tile"><div class="v">{{ compare().value }}</div><div class="l">{{ compare().label }}</div></div>
      </div>

      <p class="about">
        Estimated for {{ counted() }} {{ counted() === 1 ? 'device' : 'devices' }} HomeHub switches{{ hvacCounted() ? ', and your heating and cooling,' : '' }}
        from how long each was on and what it draws. It isn’t your whole home: the fridge, water heater and other appliances HomeHub doesn’t control aren’t included.
        @if (u().recordedFrom; as since) { Counted from {{ day(since) }}, when HomeHub started keeping this history. }
        @if (u().totals.notCounted) { {{ u().totals.notCounted }} {{ u().totals.notCounted === 1 ? 'isn’t' : 'aren’t' }} counted yet: see below. }
        @if (admin() && u().totals.cost !== null && !editing()) { <button type="button" class="link" (click)="editing.set(true)">Change prices</button> }
      </p>

      @if (editing()) {
        <form (submit)="$event.preventDefault(); save()">
          <label>Electricity, per kWh <input type="number" step="0.001" min="0" [(ngModel)]="electricity" name="electricity" placeholder="e.g. 0.32" /></label>
          @if (gasNeeded()) {
            <label>Gas, per therm <input type="number" step="0.01" min="0" [(ngModel)]="gas" name="gas" placeholder="e.g. 1.80" /></label>
          }
          <label>Currency
            <select [(ngModel)]="currency" name="currency">@for (c of currencies; track c) { <option [value]="c">{{ c }}</option> }</select>
          </label>
          <button type="submit" class="btn-primary" [disabled]="saving()">Save</button>
          <button type="button" class="btn-ghost" (click)="editing.set(false)">Cancel</button>
          <p class="about" style="width:100%;margin:0">On your bill, the total divided by the kWh used is close enough. In much of the US that’s about 0.17 per kWh; in California, nearer 0.35.</p>
          @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
        </form>
      }
    </div>
  `,
})
export class EnergyOverviewComponent {
  readonly usage = input.required<Usage>();
  readonly admin = input(false);
  readonly changed = output<void>();
  private readonly http = inject(HttpClient);

  readonly u = this.usage;
  readonly currencies = CURRENCIES;
  readonly editing = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');
  electricity: number | null = null;
  gas: number | null = null;
  currency = 'USD';

  readonly kwh = kwhText;
  cost(v: number): string { return money(v, this.u().prices.currency); }
  readonly monthLong = computed(() => monthName(this.u().month));
  day(isoTime: string): string { return new Date(isoTime).toLocaleDateString([], { month: 'long', day: 'numeric', timeZone: this.u().timezone }); }

  readonly counted = computed(() => this.u().devices.filter((d) => d.kwh !== null).length);
  readonly hvacCounted = computed(() => this.u().hvac.some((h) => h.kwh !== null));
  readonly gasNeeded = computed(() => this.u().totals.therms > 0 || this.u().hvac.some((h) => h.system === 'gas') || this.u().prices.gas !== null);

  /** A month so far, at the same pace for the rest: only once there are a few days to go on. */
  readonly projected = computed(() => {
    const u = this.u();
    const c = u.totals.cost ?? (u.totals.gasCost === null ? u.totals.electricityCost : null);
    if (!u.partial || c === null || u.days < 3) return '';
    return this.cost((c / u.days) * u.daysInMonth);
  });

  readonly compare = computed(() => {
    const u = this.u();
    const p = u.previousSameDays;
    if (u.partial) {
      // The same devices both times. By cost when both are known (it adds electricity and gas
      // fairly), else by electricity.
      const byCost = !!p && p.previous.cost !== null && p.current.cost !== null && p.previous.cost > 0;
      const before = !p ? 0 : byCost ? p.previous.cost! : p.previous.kwh;
      const now = !p ? 0 : byCost ? p.current.cost! : p.current.kwh;
      if (!p || before < (byCost ? 0.01 : 0.05)) return { value: '–', label: 'Not enough history to compare with last month yet' };
      const pct = Math.round((now / before - 1) * 100);
      const span = `${monthName(p.month)}’s first ${Math.round(p.days)} days`;
      const who = p.devices === this.counted() + (this.hvacCounted() ? 1 : 0) ? '' : `, for the ${p.devices} ${p.devices === 1 ? 'device' : 'devices'} recorded both times`;
      const weather = p.heating ? ' (heating follows the weather)' : '';
      if (Math.abs(pct) < 3) return { value: 'About the same', label: `as ${span}${who}${weather}` };
      return { value: `${pct < 0 ? '↓' : '↑'} ${Math.abs(pct)}%`, label: `${pct < 0 ? 'less' : 'more'} than ${span}${who}${weather}` };
    }
    // A finished month: against the one before, if HomeHub had all of that one too.
    const i = u.months.findIndex((m) => m.month === u.month);
    const prev = i > 0 ? u.months[i - 1] : undefined;
    const before = i > 1 ? u.months[i - 2] : undefined;
    if (!prev || !prev.recorded || !before?.recorded || prev.kwh < 0.05) return { value: '–', label: 'Not enough history to compare with the month before' };
    const pct = Math.round((u.totals.kwh / prev.kwh - 1) * 100);
    if (Math.abs(pct) < 3) return { value: 'About the same', label: `as ${monthName(prev.month)}` };
    return { value: `${pct < 0 ? '↓' : '↑'} ${Math.abs(pct)}%`, label: `${pct < 0 ? 'less' : 'more'} than ${monthName(prev.month)}` };
  });

  ngOnInit(): void {
    const p = this.u().prices;
    this.electricity = p.electricity; this.gas = p.gas; this.currency = p.currency;
  }

  save(): void {
    this.saving.set(true);
    this.error.set('');
    const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
    this.http.put('/api/energy/prices', { electricity: num(this.electricity), gas: num(this.gas), currency: this.currency }).subscribe({
      next: () => { this.saving.set(false); this.editing.set(false); this.changed.emit(); },
      error: (e) => { this.saving.set(false); this.error.set(e?.error?.error ?? 'The prices couldn’t be saved.'); },
    });
  }
}
