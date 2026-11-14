import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, input, output, signal, viewChild } from '@angular/core';
import { kwhText, money, monthName, type MonthTotal, type Usage } from './energy.types';

const H = 180, PAD = { l: 44, r: 8, t: 22, b: 22 };

function niceTicks(hi: number, count = 4): number[] {
  const raw = Math.max(hi, 1e-9) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  if ((out.at(-1) ?? 0) < hi) out.push(Math.round((out.at(-1)! + step) * 1000) / 1000);
  return out;
}

/**
 * The last 12 months, one bar each: energy, or cost once prices are set. The month on screen is
 * picked out; this month so far is lighter; a month before HomeHub's history says so. A bar
 * opens its month. Drawn at the card's width, so text stays crisp on a phone.
 */
@Component({
  selector: 'app-energy-months',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }
    .head { display: flex; justify-content: flex-end; align-items: center; gap: 0.5rem; margin-bottom: 0.3rem; }
    .seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
    .seg button { background: transparent; color: var(--text-muted); border: none; border-radius: 0; padding: 0.3rem 0.75rem; font-size: 0.8rem; }
    .seg button[aria-pressed="true"] { background: var(--accent); color: #fff; }
    .link { background: none; border: none; color: var(--accent); font-size: 0.8rem; padding: 0.3rem; }
    .plot { position: relative; }
    svg { display: block; overflow: visible; }
    svg rect.hit { cursor: pointer; }
    .tip { position: absolute; top: 0; pointer-events: none; background: #0b1220; border: 1px solid var(--border); border-radius: 8px; padding: 0.4rem 0.55rem; font-size: 0.75rem; line-height: 1.45; white-space: nowrap; box-shadow: var(--shadow); z-index: 2; }
    .note { font-size: 0.78rem; color: var(--text-muted); margin: 0.4rem 0 0; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.8rem; font-variant-numeric: tabular-nums; }
    th, td { text-align: right; padding: 0.3rem 0.4rem; border-bottom: 1px solid var(--border); white-space: nowrap; }
    th:first-child, td:first-child { text-align: left; }
    th { color: var(--text-muted); font-weight: 500; }
    tr.on td { font-weight: 600; }
  `],
  template: `
    <div class="card" #card>
      <div class="head">
        @if (hasCost()) {
          <div class="seg" role="group" aria-label="Show">
            <button type="button" [attr.aria-pressed]="!cost()" (click)="cost.set(false)">Energy</button>
            <button type="button" [attr.aria-pressed]="cost()" (click)="cost.set(true)">Cost</button>
          </div>
        }
        <button type="button" class="link" (click)="table.set(!table())">{{ table() ? 'Chart' : 'Table' }}</button>
      </div>
      @if (!table()) {
        <div class="plot" (pointerleave)="hover.set(-1)">
          <svg [attr.width]="width()" [attr.height]="h" role="img" aria-label="Electricity by month">
            <text [attr.x]="pad.l - 6" y="10" text-anchor="end" font-size="10" fill="#94a3b8">{{ cost() ? usage().prices.currency : 'kWh' }}</text>
            @for (t of chart().ticks; track t.v) {
              <line [attr.x1]="pad.l" [attr.x2]="width() - pad.r" [attr.y1]="t.y" [attr.y2]="t.y" stroke="#334155" stroke-width="1" />
              <text [attr.x]="pad.l - 6" [attr.y]="t.y + 3.5" text-anchor="end" font-size="10" fill="#94a3b8">{{ t.label }}</text>
            }
            @for (b of chart().bars; track b.month) {
              @if (b.d) { <path [attr.d]="b.d" [attr.fill]="b.current ? '#3b82f6' : '#64748b'" [attr.opacity]="b.partial ? 0.6 : 1" /> }
            }
            @for (b of chart().bars; track b.month; let i = $index) {
              <text [attr.x]="b.cx" [attr.y]="h - 6" text-anchor="middle" font-size="10" [attr.fill]="b.current ? '#f8fafc' : b.recorded ? '#94a3b8' : '#475569'" [attr.font-weight]="b.current ? 600 : 400">{{ b.label }}</text>
              <rect class="hit" [attr.x]="b.x" y="0" [attr.width]="b.w" [attr.height]="h" fill="transparent"
                    (pointerenter)="hover.set(i)" (click)="b.recorded && pick.emit(b.month)" />
            }
          </svg>
          @if (tip(); as t) {
            <div class="tip" [style.left.px]="t.left" role="status"><b>{{ t.title }}</b>@for (l of t.lines; track l) {<br>{{ l }}}</div>
          }
        </div>
        <p class="note">Tap a month to see it. Lighter: this month so far.</p>
      } @else {
        <div class="table-wrap"><table>
          <thead><tr><th>Month</th><th>Electricity</th><th>Gas</th>@if (hasCost()) {<th>Cost</th>}</tr></thead>
          <tbody>
            @for (m of usage().months; track m.month) {
              <tr [class.on]="m.month === usage().month">
                <td>{{ long(m.month) }}{{ m.month === usage().thisMonth ? ' (so far)' : '' }}</td>
                @if (m.recorded) {
                  <td>{{ kwh(m.kwh) }}</td><td>{{ m.therms ? m.therms + ' therms' : '–' }}</td>
                  @if (hasCost()) {<td>{{ m.cost === null ? '–' : money(m.cost) }}</td>}
                } @else {
                  <td [attr.colspan]="hasCost() ? 3 : 2" style="text-align:center;color:var(--text-muted)">Not recorded</td>
                }
              </tr>
            }
          </tbody>
        </table></div>
      }
    </div>
  `,
})
export class EnergyMonthsComponent implements AfterViewInit, OnDestroy {
  readonly usage = input.required<Usage>();
  readonly pick = output<string>();
  private readonly card = viewChild.required<ElementRef<HTMLElement>>('card');

  readonly h = H;
  readonly pad = PAD;
  readonly kwh = kwhText;
  readonly width = signal(320);
  readonly cost = signal(false);
  readonly table = signal(false);
  readonly hover = signal(-1);
  private resize?: ResizeObserver;

  // The card's inside width, inside its padding: the chart is drawn to fit exactly.
  ngAfterViewInit(): void {
    this.resize = new ResizeObserver(([e]) => this.width.set(Math.max(240, Math.floor(e.contentRect.width))));
    this.resize.observe(this.card().nativeElement);
  }
  ngOnDestroy(): void { this.resize?.disconnect(); }

  long(m: string): string { return monthName(m, 'long', true); }
  money(v: number): string { return money(v, this.usage().prices.currency); }
  readonly hasCost = computed(() => this.usage().months.some((m) => m.recorded && m.cost !== null && m.cost > 0));

  private value(m: MonthTotal): number | null {
    if (!m.recorded) return null;
    return this.cost() ? m.cost : m.kwh;
  }

  readonly chart = computed(() => {
    const ms = this.usage().months;
    const w = this.width(), plotW = w - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
    const vals = ms.map((m) => this.value(m)).filter((v): v is number => v !== null);
    const ticks = niceTicks(Math.max(...vals, 1));
    const top = ticks.at(-1) ?? 1;
    const y = (v: number) => PAD.t + plotH - (v / top) * plotH;
    const slot = plotW / Math.max(ms.length, 1);
    const barW = Math.max(4, Math.min(28, slot - 10));
    const bars = ms.map((m, i) => {
      const x = PAD.l + i * slot, cx = x + slot / 2;
      const v = this.value(m);
      let d = '';
      if (v !== null && v > 0) {
        const by = y(v), bx = cx - barW / 2, bh = PAD.t + plotH - by, r = Math.min(4, barW / 2, bh);
        d = `M${bx},${PAD.t + plotH} V${by + r} Q${bx},${by} ${bx + r},${by} H${bx + barW - r} Q${bx + barW},${by} ${bx + barW},${by + r} V${PAD.t + plotH} Z`;
      }
      const label = monthName(m.month, 'short');
      return { month: m.month, x, w: slot, cx, d, recorded: m.recorded, partial: m.month === this.usage().thisMonth, current: m.month === this.usage().month, label: slot < 30 ? label.slice(0, 1) : label };
    });
    const fmt = (v: number) => (this.cost() ? money(v, this.usage().prices.currency) : `${v}`);
    return { ticks: ticks.map((v) => ({ v, y: y(v), label: fmt(v) })), bars };
  });

  readonly tip = computed(() => {
    const i = this.hover();
    const m = this.usage().months[i];
    const b = this.chart().bars[i];
    if (!m || !b) return null;
    const lines = !m.recorded ? ['Not recorded: before HomeHub kept this history'] : [
      kwhText(m.kwh) + (m.therms ? ` · ${m.therms} therms gas` : ''),
      ...(m.cost !== null && m.cost > 0 ? [`about ${money(m.cost, this.usage().prices.currency)}`] : []),
      ...(m.notCounted ? [`${m.notCounted} not counted yet`] : []),
    ];
    return { title: `${monthName(m.month, 'long', true)}${b.partial ? ' so far' : ''}`, lines, left: Math.min(Math.max(b.cx - 80, 0), this.width() - 180) };
  });
}
