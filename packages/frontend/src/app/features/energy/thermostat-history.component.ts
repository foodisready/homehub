import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, computed, inject, input, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { shown } from '../../shared/thermostat/thermostat.service';

interface Month {
  month: string; heatHours: number; coolHours: number; hdd: number; cdd: number;
  weatherDays: number; days: number; inside: number | null; recorded: boolean; partial: boolean;
}
interface MonthsResponse {
  months: Month[]; today: { heatHours: number; coolHours: number }; reportsRunning: boolean; unit: 'F' | 'C';
  /** The home's time zone and today's date there: times are labelled the home's way, wherever the phone is. */
  timezone: string; todayDate: string;
}
interface DayResponse {
  date: string; from: string; to: string; unit: 'F' | 'C';
  samples: { at: string; temperature: number | null; heat: number | null; cool: number | null; mode: string | null; running: string | null }[];
  runs: { kind: 'heating' | 'cooling'; from: string; to: string }[];
  outdoor: { at: string; temperature: number }[];
  heatHours: number; coolHours: number;
}

/** Below this many degree-days a month is too mild for "per degree-day" to mean much. */
const MIN_DD = 30;
const MONTH_H = 170, DAY_H = 190, PAD = { l: 34, r: 8, t: 12, b: 22 };

const monthName = (m: string, style: 'short' | 'long' = 'short') =>
  new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString([], { month: style });
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** "2026-11-14" moved by some days, by the calendar alone. */
const addDays = (date: string, by: number) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + by)).toISOString().slice(0, 10);
};
/** "3a", "12p": an hour of the day in the home's time zone. */
const hourLabel = (ms: number, timeZone?: string) => {
  const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(ms)) % 24;
  return h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`;
};
const hours = (h: number) => `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;

