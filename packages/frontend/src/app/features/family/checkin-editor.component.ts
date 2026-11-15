import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Subject, debounceTime, switchMap, catchError, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { WEEKDAYS, clockText, errorText, minutes, timeIn, type Checkin, type Family, type PreviewDay } from './family.types';

interface DeviceLite { id: number; alias: string; room: string | null; power?: { excluded: string | null } }

/**
 * Setting up a daily check-in: who it's for, when to check, and what counts as a sign they're
 * up. As it changes, the last two weeks show what it would have done, so the check time can be
 * set where it wouldn't have raised a false alarm.
 */
@Component({
  selector: 'app-checkin-editor',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .popup-card { max-width: 620px; }
    .sub { color: var(--text-muted); font-size: 0.85rem; margin: 0 0 1rem; line-height: 1.45; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
    .grid .wide { grid-column: 1 / -1; }
    fieldset { border: none; padding: 0; margin: 1rem 0 0; }
    legend { font-size: 0.75rem; font-weight: 600; color: var(--text-muted); margin-bottom: 0.4rem; }
    .days { display: flex; gap: 0.3rem; flex-wrap: wrap; }
    .day { min-width: 2.7rem; height: 2.2rem; padding: 0 0.5rem; border-radius: 999px; border: 1px solid var(--border); background: transparent; color: var(--text-muted); font-size: 0.85rem; }
    .day[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
    .checks { display: flex; flex-direction: column; gap: 0.5rem; }
    .check { display: flex; align-items: flex-start; gap: 0.55rem; font-size: 0.9rem; line-height: 1.35; }
    .check input { margin-top: 0.2rem; width: 1rem; height: 1rem; flex: none; }
    .check small { display: block; color: var(--text-muted); font-size: 0.78rem; }
    .pick { margin: 0.35rem 0 0 1.55rem; display: flex; flex-wrap: wrap; gap: 0.3rem 0.9rem; font-size: 0.85rem; }
    .pick label { display: inline-flex; align-items: center; gap: 0.35rem; white-space: nowrap; }
    .pick input { width: auto; flex: none; margin: 0; }
    .link { background: none; border: none; padding: 0; color: var(--accent); font-size: 0.8rem; }

    .preview { margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--border); }
    .preview h3 { font-size: 0.95rem; margin: 0 0 0.2rem; }
    .verdict { font-size: 0.88rem; margin: 0 0 0.75rem; line-height: 1.45; }
    .verdict.bad { color: #fca5a5; }
    .verdict.good { color: #86efac; }
    .rows { display: flex; flex-direction: column; gap: 3px; }
    .row { display: grid; grid-template-columns: 3.6rem 1fr 6.2rem; align-items: center; gap: 0.6rem; font-size: 0.8rem; min-height: 1.5rem; }
    .row .d { color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .track { position: relative; height: 0.5rem; border-radius: 999px; background: var(--bg); }
    .dot { position: absolute; top: 50%; width: 0.75rem; height: 0.75rem; margin: -0.375rem 0 0 -0.375rem; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--surface); }
    .row.alert .track { background: rgba(239, 68, 68, 0.28); }
    .row.off .track { background: repeating-linear-gradient(45deg, transparent 0 4px, rgba(203,213,225,0.18) 4px 6px); }
    .t { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .row.alert .t { color: #fca5a5; font-weight: 600; }
    .row.off .t { color: var(--text-muted); }
    .scale { display: grid; grid-template-columns: 3.6rem 1fr 6.2rem; gap: 0.6rem; font-size: 0.72rem; color: var(--text-muted); margin-top: 0.25rem; }
    .scale span:nth-child(2) { display: flex; justify-content: space-between; }
    .muted { color: var(--text-muted); font-size: 0.8rem; }
    .err { color: var(--red); font-size: 0.85rem; margin: 0.5rem 0 0; }
    .danger { margin-left: auto; color: #fca5a5; background: transparent; border: 1px solid transparent; }
    @media (max-width: 599px) {
      .grid { grid-template-columns: 1fr 1fr; }
      .row, .scale { grid-template-columns: 3.1rem 1fr 4.9rem; gap: 0.45rem; }
    }
  `],
  template: `
    <div class="popup-overlay" (click)="closed.emit()">
      <div class="card popup-card" role="dialog" aria-modal="true" aria-labelledby="ci-title" (click)="$event.stopPropagation()">
        <div class="form-head">
          <h2 id="ci-title">{{ existing() ? 'Edit daily check-in' : 'Daily check-in' }}</h2>
          <button type="button" class="close" (click)="closed.emit()" aria-label="Close">✕</button>
        </div>
        <p class="sub">For someone who lives alone. If nothing at home shows they’re up and about by the check time, everyone with HomeHub alerts is told, and told again when HomeHub sees activity.</p>

        <form (submit)="$event.preventDefault(); save()">
          <div class="grid">
            <label class="f wide">Who is it for?
              <input [(ngModel)]="name" name="name" maxlength="60" placeholder="e.g. Mom, 亞娘" required />
            </label>
            <label class="f">Start looking at
              <input type="time" [(ngModel)]="from" name="from" (ngModelChange)="changed()" required />
            </label>
            <label class="f">Check by
              <input type="time" [(ngModel)]="by" name="by" (ngModelChange)="changed()" required />
            </label>
          </div>

          <fieldset>
            <legend>Days</legend>
            <div class="days">
              @for (d of order; track d) {
                <button type="button" class="day" [attr.aria-pressed]="days().includes(d)" (click)="toggleDay(d)">{{ weekdays[d] }}</button>
              }
            </div>
          </fieldset>

          <fieldset>
            <legend>What shows they’re up</legend>
            <div class="checks">
              <label class="check">
                <input type="checkbox" [(ngModel)]="useDevices" name="useDevices" (ngModelChange)="changed()" />
                <span>Lights and plugs switched by a person
                  <small>At the wall switch, by voice, or in an app. Not schedules or timers.</small></span>
              </label>
              @if (useDevices) {
                <div class="pick">
                  @if (pickDevices()) {
                    @for (d of switchable(); track d.id) {
                      <label><input type="checkbox" [checked]="devices().includes(d.id)" (change)="toggleDevice(d.id)" />{{ d.alias }}</label>
                    }
                    <button type="button" class="link" (click)="pickDevices.set(false); changed()">Count all of them</button>
                  } @else {
                    <span class="muted">All {{ switchable().length }} devices</span>
                    <button type="button" class="link" (click)="startPicking()">Choose which</button>
                  }
                </div>
              }
              @if (data().users.length > 1) {
                <div class="pick">
                  <span class="muted">App use counts by:</span>
                  @for (u of data().users; track u) {
                    <label><input type="checkbox" [checked]="appUsers().includes(u)" (change)="toggleUser(u)" />{{ u }}</label>
                  }
                </div>
              }
              <label class="check">
                <input type="checkbox" [(ngModel)]="voice" name="voice" (ngModelChange)="changed()" />
                <span>Voice commands
                  <small>Only ones HomeHub understood: a TV can wake the speaker too.</small></span>
              </label>
              @if (data().hasFlowSensor) {
                <label class="check">
                  <input type="checkbox" [(ngModel)]="water" name="water" (ngModelChange)="changed()" />
                  <span>Water used
                    <small>From the water sensor: a tap, the toilet, the kettle.</small></span>
                </label>
              }
              @if (data().motionRules.length) {
                <div>
                  <span class="check" style="margin-bottom:0.2rem">Motion sensors</span>
                  <div class="pick" style="margin-top:0">
                    @for (r of data().motionRules; track r.id) {
                      <label><input type="checkbox" [checked]="motion().includes(r.id)" (change)="toggleMotion(r.id)" />{{ r.name }}{{ r.ring && !r.name.includes('Ring') ? ' (Ring camera)' : '' }}</label>
                    }
                  </div>
                </div>
              }
            </div>
          </fieldset>

          <section class="preview" aria-live="polite">
            <h3>The last two weeks</h3>
            @if (preview(); as p) {
              <p class="verdict" [class.bad]="alertDays().length > 0" [class.good]="alertDays().length === 0">{{ verdict() }}</p>
              <div class="rows" role="list">
                @for (d of p; track d.day) {
                  <div class="row" role="listitem" [class.alert]="d.alert" [class.off]="d.homehubOff" [attr.aria-label]="rowLabel(d)" [attr.title]="d.first?.what ?? ''">
                    <span class="d">{{ dayLabel(d) }}</span>
                    <span class="track">
                      @if (d.first) { <span class="dot" [style.left.%]="position(d)"></span> }
                    </span>
                    <span class="t">{{ d.first ? time(d.first.at) : d.homehubOff ? 'HomeHub off' : !checked(d) ? '—' : 'No activity' }}</span>
                  </div>
                }
              </div>
              <div class="scale" aria-hidden="true"><span></span><span><span>{{ clock(from) }}</span><span>{{ clock(by) }}</span></span><span></span></div>
            } @else if (previewError()) {
              <p class="err">{{ previewError() }}</p>
            } @else {
              <p class="muted">Looking back…</p>
            }
          </section>

          @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
          <div class="form-foot">
            <button type="submit" class="btn-primary" [disabled]="saving() || !name.trim()">{{ existing() ? 'Save' : 'Turn on check-in' }}</button>
            <button type="button" class="btn-ghost" (click)="closed.emit()">Cancel</button>
            @if (existing()) {
              @if (confirmDelete()) {
                <button type="button" class="danger" (click)="remove()">Yes, delete it</button>
              } @else {
                <button type="button" class="danger" (click)="confirmDelete.set(true)">Delete</button>
              }
            }
          </div>
        </form>
      </div>
    </div>
  `,
})
export class CheckinEditorComponent implements OnInit {
  readonly data = input.required<Family>();
  readonly existing = input<Checkin | null>(null);
  readonly devicesList = input<DeviceLite[]>([]);
  readonly saved = output<void>();
  readonly closed = output<void>();
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);

  readonly weekdays = WEEKDAYS;
  readonly order = [1, 2, 3, 4, 5, 6, 0];
  readonly clock = clockText;

  name = '';
  from = '05:00';
  by = '11:00';
  useDevices = true;
  voice = true;
  water = true;
  readonly days = signal<number[]>([0, 1, 2, 3, 4, 5, 6]);
  readonly devices = signal<number[]>([]);
  readonly pickDevices = signal(false);
  readonly appUsers = signal<string[]>([]);
  readonly motion = signal<number[]>([]);

  readonly preview = signal<PreviewDay[] | null>(null);
  readonly previewError = signal('');
  readonly saving = signal(false);
  readonly error = signal('');
  readonly confirmDelete = signal(false);
  private readonly ask = new Subject<void>();

  /** Things a person switches: cameras, valves and the like aren't signs anyone's up. */
  readonly switchable = computed(() => this.devicesList().filter((d) => !d.power?.excluded || d.power.excluded === 'garage door'));
  readonly alertDays = computed(() => (this.preview() ?? []).filter((d) => d.alert));

  ngOnInit(): void {
    const c = this.existing();
    const users = this.data().users;
    this.appUsers.set(users);
    this.motion.set(this.data().motionRules.filter((r) => !r.ring).map((r) => r.id));
    if (c) {
      this.name = c.name; this.from = c.from; this.by = c.by; this.days.set(c.days);
      this.voice = c.voice; this.water = c.water;
      this.useDevices = !(c.devices && c.devices.length === 0);
      if (c.devices?.length) { this.devices.set(c.devices); this.pickDevices.set(true); }
      if (c.appUsers) this.appUsers.set(c.appUsers);
      if (c.motion) this.motion.set(c.motion);
    }
    this.ask.pipe(
      debounceTime(350),
      switchMap(() => this.http.post<{ days: PreviewDay[] }>('/api/family/checkins/preview', { ...this.settings(), days: this.days() }).pipe(
        catchError((e) => { this.previewError.set(errorText(e, 'The last two weeks couldn’t be looked at.')); return of(null); }),
      )),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((r) => { if (r) { this.preview.set(r.days); this.previewError.set(''); } else this.preview.set(null); });
    this.changed();
  }

  changed(): void {
    if (!this.from || !this.by) return;
    if (this.from >= this.by) { this.preview.set(null); this.previewError.set('The check time needs to be after the time it starts looking.'); return; }
    this.ask.next();
  }

  private settings() {
    const allRules = this.data().motionRules;
    const defaultRules = allRules.filter((r) => !r.ring).map((r) => r.id);
    const sameRules = [...this.motion()].sort().join() === [...defaultRules].sort().join();
    const allUsers = this.appUsers().length === this.data().users.length;
    return {
      from: this.from, by: this.by,
      // No devices at all is an empty list; all of them, null, so new ones count too.
      devices: !this.useDevices ? [] : this.pickDevices() ? this.devices() : null,
      motion: sameRules ? null : this.motion(),
      appUsers: allUsers ? null : this.appUsers(),
      voice: this.voice, water: this.water,
    };
  }

  toggleDay(d: number): void {
    const has = this.days().includes(d);
    if (has && this.days().length === 1) return;
    this.days.set(has ? this.days().filter((x) => x !== d) : [...this.days(), d]);
    this.changed();
  }
  startPicking(): void { this.devices.set(this.switchable().map((d) => d.id)); this.pickDevices.set(true); this.changed(); }
  toggleDevice(id: number): void { this.devices.set(this.devices().includes(id) ? this.devices().filter((x) => x !== id) : [...this.devices(), id]); this.changed(); }
  toggleUser(u: string): void { this.appUsers.set(this.appUsers().includes(u) ? this.appUsers().filter((x) => x !== u) : [...this.appUsers(), u]); this.changed(); }
  toggleMotion(id: number): void { this.motion.set(this.motion().includes(id) ? this.motion().filter((x) => x !== id) : [...this.motion(), id]); this.changed(); }

  time(iso: string): string { return timeIn(iso, this.data().timezone); }
  checked(d: PreviewDay): boolean { return this.days().includes(d.weekday); }
  dayLabel(d: PreviewDay): string { return `${WEEKDAYS[d.weekday]} ${Number(d.day.slice(8))}`; }

  /** Where the first sign falls between the start and the check time, as a percentage. */
  position(d: PreviewDay): number {
    if (!d.first) return 0;
    const t = new Date(d.first.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: this.data().timezone });
    const span = minutes(this.by) - minutes(this.from);
    return Math.max(0, Math.min(100, ((minutes(t) - minutes(this.from)) / span) * 100));
  }

  rowLabel(d: PreviewDay): string {
    const day = new Date(`${d.day}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    if (d.first) return `${day}: first activity at ${this.time(d.first.at)}, ${d.first.what}`;
    if (d.homehubOff) return `${day}: HomeHub was off`;
    return `${day}: no activity${d.alert ? ', would have alerted' : ''}`;
  }

  readonly verdict = computed(() => {
    const p = this.preview() ?? [];
    const bad = this.alertDays();
    if (!p.length) return '';
    if (!bad.length) return `It wouldn’t have raised an alarm on any of the last ${p.length} days.`;
    const names = bad.map((d) => new Date(`${d.day}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })).join(', ');
    return `It would have alerted on ${bad.length} of the last ${p.length} days (${names}). If someone was home those days, a later check time would avoid false alarms.`;
  });

  save(): void {
    this.saving.set(true);
    this.error.set('');
    const body = { name: this.name.trim(), days: this.days(), ...this.settings() };
    const c = this.existing();
    const req = c ? this.http.put(`/api/family/checkins/${c.id}`, body) : this.http.post('/api/family/checkins', body);
    req.subscribe({
      next: () => { this.saving.set(false); this.saved.emit(); },
      error: (e) => { this.saving.set(false); this.error.set(errorText(e, 'The check-in couldn’t be saved.')); },
    });
  }

  remove(): void {
    const c = this.existing();
    if (!c) return;
    this.http.delete(`/api/family/checkins/${c.id}`).subscribe({
      next: () => this.saved.emit(),
      error: (e) => this.error.set(errorText(e, 'The check-in couldn’t be deleted.')),
    });
  }
}
