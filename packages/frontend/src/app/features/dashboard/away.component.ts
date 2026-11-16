import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Observable, of, switchMap } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { AutomationsService } from '../../core/services/automations.service';
import { shown, step, toC } from '../../shared/thermostat/thermostat.service';

interface Targets { heat: number | null; cool: number | null }
interface AwaySettings {
  thermostats: Record<string, Targets>;
  water: boolean; cameras: boolean; family: boolean;
  lights: number[];
  warmUpMinutes: number;
}
/** GET /api/away. Temperatures in °C. */
interface AwayView {
  active: boolean;
  since: string | null;
  until: string | null;
  endsAt: string | null;
  by: string | null;
  settings: AwaySettings;
  unit: 'F' | 'C';
  timezone: string;
  thermostats: { id: number; alias: string; away: Targets; allowed: { low: number; high: number }; set: boolean; heats: boolean; cools: boolean }[];
  has: { water: boolean; cameras: boolean; family: boolean };
  lamps: { id: number; alias: string; room: string | null }[];
}

const WARM_UP = [0, 30, 60, 90, 120, 180, 240];

/** "Sun, Nov 22, 6:00 PM" in the home's time zone. */
function when(iso: string, tz: string): string {
  return new Date(iso).toLocaleString('en-US', { timeZone: tz || undefined, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The wall clock in a time zone, as "2026-11-22T18:00" for a datetime-local input. */
export function wallClock(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/**
 * The moment a wall clock ("2026-11-22T18:00") shows in a time zone, so the day back is the
 * home's 6 PM even when the phone setting it is somewhere else. Null if it isn't a date.
 */
export function fromWallClock(value: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const wanted = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // The zone's offset at a moment: what its clock shows, read as UTC, minus the moment.
  const offset = (t: number) => {
    const [d, time] = wallClock(new Date(t), tz).split('T');
    const [y, mo, da] = d.split('-').map(Number);
    const [h, mi] = time.split(':').map(Number);
    return Date.UTC(y, mo - 1, da, h, mi) - t;
  };
  let t = wanted - offset(wanted);
  t = wanted - offset(t);   // once more, for a change of clocks in between
  return new Date(t);
}

/**
 * Away mode on Home: a small button when it's off, a banner while it's on. Starting it opens
 * what it will do: the day back, thermostats' away temperatures, water, cameras, check-ins,
 * and lived-in lights. Anyone signed in can start and end it; admins choose what it does.
 */
@Component({
  selector: 'app-away',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; margin-bottom: 1rem; }
    .off { display: flex; justify-content: flex-end; }
    .start-btn { background: transparent; border: 1px solid var(--border); color: var(--text-muted); font-size: 0.85rem; padding: 0.4rem 0.9rem; }
    .start-btn:hover { color: var(--text); background: var(--surface); }
    .banner { border: 1px solid #a78bfa; background: rgba(139, 92, 246, 0.12); }
    .banner-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem 1rem; }
    .banner h2 { font-size: 1.05rem; font-weight: 700; }
    .banner .what { font-size: 0.85rem; color: var(--text-muted); margin: 0.35rem 0 0; line-height: 1.45; }
    .banner .what strong { color: var(--text); font-weight: 600; }
    .banner-actions { display: flex; gap: 0.5rem; }
    .small { background: transparent; border: 1px solid var(--border); color: var(--text); font-size: 0.85rem; padding: 0.4rem 0.9rem; }
    .err { color: var(--red); font-size: 0.85rem; margin: 0.5rem 0 0; }

    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
    .dialog { width: 100%; max-width: 480px; max-height: 100%; overflow-y: auto; overscroll-behavior: contain; }
    .dialog h3 { font-size: 1.2rem; font-weight: 700; margin-bottom: 0.25rem; }
    .lead { font-size: 0.85rem; color: var(--text-muted); margin: 0 0 1rem; line-height: 1.45; }
    .section { border-top: 1px solid var(--border); padding: 0.85rem 0; }
    .section-title { font-size: 0.85rem; font-weight: 600; margin-bottom: 0.4rem; }
    .help { font-size: 0.78rem; color: var(--text-muted); margin: 0.3rem 0 0; line-height: 1.4; }
    input[type="datetime-local"], select { font-family: inherit; font-size: 1rem; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.55rem 0.8rem; width: 100%; }
    .check { display: flex; align-items: flex-start; gap: 0.55rem; font-size: 0.9rem; cursor: pointer; }
    .check input { margin-top: 0.2rem; width: 1.05rem; height: 1.05rem; flex-shrink: 0; }
    .check + .help { margin-left: 1.6rem; }
    .t-row { display: flex; align-items: center; flex-wrap: wrap; gap: 0.4rem 0.6rem; margin-top: 0.4rem; }
    .t-name { flex: 1 1 100%; font-size: 0.9rem; }
    .t-what { width: 4.3rem; font-size: 0.85rem; color: var(--text-muted); }
    .t-value { min-width: 2.8rem; text-align: center; font-weight: 600; font-size: 1.15rem; }
    .stepper { width: 2.4rem; height: 2.4rem; padding: 0; font-size: 1.2rem; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 50%; }
    .t-gap { width: 0.8rem; }
    .lamps { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.4rem; }
    .lamps button { background: var(--bg); border: 1px solid var(--border); color: var(--text); font-size: 0.82rem; padding: 0.35rem 0.75rem; border-radius: 999px; }
    .lamps button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
    .buttons { display: flex; gap: 0.75rem; margin-top: 1rem; }
    .cancel { flex: 1; background: transparent; border: 1px solid var(--border); color: var(--text-muted); }
    .go { flex: 2; }
  `],
  template: `
    @if (view(); as v) {
      @if (v.active) {
        <section class="card banner" aria-live="polite">
          <div class="banner-head">
            <h2>Away mode is on</h2>
            @if (canUse()) {
              <div class="banner-actions">
                <button class="small" type="button" (click)="open()">Change</button>
                <button class="btn-primary" type="button" [disabled]="busy()" (click)="end()">I'm back</button>
              </div>
            }
          </div>
          <p class="what">
            @if (v.until) {
              Back <strong>{{ at(v.until) }}</strong>.
              @if (v.endsAt && v.endsAt !== v.until) { Normal temperatures from {{ at(v.endsAt) }}, so it's comfortable when you arrive. }
            } @else {
              Until someone ends it.
            }
            @for (t of v.thermostats; track t.id) {
              {{ t.alias }}: {{ targetsText(t) }}{{ t.set ? '' : ' (when it connects)' }}.
            }
            @if (v.has.water && v.settings.water) { Any water use is treated as a leak. }
            @if (v.has.family && v.settings.family) { Check-ins and spoken reminders wait. }
            @if (v.settings.lights.length) { {{ v.settings.lights.length === 1 ? 'A lamp goes' : v.settings.lights.length + ' lamps go' }} on in the evenings. }
          </p>
          @if (error() && !dialog()) { <p class="err" role="alert">{{ error() }}</p> }
        </section>
      } @else if (canUse()) {
        <div class="off"><button class="start-btn" type="button" (click)="open()">✈ Away mode…</button></div>
      }
    }

    @if (dialog(); as d) {
      <div class="overlay" (click)="close()">
        <div class="card dialog" role="dialog" aria-modal="true" aria-labelledby="away-title" (click)="$event.stopPropagation()">
          <h3 id="away-title">{{ view()?.active ? 'Change Away mode' : 'Away mode' }}</h3>
          <p class="lead">For when everyone's out for a day or more. {{ isAdmin() ? '' : 'An administrator chooses what it does.' }}</p>

          <div class="section">
            <label class="check"><input type="checkbox" [ngModel]="d.knowsUntil" (ngModelChange)="patch({ knowsUntil: $event })" /> I know when we're back</label>
            @if (d.knowsUntil) {
              <input type="datetime-local" aria-label="Back on" [min]="minUntil" [ngModel]="d.until" (ngModelChange)="patch({ until: $event })" style="margin-top:0.5rem" />
              <p class="help">Your home's time{{ zoneNote() }}.</p>
              <label class="section-title" for="away-warm" style="display:block;margin-top:0.75rem">Back to normal</label>
              <select id="away-warm" [disabled]="!isAdmin()" [ngModel]="d.settings.warmUpMinutes" (ngModelChange)="patchSettings({ warmUpMinutes: +$event })">
                @for (m of warmUp; track m) { <option [ngValue]="m">{{ warmUpText(m) }}</option> }
              </select>
              <p class="help">Away mode ends by itself then, so the house is warm or cool when you arrive. Everyone with notifications on is told.</p>
            } @else {
              <p class="help">It stays on until someone ends it here.</p>
            }
          </div>

          @if (view()!.thermostats.length) {
            <div class="section">
              <div class="section-title">Thermostats</div>
              @for (t of view()!.thermostats; track t.id) {
                <div class="t-row">
                  <span class="t-name">{{ t.alias }}</span>
                  @for (k of keysOf(t); track k) {
                    <span class="t-what">{{ k === 'heat' ? 'Heat to' : 'Cool to' }}</span>
                    @if (isAdmin()) { <button class="stepper" type="button" (click)="nudge(t, k, -1)" [attr.aria-label]="'Lower away ' + (k === 'heat' ? 'heating' : 'cooling') + ' for ' + t.alias">−</button> }
                    <span class="t-value">{{ deg(target(t, k)) }}</span>
                    @if (isAdmin()) { <button class="stepper" type="button" (click)="nudge(t, k, 1)" [attr.aria-label]="'Raise away ' + (k === 'heat' ? 'heating' : 'cooling') + ' for ' + t.alias">+</button> }
                    <span class="t-gap"></span>
                  }
                </div>
              }
              <p class="help">Inside each one's allowed range. Its temperature schedule waits, then picks up again. Heating or cooling isn't turned on or off.</p>
            </div>
          }

          @if (view()!.has.water || view()!.has.cameras || view()!.has.family) {
            <div class="section">
              @if (view()!.has.water) {
                <label class="check"><input type="checkbox" [disabled]="!isAdmin()" [ngModel]="d.settings.water" (ngModelChange)="patchSettings({ water: $event })" /> Treat any water use as a leak</label>
                <p class="help">You're told at once, and a shutoff valve set up for the sensor closes. Turn this off if sprinklers, a water softener or an ice maker use water while you're away.</p>
              }
              @if (view()!.has.cameras) {
                <label class="check" style="margin-top:0.6rem"><input type="checkbox" [disabled]="!isAdmin()" [ngModel]="d.settings.cameras" (ngModelChange)="patchSettings({ cameras: $event })" /> Resume paused cameras</label>
              }
              @if (view()!.has.family) {
                <label class="check" style="margin-top:0.6rem"><input type="checkbox" [disabled]="!isAdmin()" [ngModel]="d.settings.family" (ngModelChange)="patchSettings({ family: $event })" /> Pause check-ins and spoken reminders</label>
                <p class="help">Days while away aren't checked, then or after you're back.</p>
              }
            </div>
          }

          @if (view()!.lamps.length) {
            <div class="section">
              <div class="section-title">Lived-in lights</div>
              <div class="lamps">
                @for (l of view()!.lamps; track l.id) {
                  <button type="button" [disabled]="!isAdmin()" [attr.aria-pressed]="d.settings.lights.includes(l.id)" (click)="toggleLamp(l.id)">{{ l.alias }}</button>
                }
              </div>
              <p class="help">Each one goes on 0–45 minutes after sunset and off between 10 and 11:30 PM, at different times each day.</p>
            </div>
          }

          @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
          <div class="buttons">
            <button class="cancel" type="button" (click)="close()">Cancel</button>
            <button class="btn-primary go" type="button" [disabled]="busy()" (click)="save()">{{ busy() ? 'Saving…' : (view()?.active ? 'Save' : 'Start Away mode') }}</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class AwayComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly automations = inject(AutomationsService);

  readonly view = signal<AwayView | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly dialog = signal<{ knowsUntil: boolean; until: string; settings: AwaySettings } | null>(null);
  readonly warmUp = WARM_UP;
  readonly keys = ['heat', 'cool'] as const;
  minUntil = '';

  /** Anyone signed in, except on a backup HomeHub. */
  readonly canUse = computed(() => !!this.auth.user() && !this.automations.readOnly());
  readonly isAdmin = computed(() => this.auth.user()?.role === 'admin');
  private timer?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    this.load();
    this.timer = setInterval(() => this.load(), 60_000);
  }
  ngOnDestroy(): void { if (this.timer) clearInterval(this.timer); }

  private load(): void {
    this.http.get<AwayView>('/api/away').subscribe({ next: (v) => this.view.set(v), error: () => undefined });
  }

  /** Says which zone when this device is in another one. */
  zoneNote(): string {
    const tz = this.view()?.timezone;
    if (!tz || tz === Intl.DateTimeFormat().resolvedOptions().timeZone) return '';
    return ` (${tz.split('/').pop()!.replace(/_/g, ' ')})`;
  }

  at(iso: string): string { return when(iso, this.view()?.timezone ?? ''); }
  deg(c: number | null): string { return c === null ? '–' : `${shown(c, this.view()?.unit ?? 'F')}°`; }
  targetsText(t: AwayView['thermostats'][number]): string {
    const a = t.away;
    return [t.heats && a.heat !== null ? `heat ${this.deg(a.heat)}` : null, t.cools && a.cool !== null ? `cool ${this.deg(a.cool)}` : null].filter(Boolean).join(', ');
  }
  keysOf(t: AwayView['thermostats'][number]): Array<'heat' | 'cool'> {
    return this.keys.filter((k) => (k === 'heat' ? t.heats : t.cools));
  }
  warmUpText(m: number): string {
    if (m === 0) return 'When we’re back';
    return m < 60 ? `${m} minutes before we’re back` : `${m / 60} ${m === 60 ? 'hour' : 'hours'} before we’re back`;
  }

  open(): void {
    const v = this.view();
    if (!v) return;
    this.error.set('');
    // In the home's time, wherever this phone is: 6 PM three days from now.
    const tz = v.timezone;
    this.minUntil = wallClock(new Date(), tz);
    const defaultBack = `${wallClock(new Date(Date.now() + 3 * 86_400_000), tz).slice(0, 10)}T18:00`;
    this.dialog.set({
      knowsUntil: v.active ? !!v.until : true,
      until: v.until ? wallClock(new Date(v.until), tz) : defaultBack,
      settings: structuredClone(v.settings),
    });
  }
  close(): void { this.dialog.set(null); this.error.set(''); }

  patch(change: Partial<{ knowsUntil: boolean; until: string }>): void {
    const d = this.dialog();
    if (d) this.dialog.set({ ...d, ...change });
  }
  patchSettings(change: Partial<AwaySettings>): void {
    const d = this.dialog();
    if (d) this.dialog.set({ ...d, settings: { ...d.settings, ...change } });
  }
  toggleLamp(id: number): void {
    const d = this.dialog();
    if (!d) return;
    const lights = d.settings.lights.includes(id) ? d.settings.lights.filter((x) => x !== id) : [...d.settings.lights, id];
    this.patchSettings({ lights });
  }

  target(t: AwayView['thermostats'][number], k: 'heat' | 'cool'): number | null {
    const saved = this.dialog()?.settings.thermostats[String(t.id)];
    return saved?.[k] ?? t.away[k];
  }

  nudge(t: AwayView['thermostats'][number], k: 'heat' | 'cool', dir: -1 | 1): void {
    const d = this.dialog();
    const u = this.view()?.unit ?? 'F';
    if (!d) return;
    const now = this.target(t, k) ?? (k === 'heat' ? t.allowed.low : t.allowed.high);
    const next = toC(shown(now, u) + dir * step(u), u);
    if (next < t.allowed.low - 0.01 || next > t.allowed.high + 0.01) {
      this.error.set(`${t.alias} is allowed ${this.deg(t.allowed.low)}–${this.deg(t.allowed.high)}. Change that in Settings → Devices.`);
      return;
    }
    this.error.set('');
    const pair = { heat: this.target(t, 'heat'), cool: this.target(t, 'cool'), [k]: next } as Targets;
    if (pair.heat !== null && pair.cool !== null && pair.cool - pair.heat < 1.5) {
      this.error.set('Away cooling must stay well above away heating.');
      return;
    }
    this.patchSettings({ thermostats: { ...d.settings.thermostats, [String(t.id)]: pair } });
  }

  save(): void {
    const d = this.dialog();
    const v = this.view();
    if (!d || !v) return;
    let until: string | null = null;
    if (d.knowsUntil) {
      const t = fromWallClock(d.until, v.timezone);
      if (!t) { this.error.set('Choose the day and time you’re back.'); return; }
      if (t.getTime() <= Date.now() + 5 * 60_000) { this.error.set('The day back must be later than now.'); return; }
      until = t.toISOString();
    }
    this.busy.set(true);
    this.error.set('');
    const settingsChanged = this.isAdmin() && JSON.stringify(d.settings) !== JSON.stringify(v.settings);
    const saveSettings: Observable<unknown> = settingsChanged ? this.http.put('/api/away/settings', d.settings) : of(null);
    saveSettings.pipe(switchMap(() => this.http.post<AwayView>('/api/away/start', { until }))).subscribe({
      next: (r) => { this.view.set(r); this.busy.set(false); this.dialog.set(null); },
      error: (e) => { this.busy.set(false); this.error.set(e?.error?.error ?? 'Away mode couldn’t be saved.'); },
    });
  }

  end(): void {
    this.busy.set(true);
    this.error.set('');
    this.http.post<AwayView>('/api/away/end', {}).subscribe({
      next: (r) => { this.view.set(r); this.busy.set(false); },
      error: (e) => { this.busy.set(false); this.error.set(e?.error?.error ?? 'Away mode couldn’t be ended.'); },
    });
  }
}
