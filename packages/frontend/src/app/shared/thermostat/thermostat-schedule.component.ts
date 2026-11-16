import { ChangeDetectionStrategy, Component, ElementRef, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ThermostatService, shown, step, toC, type SchedulePoint, type ThermostatView } from './thermostat.service';
import {
  EVERY_DAY, WEEKDAYS, WEEKENDS, WEEK_ORDER, describeDays, describeNext, describeTargets, describeWhen, pointOrder,
} from './schedule-text';

const DAY_LETTERS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Form {
  days: number[];
  when: 'time' | 'sunrise' | 'sunset';
  time: string;
  offset: number;
  offsetDir: 'before' | 'after';
  heat: number | null;
  cool: number | null;
  enabled: boolean;
}

/**
 * A thermostat's weekly temperature schedule, on the Schedules page: each change sets the
 * heating and cooling targets on some days, at a time or at sunrise or sunset. It never
 * changes the mode. Saved as a whole list; the server checks it against the allowed range.
 */
@Component({
  selector: 'app-thermostat-schedule',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
    h2 { flex: 1; min-width: 0; font-size: 1.05rem; font-weight: 700; overflow-wrap: anywhere; }
    .kind { font-weight: 500; color: var(--text-muted); font-size: 0.85rem; margin-left: 0.35rem; }
    .add { background: transparent; border: 1px solid var(--border); color: var(--accent); padding: 0.3rem 0.8rem; font-size: 0.8rem; flex-shrink: 0; }
    .add:hover { background: var(--surface); }
    .next { font-size: 0.85rem; color: var(--text-muted); margin: 0.4rem 0 0; }
    .next strong { color: var(--text); font-weight: 600; }
    .intro { font-size: 0.85rem; color: var(--text-muted); margin: 0.6rem 0 0; line-height: 1.45; }
    .start { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
    .suggest { font-size: 0.8rem; color: var(--text-muted); margin: 0.5rem 0 0; line-height: 1.45; }
    .row { display: flex; align-items: center; flex-wrap: wrap; gap: 0.4rem 1rem; margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--border); }
    .row.off .info { opacity: 0.55; }
    .info { flex: 1 1 13rem; min-width: 0; }
    .when { font-weight: 600; overflow-wrap: anywhere; }
    .targets { font-size: 0.85rem; margin-top: 0.15rem; }
    .targets .heat { color: #fb923c; }
    .targets .cool { color: #60a5fa; }
    .hint { font-size: 0.78rem; color: var(--text-muted); margin-top: 0.15rem; }
    .actions { display: flex; align-items: center; gap: 0.5rem; margin-left: auto; }
    .toggle { background: transparent; border: 1px solid var(--border); color: var(--text-muted); padding: 0.3rem 0.8rem; font-size: 0.8rem; }
    .toggle.active { border-color: var(--green); color: var(--green); }
    .icon { background: transparent; border: none; color: var(--text-muted); padding: 0.3rem 0.5rem; font-size: 1rem; }
    .icon:hover { color: var(--accent); }
    .icon.del:hover { color: var(--red); }
    .err { color: var(--red); font-size: 0.85rem; margin: 0.5rem 0 0; }

    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
    .form { width: 100%; max-width: 440px; max-height: 100%; overflow-y: auto; overscroll-behavior: contain; }
    .form h3 { font-size: 1.15rem; font-weight: 700; margin-bottom: 1rem; }
    .field { margin-bottom: 1rem; }
    .label { display: block; font-size: 0.82rem; font-weight: 500; color: var(--text-muted); margin-bottom: 0.35rem; }
    .days { display: flex; gap: 0.3rem; flex-wrap: wrap; }
    .days button { width: 2.6rem; height: 2.4rem; padding: 0; background: var(--bg); border: 1px solid var(--border); color: var(--text); font-size: 0.85rem; }
    .days button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
    .quick { display: flex; gap: 0.9rem; margin-top: 0.4rem; }
    .quick button { background: none; border: none; padding: 0.1rem 0; color: var(--accent); font-size: 0.8rem; }
    select, input[type="time"], input[type="number"] { font-family: inherit; font-size: 1rem; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.55rem 0.8rem; }
    select { width: 100%; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; margin-top: 0.5rem; }
    .two input { width: 100%; }
    .target { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.5rem; }
    .target .what { width: 4.5rem; font-size: 0.9rem; }
    .target .value { min-width: 3.2rem; text-align: center; font-size: 1.35rem; font-weight: 600; }
    .stepper { width: 2.6rem; height: 2.6rem; padding: 0; font-size: 1.3rem; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 50%; }
    .help { font-size: 0.78rem; color: var(--text-muted); margin: 0.2rem 0 0; line-height: 1.4; }
    .warn { color: #fbbf24; }
    .buttons { display: flex; gap: 0.75rem; margin-top: 1.25rem; }
    .cancel { flex: 1; background: transparent; border: 1px solid var(--border); color: var(--text-muted); }
    .save { flex: 2; }
  `],
  template: `
    <section class="card" [attr.id]="'thermostat-' + deviceId()">
      <div class="head">
        <h2>{{ alias() }}<span class="kind">Temperatures</span></h2>
        @if (canEdit() && points().length) { <button class="add" type="button" (click)="openNew()">+ Add</button> }
      </div>

      @if (nextText(); as n) { <p class="next">Next: <strong>{{ n.targets }}</strong> at {{ n.when }}</p> }

      @if (loaded() && !points().length) {
        <p class="intro">
          Set the heating and cooling targets for times of day, such as cooler at night. A change made on the
          thermostat or its card holds until the next one here. A schedule only changes the targets: it never
          turns heating or cooling on or off.
        </p>
        @if (canEdit()) {
          <div class="start">
            @if (suggestion(); as s) { <button class="btn-primary" type="button" [disabled]="saving()" (click)="useSuggestion()">Use a suggested schedule</button> }
            <button class="add" type="button" (click)="openNew()">+ Add a change</button>
          </div>
          @if (suggestion(); as s) { <p class="suggest">{{ s.text }}</p> }
        }
      }

      @for (p of sorted(); track p.id) {
        <div class="row" [class.off]="!p.enabled">
          <div class="info">
            <div class="when">{{ days(p.days) }} · {{ when(p) }}</div>
            <div class="targets">
              @if (p.heat !== null) { <span class="heat">Heat {{ deg(p.heat) }}</span> }
              @if (p.heat !== null && p.cool !== null) { · }
              @if (p.cool !== null) { <span class="cool">Cool {{ deg(p.cool) }}</span> }
            </div>
            @if (outsideComfort(p)) { <div class="hint">Outside your comfortable {{ comfortText() }}: fine for nights and time away</div> }
          </div>
          @if (canEdit()) {
            <div class="actions">
              <button class="toggle" type="button" [class.active]="p.enabled" [disabled]="saving()" (click)="toggle(p)">{{ p.enabled ? 'Enabled' : 'Disabled' }}</button>
              <button class="icon" type="button" title="Edit" [attr.aria-label]="'Edit ' + days(p.days) + ' ' + when(p)" (click)="openEdit(p)">✎</button>
              <button class="icon del" type="button" title="Delete" [attr.aria-label]="'Delete ' + days(p.days) + ' ' + when(p)" [disabled]="saving()" (click)="remove(p)">✕</button>
            </div>
          }
        </div>
      }
      @if (error() && !form()) { <p class="err" role="alert">{{ error() }}</p> }
    </section>

    @if (form(); as f) {
      <div class="overlay" (click)="close()">
        <div class="card form" role="dialog" aria-modal="true" [attr.aria-label]="(editing() === null ? 'New change for ' : 'Edit change for ') + alias()" (click)="$event.stopPropagation()">
          <h3>{{ editing() === null ? 'New change' : 'Edit change' }} · {{ alias() }}</h3>

          <div class="field">
            <span class="label" id="days-label">Days</span>
            <div class="days" role="group" aria-labelledby="days-label">
              @for (d of week; track d) {
                <button type="button" [attr.aria-pressed]="f.days.includes(d)" [attr.aria-label]="dayName(d)" (click)="toggleDay(d)">{{ letter(d) }}</button>
              }
            </div>
            <div class="quick">
              <button type="button" (click)="setDays(everyDay)">Every day</button>
              <button type="button" (click)="setDays(weekdays)">Weekdays</button>
              <button type="button" (click)="setDays(weekends)">Weekends</button>
            </div>
          </div>

          <div class="field">
            <label class="label" for="ts-when">When</label>
            <select id="ts-when" [ngModel]="f.when" (ngModelChange)="patch({ when: $event })">
              <option value="time">At a time</option>
              <option value="sunrise">Sunrise</option>
              <option value="sunset">Sunset</option>
            </select>
            @if (f.when === 'time') {
              <div class="two">
                <input type="time" aria-label="Time" [ngModel]="f.time" (ngModelChange)="patch({ time: $event })" />
              </div>
            } @else {
              <div class="two">
                <input type="number" min="0" max="180" aria-label="Minutes" [ngModel]="f.offset" (ngModelChange)="patch({ offset: $event })" />
                <select aria-label="Before or after" [ngModel]="f.offsetDir" (ngModelChange)="patch({ offsetDir: $event })">
                  <option value="before">min before</option>
                  <option value="after">min after</option>
                </select>
              </div>
            }
            <p class="help">Times are your home's, from Settings → Home.</p>
          </div>

          <div class="field">
            <span class="label">Targets</span>
            @for (key of keys(); track key) {
              <div class="target">
                <span class="what">{{ key === 'heat' ? 'Heat to' : 'Cool to' }}</span>
                <button class="stepper" type="button" (click)="nudge(key, -1)" [attr.aria-label]="'Lower ' + (key === 'heat' ? 'heating' : 'cooling') + ' target'">−</button>
                <span class="value" aria-live="polite">{{ f[key] === null ? '–' : deg(f[key]!) }}</span>
                <button class="stepper" type="button" (click)="nudge(key, 1)" [attr.aria-label]="'Raise ' + (key === 'heat' ? 'heating' : 'cooling') + ' target'">+</button>
              </div>
            }
            <p class="help">Allowed {{ allowedText() }}, from Settings → Devices.
              @if (formOutsideComfort()) { <span class="warn">Outside your comfortable {{ comfortText() }}, which is fine for nights and time away.</span> }
            </p>
          </div>

          @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
          <div class="buttons">
            <button class="cancel" type="button" (click)="close()">Cancel</button>
            <button class="btn-primary save" type="button" [disabled]="saving() || !f.days.length" (click)="saveForm()">{{ saving() ? 'Saving…' : 'Save' }}</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class ThermostatScheduleComponent implements OnInit {
  readonly deviceId = input.required<number>();
  readonly canEdit = input(false);
  /** Scroll here once loaded, for a link from the thermostat's card. */
  readonly focus = input(false);

  private readonly svc = inject(ThermostatService);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly week = WEEK_ORDER;
  readonly everyDay = EVERY_DAY;
  readonly weekdays = WEEKDAYS;
  readonly weekends = WEEKENDS;

  readonly points = signal<SchedulePoint[]>([]);
  readonly next = signal<{ at: string; heat: number | null; cool: number | null } | null>(null);
  readonly timezone = signal('');
  readonly loaded = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly form = signal<Form | null>(null);
  /** The id of the change being edited, or null for a new one. */
  readonly editing = signal<number | null>(null);

  readonly view = computed<ThermostatView | undefined>(() => this.svc.views().get(this.deviceId()));
  readonly unit = computed<'F' | 'C'>(() => this.view()?.unit ?? 'F');
  readonly alias = computed(() => this.view()?.alias ?? 'Thermostat');
  readonly sorted = computed(() => [...this.points()].sort((a, b) => pointOrder(a) - pointOrder(b) || (a.id ?? 0) - (b.id ?? 0)));

  /** Which targets it has: both when it hasn't said yet. */
  readonly keys = computed<Array<'heat' | 'cool'>>(() => {
    const t = this.view();
    if (!t || (t.heatLimits === null && t.coolLimits === null)) return ['heat', 'cool'];
    return (['heat', 'cool'] as const).filter((k) => (k === 'heat' ? t.heatLimits : t.coolLimits) !== null);
  });

  readonly nextText = computed(() => {
    const n = this.next();
    return n ? { targets: describeTargets(n, this.unit()), when: describeNext(n.at, this.timezone()) } : null;
  });

  /** Warm days and a 7 °F (4 °C) setback at night, inside the comfortable and allowed ranges. Only for a thermostat that heats. */
  readonly suggestion = computed<{ points: SchedulePoint[]; text: string } | null>(() => {
    const t = this.view();
    if (!t || !this.keys().includes('heat')) return null;
    const u = t.unit;
    const day = t.comfort.low;
    const night = Math.max(t.allowed.low, toC(shown(day, u) - (u === 'F' ? 7 : 4), u));
    if (night >= day - 0.01) return null;
    const hasCool = this.keys().includes('cool');
    const cool = hasCool ? Math.max(t.comfort.high, day + t.deadband) : null;
    const point = (time: string, heat: number): SchedulePoint => ({ days: EVERY_DAY, time, sun: null, heat, cool, enabled: true });
    return {
      points: [point('06:30', day), point('22:30', night)],
      text: `Every day: heat to ${shown(day, u)}° from 6:30 AM and ${shown(night, u)}° from 10:30 PM${hasCool ? `, cool to ${shown(cool!, u)}°` : ''}. ` +
        `Lowering the heat 7–10 °F for 8 hours a day saves up to about 10% a year (U.S. Department of Energy). You can change it afterwards.`,
    };
  });

  ngOnInit(): void {
    this.svc.watch(this.deviceId());
    this.load();
  }

  private load(): void {
    this.svc.schedule(this.deviceId()).subscribe({
      next: (v) => {
        this.apply(v);
        if (this.focus()) setTimeout(() => this.host.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      },
      error: (e) => { this.loaded.set(true); this.error.set(e?.error?.error ?? 'The schedule couldn’t be loaded.'); },
    });
  }

  private apply(v: { points: SchedulePoint[]; next: { at: string; heat: number | null; cool: number | null } | null; timezone: string }): void {
    this.points.set(v.points);
    this.next.set(v.next);
    this.timezone.set(v.timezone);
    this.loaded.set(true);
  }

  days(d: number[]): string { return describeDays(d); }
  when(p: SchedulePoint): string { return describeWhen(p); }
  letter(d: number): string { return DAY_LETTERS[d]; }
  dayName(d: number): string { return DAY_NAMES[d]; }
  deg(c: number): string { return `${shown(c, this.unit())}°`; }

  comfortText(): string {
    const t = this.view();
    return t ? `${this.deg(t.comfort.low)}–${this.deg(t.comfort.high)}` : '';
  }
  allowedText(): string {
    const t = this.view();
    return t ? `${this.deg(t.allowed.low)}–${this.deg(t.allowed.high)}` : '';
  }

  private outside(heat: number | null, cool: number | null): boolean {
    const t = this.view();
    if (!t) return false;
    return (heat !== null && heat < t.comfort.low - 0.01) || (cool !== null && cool > t.comfort.high + 0.01);
  }
  outsideComfort(p: SchedulePoint): boolean { return this.outside(p.heat, p.cool); }
  formOutsideComfort(): boolean {
    const f = this.form();
    return !!f && this.outside(this.keys().includes('heat') ? f.heat : null, this.keys().includes('cool') ? f.cool : null);
  }

  // ── The form ──

  openNew(): void {
    const t = this.view();
    const keys = this.keys();
    const heat = keys.includes('heat') ? (t?.comfort.low ?? 20) : null;
    let cool = keys.includes('cool') ? (t?.comfort.high ?? 24.5) : null;
    if (heat !== null && cool !== null && t && cool - heat < t.deadband) cool = heat + t.deadband;
    this.error.set('');
    this.editing.set(null);
    this.form.set({ days: [...EVERY_DAY], when: 'time', time: '06:30', offset: 0, offsetDir: 'before', heat, cool, enabled: true });
  }

  openEdit(p: SchedulePoint): void {
    const keys = this.keys();
    const t = this.view();
    this.error.set('');
    this.editing.set(p.id ?? null);
    this.form.set({
      days: [...p.days],
      when: p.time ? 'time' : p.sun!.event,
      time: p.time ?? '06:30',
      offset: Math.abs(p.sun?.offset ?? 0),
      offsetDir: (p.sun?.offset ?? 0) > 0 ? 'after' : 'before',
      // A target it has but this change leaves alone starts from the comfortable range.
      heat: p.heat ?? (keys.includes('heat') ? (t?.comfort.low ?? 20) : null),
      cool: p.cool ?? (keys.includes('cool') ? (t?.comfort.high ?? 24.5) : null),
      enabled: p.enabled,
    });
  }

  close(): void { this.form.set(null); this.error.set(''); }

  patch(change: Partial<Form>): void {
    const f = this.form();
    if (f) this.form.set({ ...f, ...change });
  }

  toggleDay(d: number): void {
    const f = this.form();
    if (!f) return;
    this.patch({ days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d] });
  }
  setDays(days: number[]): void { this.patch({ days: [...days] }); }

  /** One step, within the allowed range; heating and cooling keep the thermostat's gap. */
  nudge(key: 'heat' | 'cool', dir: -1 | 1): void {
    const f = this.form();
    const t = this.view();
    if (!f || !t) return;
    const u = t.unit;
    const now = f[key] ?? (key === 'heat' ? t.comfort.low : t.comfort.high);
    const next = toC(shown(now, u) + dir * step(u), u);
    if (next < t.allowed.low - 0.01 || next > t.allowed.high + 0.01) {
      this.error.set(`Schedules keep to the allowed ${this.allowedText()}. Change it in Settings → Devices.`);
      return;
    }
    this.error.set('');
    const p: Partial<Form> = { [key]: next };
    const heat = key === 'heat' ? next : f.heat, cool = key === 'cool' ? next : f.cool;
    if (heat !== null && cool !== null && this.keys().length === 2 && cool - heat < t.deadband) {
      if (key === 'heat') p.cool = heat + t.deadband; else p.heat = cool - t.deadband;
      const moved = key === 'heat' ? p.cool! : p.heat!;
      if (moved < t.allowed.low - 0.01 || moved > t.allowed.high + 0.01) {
        this.error.set(`Cooling must stay at least ${u === 'F' ? Math.round(t.deadband * 9 / 5) + '°F' : t.deadband + '°C'} above heating.`);
        return;
      }
    }
    this.patch(p);
  }

  saveForm(): void {
    const f = this.form();
    if (!f) return;
    if (f.when === 'time' && !/^\d\d:\d\d$/.test(f.time ?? '')) { this.error.set('Choose a time.'); return; }
    const minutes = Math.round(Number(f.offset) || 0);
    if (f.when !== 'time' && (minutes < 0 || minutes > 180)) { this.error.set('Minutes before or after can be up to 180.'); return; }
    const keys = this.keys();
    const point: SchedulePoint = {
      days: [...f.days].sort(),
      time: f.when === 'time' ? f.time : null,
      sun: f.when === 'time' ? null : { event: f.when, offset: f.offsetDir === 'before' ? -minutes : minutes },
      heat: keys.includes('heat') ? f.heat : null,
      cool: keys.includes('cool') ? f.cool : null,
      enabled: f.enabled,
    };
    const id = this.editing();
    const list = id === null ? [...this.points(), point] : this.points().map((p) => (p.id === id ? point : p));
    this.save(list, () => this.form.set(null));
  }

  toggle(p: SchedulePoint): void {
    this.save(this.points().map((x) => (x.id === p.id ? { ...x, enabled: !x.enabled } : x)));
  }

  remove(p: SchedulePoint): void {
    if (!confirm(`Delete "${describeDays(p.days)} · ${describeWhen(p)}"?`)) return;
    this.save(this.points().filter((x) => x.id !== p.id));
  }

  useSuggestion(): void {
    const s = this.suggestion();
    if (s) this.save(s.points);
  }

  private save(points: SchedulePoint[], done?: () => void): void {
    this.saving.set(true);
    this.error.set('');
    this.svc.saveSchedule(this.deviceId(), points).subscribe({
      next: (v) => { this.apply(v); this.saving.set(false); done?.(); },
      error: (e) => { this.saving.set(false); this.error.set(e?.error?.error ?? 'The schedule couldn’t be saved.'); },
    });
  }
}