/** Rounded steps for an axis from 0 or lo to hi: about four lines. */
function niceTicks(lo: number, hi: number, count = 4): number[] {
  const span = Math.max(hi - lo, 1e-9);
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

/**
 * A thermostat's history on the Energy page: this month's headline numbers, running hours by
 * month (or per degree-day, for the weather), and one day's temperatures with when it ran.
 * Charts are drawn at the card's real width, so text stays crisp on a phone.
 */
@Component({
  selector: 'app-thermostat-history',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }
    h3 { font-size: 1rem; font-weight: 600; margin: 0 0 0.75rem; }
    h4 { font-size: 0.85rem; font-weight: 600; margin: 0; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.6rem; margin-bottom: 1.1rem; }
    .tile { background: var(--bg); border-radius: var(--radius); padding: 0.65rem 0.8rem; }
    .tile .v { font-size: 1.5rem; font-weight: 600; line-height: 1.2; }
    .tile .l { font-size: 0.75rem; color: var(--text-muted); margin-top: 0.15rem; }
    @media (max-width: 520px) {
      .tiles { grid-template-columns: 1fr; gap: 0.4rem; }
      .tile { display: flex; align-items: baseline; gap: 0.7rem; padding: 0.5rem 0.7rem; }
      .tile .v { font-size: 1.2rem; min-width: 4.6rem; }
      .tile .l { margin: 0; }
    }
    .table-wrap { overflow-x: auto; }
    .bar { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap; margin: 0.4rem 0 0.5rem; }
    .seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
    .seg button { background: transparent; color: var(--text-muted); border: none; border-radius: 0; padding: 0.3rem 0.7rem; font-size: 0.8rem; }
    .seg button[aria-pressed="true"] { background: var(--accent); color: #fff; }
    .link { background: none; border: none; color: var(--accent); font-size: 0.8rem; padding: 0.3rem; }
    .plot { position: relative; touch-action: pan-y; }
    svg { display: block; overflow: visible; }
    .legend { display: flex; gap: 0.9rem; flex-wrap: wrap; font-size: 0.75rem; color: var(--text-muted); margin-top: 0.35rem; }
    .key { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 0.3rem; vertical-align: -1px; }
    .key.line { height: 2px; vertical-align: 3px; width: 14px; }
    .tip { position: absolute; top: 0; pointer-events: none; background: #0b1220; border: 1px solid var(--border); border-radius: 8px;
           padding: 0.4rem 0.55rem; font-size: 0.75rem; line-height: 1.45; white-space: nowrap; box-shadow: var(--shadow); z-index: 2; }
    .tip b { font-weight: 600; }
    .note { font-size: 0.8rem; color: var(--text-muted); margin: 0.3rem 0 0; }
    table { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin-top: 0.4rem; font-variant-numeric: tabular-nums; }
    th, td { text-align: right; padding: 0.3rem 0.4rem; border-bottom: 1px solid var(--border); }
    th:first-child, td:first-child { text-align: left; }
    td { white-space: nowrap; }
    th { color: var(--text-muted); font-weight: 500; }
    .day-nav { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.85rem; }
    .day-nav button { background: var(--bg); border: 1px solid var(--border); color: var(--text); width: 2rem; height: 2rem; padding: 0; border-radius: 50%; }
    .day-nav button:disabled { opacity: 0.35; }
    .day-nav span { min-width: 7.5rem; text-align: center; }
    .section { margin-top: 1.4rem; }
  `],
  template: `
    <h3>{{ alias() }}</h3>
    @if (data(); as d) {
      @if (d.reportsRunning) {
        <div class="tiles">
          <div class="tile"><div class="v">{{ hours(headline().month) }}</div><div class="l">{{ headline().kindWord }} this month so far</div></div>
          <div class="tile">
            <div class="v">{{ compare().value }}</div>
            <div class="l">{{ compare().label }}</div>
          </div>
          <div class="tile"><div class="v">{{ hours(headline().today) }}</div><div class="l">{{ headline().kindWord }} today</div></div>
        </div>

        <div class="bar">
          <h4 id="months-{{ deviceId() }}">By month</h4>
          <div style="display:flex;gap:0.4rem;align-items:center">
            <div class="seg" role="group" aria-label="Show">
              <button type="button" [attr.aria-pressed]="!perWeather()" (click)="perWeather.set(false)">Hours</button>
              <button type="button" [attr.aria-pressed]="perWeather()" (click)="perWeather.set(true)">For the weather</button>
            </div>
            <button type="button" class="link" (click)="table.set(!table())">{{ table() ? 'Chart' : 'Table' }}</button>
          </div>
        </div>
        @if (!table()) {
          <div class="plot" (pointerleave)="monthHover.set(-1)">
            <svg [attr.width]="width()" [attr.height]="monthH" role="img" [attr.aria-labelledby]="'months-' + deviceId()">
              @for (t of monthChart().ticks; track t.v) {
                <line [attr.x1]="pad.l" [attr.x2]="width() - pad.r" [attr.y1]="t.y" [attr.y2]="t.y" stroke="#334155" stroke-width="1" />
                <text [attr.x]="pad.l - 6" [attr.y]="t.y + 3.5" text-anchor="end" font-size="10" fill="#94a3b8">{{ t.label }}</text>
              }
              @for (b of monthChart().bars; track b.key) {
                <path [attr.d]="b.d" [attr.fill]="b.color" [attr.opacity]="b.partial ? 0.6 : 1" />
              }
              @for (m of monthChart().slots; track m.month; let i = $index) {
                <text [attr.x]="m.cx" [attr.y]="monthH - 6" text-anchor="middle" font-size="10" [attr.fill]="m.recorded ? '#94a3b8' : '#475569'">{{ m.label }}</text>
                <rect [attr.x]="m.x" y="0" [attr.width]="m.w" [attr.height]="monthH" fill="transparent" (pointerenter)="monthHover.set(i)" (click)="monthHover.set(i)" />
              }
            </svg>
            @if (monthTip(); as tip) {
              <div class="tip" [style.left.px]="tip.left" role="status">
                <b>{{ tip.title }}</b>
                @for (line of tip.lines; track line) { <br>{{ line }} }
              </div>
            }
          </div>
          <div class="legend">
            <span><i class="key" style="background:#d95926"></i>Heating</span>
            <span><i class="key" style="background:#3987e5"></i>Cooling</span>
            <span>Lighter: this month so far</span>
          </div>
          @if (perWeather()) {
            <p class="note">Hours per 100 degree-days: how much it ran for how cold or hot it was, so months compare fairly. Months too mild to tell are left out.</p>
          }
        } @else {
          <div class="table-wrap"><table>
            <thead><tr><th>Month</th><th>Heating</th><th>Cooling</th><th>Heating degree-days</th><th>Cooling degree-days</th><th>Average inside</th></tr></thead>
            <tbody>
              @for (m of d.months; track m.month) {
                <tr>
                  <td>{{ monthLong(m.month) }}{{ m.partial ? ' (so far)' : '' }}</td>
                  @if (m.recorded) {
                    <td>{{ m.heatHours }} h</td><td>{{ m.coolHours }} h</td>
                    <td>{{ m.weatherDays ? m.hdd : '–' }}</td><td>{{ m.weatherDays ? m.cdd : '–' }}</td>
                    <td>{{ m.inside === null ? '–' : deg(m.inside) }}</td>
                  } @else {
                    <td colspan="5" style="text-align:center;color:var(--text-muted)">Not recorded</td>
                  }
                </tr>
              }
            </tbody>
          </table></div>
        }
      } @else {
        <p class="note">This thermostat doesn't say when it's heating or cooling, so HomeHub can't count its running hours. Its temperatures are still recorded below.</p>
      }

      <div class="section">
        <div class="bar">
          <h4 id="day-{{ deviceId() }}">Temperatures</h4>
          <div class="day-nav">
            <button type="button" (click)="moveDay(-1)" aria-label="Day before">‹</button>
            <span aria-live="polite">{{ dayLabel() }}</span>
            <button type="button" (click)="moveDay(1)" [disabled]="isToday()" aria-label="Day after">›</button>
          </div>
        </div>
        @if (dayData(); as day) {
          @if (!day.samples.length && !day.outdoor.length) {
            <p class="note">Nothing recorded this day.</p>
          } @else {
            <div class="plot" (pointermove)="dayMove($event)" (pointerdown)="dayMove($event)" (pointerleave)="dayHover.set(null)">
              <svg [attr.width]="width()" [attr.height]="dayH" role="img" [attr.aria-labelledby]="'day-' + deviceId()">
                @for (r of dayChart().bands; track r.x) {
                  <rect [attr.x]="r.x" [attr.y]="pad.t" [attr.width]="r.w" [attr.height]="dayH - pad.t - pad.b" [attr.fill]="r.color" opacity="0.22" />
                }
                @for (t of dayChart().ticks; track t.v) {
                  <line [attr.x1]="pad.l" [attr.x2]="width() - pad.r" [attr.y1]="t.y" [attr.y2]="t.y" stroke="#334155" stroke-width="1" />
                  <text [attr.x]="pad.l - 6" [attr.y]="t.y + 3.5" text-anchor="end" font-size="10" fill="#94a3b8">{{ t.label }}</text>
                }
                @for (x of dayChart().hours; track x.label) {
                  <text [attr.x]="x.x" [attr.y]="dayH - 6" text-anchor="middle" font-size="10" fill="#94a3b8">{{ x.label }}</text>
                }
                <path [attr.d]="dayChart().outdoor" fill="none" stroke="#199e70" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
                <path [attr.d]="dayChart().target" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-linejoin="round" />
                <path [attr.d]="dayChart().inside" fill="none" stroke="#f8fafc" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
                @if (dayHover(); as hv) {
                  <line [attr.x1]="hv.x" [attr.x2]="hv.x" [attr.y1]="pad.t" [attr.y2]="dayH - pad.b" stroke="#cbd5e1" stroke-width="1" />
                }
              </svg>
              @if (dayHover(); as hv) {
                <div class="tip" [style.left.px]="hv.left" role="status">
                  <b>{{ hv.time }}</b>
                  @for (line of hv.lines; track line) { <br>{{ line }} }
                </div>
              }
            </div>
            <div class="legend">
              <span><i class="key line" style="background:#f8fafc"></i>Inside</span>
              <span><i class="key line" style="background:#94a3b8"></i>Target</span>
              <span><i class="key line" style="background:#199e70"></i>Outside</span>
              <span><i class="key" style="background:#d95926;opacity:0.5"></i>Heating</span>
              <span><i class="key" style="background:#3987e5;opacity:0.5"></i>Cooling</span>
            </div>
            @if (d.reportsRunning) {
              <p class="note">Heated {{ hours(day.heatHours) }}, cooled {{ hours(day.coolHours) }}.</p>
            }
          }
        }
      </div>
    } @else {
      <p class="note">Loading…</p>
    }
  `,
})
export class ThermostatHistoryComponent implements OnInit, OnDestroy {
  readonly deviceId = input.required<number>();
  readonly alias = input('');
  private readonly http = inject(HttpClient);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly pad = PAD;
  readonly monthH = MONTH_H;
  readonly dayH = DAY_H;
  readonly hours = hours;

  readonly data = signal<MonthsResponse | null>(null);
  readonly dayData = signal<DayResponse | null>(null);
  readonly date = signal(localDate(new Date()));
  readonly perWeather = signal(false);
  readonly table = signal(false);
  readonly width = signal(320);
  readonly monthHover = signal(-1);
  readonly dayHover = signal<{ x: number; left: number; time: string; lines: string[] } | null>(null);
  private resize?: ResizeObserver;
  private refresh?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    this.resize = new ResizeObserver(([e]) => this.width.set(Math.max(260, Math.floor(e.contentRect.width))));
    this.resize.observe(this.host.nativeElement);
    this.load();
    // While open, keep today current: a sample lands every 5 minutes.
    this.refresh = setInterval(() => { if (this.isToday()) this.load(); }, 5 * 60_000);
  }
  ngOnDestroy(): void { this.resize?.disconnect(); if (this.refresh) clearInterval(this.refresh); }

  private load(): void {
    this.http.get<MonthsResponse>(`/api/thermostats/${this.deviceId()}/months?count=12`).subscribe({
      next: (d) => {
        // The first time, and at midnight: today is the home's today.
        if (!this.data() || this.date() === this.data()?.todayDate) this.date.set(d.todayDate);
        this.data.set(d);
        this.loadDay();
      },
      error: () => this.loadDay(),
    });
  }
  private loadDay(): void {
    this.http.get<DayResponse>(`/api/thermostats/${this.deviceId()}/day?date=${this.date()}`).subscribe({ next: (d) => this.dayData.set(d), error: () => undefined });
  }

  deg(c: number): string { return `${shown(c, this.data()?.unit ?? 'F')}°`; }
  monthLong(m: string): string { return monthName(m, 'long'); }

  // ── Headline numbers ──

  /** Heating or cooling, whichever ran more this month: in November that's heating. */
  readonly headline = computed(() => {
    const d = this.data();
    const now = d?.months.at(-1);
    const cool = !!now && now.coolHours > now.heatHours;
    return {
      cool,
      kindWord: cool ? 'Cooling' : 'Heating',
      month: now ? (cool ? now.coolHours : now.heatHours) : 0,
      today: d ? (cool ? d.today.coolHours : d.today.heatHours) : 0,
    };
  });

  /** This month against last, per degree-day, so a colder month doesn't look like a worse one. */
  readonly compare = computed(() => {
    const d = this.data();
    const ms = d?.months ?? [];
    const now = ms.at(-1), before = ms.at(-2);
    const cool = this.headline().cool;
    const word = cool ? 'cooling' : 'heating';
    if (!now || !before || !before.recorded) return { value: '–', label: `Not enough history to compare with ${before ? monthName(before.month, 'long') : 'last month'} yet` };
    const rate = (m: Month) => { const dd = cool ? m.cdd : m.hdd; return dd >= MIN_DD ? (cool ? m.coolHours : m.heatHours) / dd : null; };
    const a = rate(now), b = rate(before);
    if (a === null || b === null || b === 0) return { value: '–', label: `Too mild to compare ${word} with ${monthName(before.month, 'long')}` };
    const pct = Math.round((a / b - 1) * 100);
    if (Math.abs(pct) < 3) return { value: 'About the same', label: `${word} as ${monthName(before.month, 'long')}, for the weather` };
    return { value: `${pct < 0 ? '↓' : '↑'} ${Math.abs(pct)}%`, label: `${pct < 0 ? 'less' : 'more'} ${word} than ${monthName(before.month, 'long')}, for the weather` };
  });

  // ── By month ──

  private value(m: Month, kind: 'heat' | 'cool'): number | null {
    if (!m.recorded) return null;
    const h = kind === 'heat' ? m.heatHours : m.coolHours;
    if (!this.perWeather()) return h;
    const dd = kind === 'heat' ? m.hdd : m.cdd;
    return dd >= MIN_DD ? (h / dd) * 100 : null;
  }

  readonly monthChart = computed(() => {
    const ms = this.data()?.months ?? [];
    const w = this.width(), plotW = w - PAD.l - PAD.r, plotH = MONTH_H - PAD.t - PAD.b;
    const vals = ms.flatMap((m) => [this.value(m, 'heat'), this.value(m, 'cool')]).filter((v): v is number => v !== null);
    const max = Math.max(...vals, this.perWeather() ? 1 : 4);
    const ticks = niceTicks(0, max);
    const top = Math.max(ticks.at(-1) ?? max, max);
    const y = (v: number) => PAD.t + plotH - (v / top) * plotH;
    const slotW = plotW / Math.max(ms.length, 1);
    const barW = Math.max(3, Math.min(14, (slotW - 8) / 2));
    const bars: { key: string; d: string; color: string; partial: boolean }[] = [];
    const slots = ms.map((m, i) => {
      const x = PAD.l + i * slotW, cx = x + slotW / 2;
      (['heat', 'cool'] as const).forEach((kind, k) => {
        const v = this.value(m, kind);
        if (v === null || v <= 0) return;
        const bx = cx - barW - 1 + k * (barW + 2);   // a 2px gap between the pair
        const by = y(v), bh = PAD.t + plotH - by;
        const r = Math.min(4, barW / 2, bh);
        // Rounded at the data end only, square on the baseline.
        const d = `M${bx},${PAD.t + plotH} V${by + r} Q${bx},${by} ${bx + r},${by} H${bx + barW - r} Q${bx + barW},${by} ${bx + barW},${by + r} V${PAD.t + plotH} Z`;
        bars.push({ key: `${m.month}-${kind}`, d, color: kind === 'heat' ? '#d95926' : '#3987e5', partial: m.partial });
      });
      const label = monthName(m.month);
      return { month: m.month, x, w: slotW, cx, recorded: m.recorded, label: slotW < 26 ? label.slice(0, 1) : label };
    });
    const fmt = (v: number) => (this.perWeather() ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : `${v}h`);
    return { ticks: ticks.map((v) => ({ v, y: y(v), label: fmt(v) })), bars, slots };
  });

  readonly monthTip = computed(() => {
    const i = this.monthHover();
    const m = this.data()?.months[i];
    const slot = this.monthChart().slots[i];
    if (!m || !slot) return null;
    const title = `${monthName(m.month, 'long')}${m.partial ? ' so far' : ''}`;
    const lines: string[] = [];
    if (!m.recorded) lines.push('Not recorded: HomeHub wasn’t keeping history yet');
    else {
      lines.push(`Heating ${m.heatHours} h · Cooling ${m.coolHours} h`);
      if (m.weatherDays) {
        lines.push(`${Math.round(m.hdd)} heating · ${Math.round(m.cdd)} cooling degree-days`);
        const rate = (h: number, dd: number) => (dd >= MIN_DD ? `${((h / dd) * 100).toFixed(1)} h per 100` : 'too mild to tell');
        if (m.heatHours || m.hdd >= MIN_DD) lines.push(`Heating for the weather: ${rate(m.heatHours, m.hdd)}`);
        if (m.coolHours || m.cdd >= MIN_DD) lines.push(`Cooling for the weather: ${rate(m.coolHours, m.cdd)}`);
      } else lines.push('No outdoor temperatures for this month');
      if (m.inside !== null) lines.push(`Average inside ${this.deg(m.inside)}`);
    }
    return { title, lines, left: Math.min(Math.max(slot.cx - 90, 0), this.width() - 200) };
  });

  // ── One day ──

  private readonly today = computed(() => this.data()?.todayDate ?? localDate(new Date()));
  readonly isToday = computed(() => this.date() >= this.today());
  readonly dayLabel = computed(() => {
    if (this.isToday()) return 'Today';
    if (this.date() === addDays(this.today(), -1)) return 'Yesterday';
    const [y, m, d] = this.date().split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  });

  moveDay(by: number): void {
    const next = addDays(this.date(), by);
    if (next > this.today()) return;
    this.date.set(next);
    this.dayHover.set(null);
    this.dayData.set(null);
    this.loadDay();
  }

  readonly dayChart = computed(() => {
    const day = this.dayData();
    const unit = this.data()?.unit ?? day?.unit ?? 'F';
    const w = this.width(), plotW = w - PAD.l - PAD.r, plotH = DAY_H - PAD.t - PAD.b;
    const empty = { bands: [], ticks: [], hours: [], inside: '', target: '', outdoor: '', x: (_: number) => 0, y: (_: number) => 0, from: 0, to: 1 };
    if (!day) return empty;
    const from = Date.parse(day.from), to = Date.parse(day.to);
    const x = (t: number) => PAD.l + ((t - from) / (to - from)) * plotW;
    const conv = (c: number) => (unit === 'F' ? c * 9 / 5 + 32 : c);
    const temps = [
      ...day.samples.flatMap((s) => [s.temperature, s.mode === 'heat' || s.mode === 'auto' ? s.heat : null, s.mode === 'cool' || s.mode === 'auto' ? s.cool : null]),
      ...day.outdoor.map((o) => o.temperature),
    ].filter((v): v is number => v !== null).map(conv);
    const lo = Math.floor(Math.min(...temps, unit === 'F' ? 60 : 16) - 2), hi = Math.ceil(Math.max(...temps, unit === 'F' ? 75 : 24) + 2);
    const ticks = niceTicks(lo, hi);
    const y0 = Math.min(lo, ticks[0] ?? lo), y1 = Math.max(hi, ticks.at(-1) ?? hi);
    const y = (v: number) => PAD.t + plotH - ((conv(v) - y0) / (y1 - y0)) * plotH;
    // A gap in the data breaks the line: more than 15 minutes between samples means HomeHub
    // wasn't recording; outdoor temperatures are hourly, so their gap is 2 hours.
    const line = (pts: { t: number; v: number | null }[], step = false, gap = 15 * 60_000) => {
      let d = '', prev: { t: number; v: number } | null = null;
      for (const p of pts) {
        if (p.v === null) { prev = null; continue; }
        const px = x(p.t).toFixed(1), py = y(p.v).toFixed(1);
        if (!prev || p.t - prev.t > gap) d += `M${px},${py}`;
        else d += step ? `H${px}V${py}` : `L${px},${py}`;
        prev = { t: p.t, v: p.v };
      }
      return d;
    };
    const samples = day.samples.map((s) => ({ ...s, t: Date.parse(s.at) }));
    const target = samples.map((s) => ({ t: s.t, v: s.mode === 'heat' ? s.heat : s.mode === 'cool' ? s.cool : null }));
    const autoCool = samples.map((s) => ({ t: s.t, v: s.mode === 'auto' ? s.cool : null }));
    const autoHeat = samples.map((s) => ({ t: s.t, v: s.mode === 'auto' ? s.heat : null }));
    const outdoor = day.outdoor.map((o) => ({ t: Date.parse(o.at), v: o.temperature as number | null }));
    // Every 3 or 6 hours from the home's midnight, labelled in the home's time zone.
    const hoursEvery = plotW < 420 ? 6 : 3;
    const tz = this.data()?.timezone;
    const hourMarks: { x: number; label: string }[] = [];
    for (let ms = from; ms <= to + 1; ms += hoursEvery * 3_600_000) hourMarks.push({ x: x(Math.min(ms, to)), label: hourLabel(ms, tz) });
    return {
      bands: day.runs.map((r) => ({ x: x(Date.parse(r.from)), w: Math.max(1, x(Date.parse(r.to)) - x(Date.parse(r.from))), color: r.kind === 'heating' ? '#d95926' : '#3987e5' })),
      ticks: ticks.map((v) => ({ v, y: PAD.t + plotH - ((v - y0) / (y1 - y0)) * plotH, label: `${v}°` })),
      hours: hourMarks,
      inside: line(samples.map((s) => ({ t: s.t, v: s.temperature }))),
      target: line(target, true) + line(autoCool, true) + line(autoHeat, true),
      outdoor: line(outdoor, false, 2 * 3_600_000),
      x, y, from, to,
    };
  });

  /** The values at the pointer: the nearest sample, the outdoor temperature between hours, and whether it ran. */
  dayMove(ev: PointerEvent): void {
    const day = this.dayData();
    const box = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const px = ev.clientX - box.left;
    if (!day || px < PAD.l || px > this.width() - PAD.r) { this.dayHover.set(null); return; }
    const { from, to } = this.dayChart();
    const t = from + ((px - PAD.l) / (this.width() - PAD.l - PAD.r)) * (to - from);
    const near = day.samples.reduce<{ s: DayResponse['samples'][0] | null; d: number }>((best, s) => {
      const dd = Math.abs(Date.parse(s.at) - t);
      return dd < best.d ? { s, d: dd } : best;
    }, { s: null, d: Infinity });
    const s = near.d <= 15 * 60_000 ? near.s : null;
    const lines: string[] = [];
    if (s?.temperature != null) lines.push(`Inside ${this.deg(s.temperature)}`);
    if (s) {
      if (s.mode === 'heat' && s.heat !== null) lines.push(`Heat to ${this.deg(s.heat)}`);
      else if (s.mode === 'cool' && s.cool !== null) lines.push(`Cool to ${this.deg(s.cool)}`);
      else if (s.mode === 'auto' && s.heat !== null && s.cool !== null) lines.push(`Keeping ${this.deg(s.heat)}–${this.deg(s.cool)}`);
      else if (s.mode === 'off') lines.push('Off');
    }
    const o = day.outdoor;
    const i = o.findIndex((p) => Date.parse(p.at) > t);
    if (o.length) {
      const a = i <= 0 ? o[i === 0 ? 0 : o.length - 1] : o[i - 1], b = i <= 0 ? a : o[i];
      const ta = Date.parse(a.at), tb = Date.parse(b.at);
      const v = tb > ta ? a.temperature + ((t - ta) / (tb - ta)) * (b.temperature - a.temperature) : a.temperature;
      if (Math.abs(t - ta) < 2 * 3_600_000) lines.push(`Outside ${this.deg(v)}`);
    }
    const run = day.runs.find((r) => Date.parse(r.from) <= t && t < Date.parse(r.to));
    if (this.data()?.reportsRunning) lines.push(run ? (run.kind === 'heating' ? 'Heating' : 'Cooling') : 'Not running');
    if (!lines.length) lines.push('Not recorded');
    const time = new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: this.data()?.timezone });
    this.dayHover.set({ x: px, left: Math.min(Math.max(px + 10, 0), this.width() - 150), time, lines });
  }
}
