import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { PushService } from '../../core/services/push.service';
import { CheckinEditorComponent } from './checkin-editor.component';
import { RemindersComponent } from './reminders.component';
import { HelpButtonComponent } from './help-button.component';
import { SosAlertComponent } from './sos-alert.component';
import { SosSettingsComponent } from './sos-settings.component';
import { clockText, daysText, errorText, howText, timeIn, todayIn, type Checkin, type Family, type SosAlert } from './family.types';

/** "A", "A and B", "A, B and C". */
const listText = (names: string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

interface DeviceLite { id: number; alias: string; room: string | null; power?: { excluded: string | null } }
type Tone = 'good' | 'bad' | 'warn' | 'plain';

/**
 * Family: for looking after someone at home. A daily check-in that tells the family when
 * there's no sign of them, spoken reminders in their language, and a card of voice commands
 * to print for the fridge.
 */
@Component({
  selector: 'app-family',
  standalone: true,
  imports: [FormsModule, RouterLink, CheckinEditorComponent, RemindersComponent, HelpButtonComponent, SosAlertComponent, SosSettingsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    h1 { font-size: 1.4rem; font-weight: 700; margin: 0 0 0.3rem; }
    .lead { color: var(--text-muted); margin: 0 0 0.5rem; max-width: 46rem; line-height: 1.5; }
    h2 { font-size: 0.8rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-muted); margin: 1.8rem 0 0.7rem; }
    .card { padding: 1.1rem 1.25rem; }
    .stack { display: flex; flex-direction: column; gap: 0.75rem; }
    p { margin: 0; line-height: 1.5; }
    .muted { color: var(--text-muted); font-size: 0.85rem; }
    .who { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
    .who h3 { font-size: 1.1rem; margin: 0; }
    .today { margin-top: 0.6rem; padding: 0.6rem 0.8rem; border-radius: var(--radius); background: var(--bg); font-size: 0.9rem; display: flex; gap: 0.55rem; align-items: flex-start; }
    .today .mark { flex: none; width: 1.3rem; height: 1.3rem; border-radius: 50%; display: grid; place-items: center; font-size: 0.75rem; font-weight: 700; color: #0f172a; margin-top: 0.05rem; }
    .today.good .mark { background: var(--green); }
    .today.bad .mark { background: var(--red); color: #fff; }
    .today.warn .mark { background: #f59e0b; }
    .today.plain .mark { background: var(--border); color: var(--text); }
    .acts { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-top: 0.8rem; align-items: center; }
    .acts button { font-size: 0.85rem; padding: 0.35rem 0.8rem; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text); min-height: 36px; }
    .acts input[type=date] { padding: 0.3rem 0.5rem; }
    .told { font-size: 0.9rem; color: var(--text-muted); }
    .told.none { color: #fcd34d; }
    .told a, .lead a { color: var(--accent); }
    .this-phone { display: flex; gap: 0.5rem 0.75rem; align-items: center; flex-wrap: wrap; margin-top: 0.5rem; }
    .this-phone button { font-size: 0.85rem; padding: 0.35rem 0.8rem; border-radius: 6px; border: 1px solid var(--accent); background: transparent; color: var(--accent); min-height: 36px; }
    .privacy { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.6rem; }
    .result { font-size: 0.85rem; color: var(--text-muted); }
    .intro ul { margin: 0.5rem 0 0.9rem 1.1rem; padding: 0; color: var(--text-muted); font-size: 0.9rem; line-height: 1.6; }
    .sos-top { display: flex; gap: 1.25rem; align-items: center; justify-content: space-between; }
    .sos-top > div { flex: 1 1 auto; }
    .sos-top app-help-button { flex: none; }
    @media (max-width: 599px) { .sos-top { flex-direction: column; align-items: stretch; } }
    h3.sub { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin: 1.1rem 0 0.4rem; }
    ul.recent { margin: 0; padding-left: 1.1rem; font-size: 0.88rem; color: var(--text-muted); line-height: 1.6; }
    .settings-toggle { display: block; text-align: left; margin-top: 1rem; background: none; border: none; padding: 0.3rem 0; color: var(--text-muted); font-size: 0.88rem; }
    .sos p { font-size: 0.92rem; }
    .print { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
    a.btn-primary { display: inline-flex; align-items: center; min-height: 38px; padding: 0 1rem; border-radius: var(--radius); text-decoration: none; }
  `],
  template: `
    <div class="page">
      <h1>Family</h1>
      <p class="lead">For looking after someone at home: a daily check-in, reminders the speakers say in their language, and a card of voice commands for the fridge.</p>

      @if (data(); as d) {
        @if (d.sos.open; as open) {
          <div style="margin-top:1rem"><app-sos-alert [alert]="open" [timezone]="d.timezone" (changed)="load()" /></div>
        }
        <h2>Daily check-in</h2>
        <div class="stack">
          @for (c of d.checkins; track c.id) {
            <div class="card">
              <div class="who">
                <h3>{{ c.name }}</h3>
                <span class="muted">{{ c.enabled ? 'Checked by ' + clock(c.by) + ' · ' + days(c.days) + (c.askFirst ? ' · Asks at home first' : '') : 'Turned off' }}</span>
              </div>
              @if (today(c); as t) {
                <div class="today" [class]="'today ' + t.tone">
                  <span class="mark" aria-hidden="true">{{ t.tone === 'good' ? '✓' : t.tone === 'bad' ? '!' : t.tone === 'warn' ? '!' : '…' }}</span>
                  <span>{{ t.text }}</span>
                </div>
              }
              @if (admin()) {
                <div class="acts">
                  <button type="button" (click)="editing.set(c)">Edit</button>
                  <button type="button" (click)="test(c)" [disabled]="testing()">Send a test alert</button>
                  @if (isPaused(c)) {
                    <button type="button" (click)="patch(c, { pausedUntil: null })">Resume</button>
                  } @else if (pausing() === c.id) {
                    <label class="muted">Pause until <input type="date" [(ngModel)]="pauseUntil" [min]="todayDate()" name="pause" /></label>
                    <button type="button" (click)="patch(c, { pausedUntil: pauseUntil }); pausing.set(null)" [disabled]="!pauseUntil">Pause</button>
                    <button type="button" (click)="pausing.set(null)">Cancel</button>
                  } @else {
                    <button type="button" (click)="pausing.set(c.id)">Pause for a trip</button>
                  }
                  <button type="button" (click)="patch(c, { enabled: !c.enabled })">{{ c.enabled ? 'Turn off' : 'Turn on' }}</button>
                  @if (testResult()) { <span class="result" aria-live="polite">{{ testResult() }}</span> }
                </div>
              }
              <p class="privacy">Make sure {{ c.name }} knows it’s on. HomeHub only looks at what’s switched and used at home, never at camera pictures.</p>
            </div>
          } @empty {
            <div class="card intro">
              <p>For someone who lives alone. If nothing at home shows they’re up and about by a time you choose, the family is told, and told again as soon as HomeHub sees activity.</p>
              <ul>
                <li>Signs they’re up: lights switched, voice commands, water used, motion sensors.</li>
                <li>It looks back two weeks first, so you can pick a time that wouldn’t give false alarms.</li>
                <li>Nothing leaves the house except the alert itself.</li>
              </ul>
              @if (admin()) {
                <button type="button" class="btn-primary" style="min-height:38px;padding:0 1rem" (click)="editing.set('new')">Set up a check-in</button>
              } @else {
                <p class="muted">An admin can set one up.</p>
              }
            </div>
          }
          @if (admin() && d.checkins.length) {
            <div><button type="button" class="btn-ghost" (click)="editing.set('new')">+ Another check-in</button></div>
          }
        </div>

        <h2>Who’s told</h2>
        <div class="card">
          <p class="told" [class.none]="!told().ok">{{ told().text }}
            @if (!told().ok) { <a routerLink="/settings" [queryParams]="{ section: 'integrations' }">Set up email</a>, or turn on notifications on each family member’s phone. }
          </p>
          <div class="this-phone">
            @switch (push.state()) {
              @case ('on') { <span class="muted">✓ This device gets alerts.</span> }
              @case ('off') {
                <button type="button" (click)="enablePush()" [disabled]="pushBusy()">Get alerts on this device</button>
                <span class="muted">Each family member does this on their own phone, signed in as themselves.</span>
              }
              @case ('checking') {}
              @default { <span class="muted">{{ pushHelp() }}</span> }
            }
            @if (pushMsg()) { <span class="result" aria-live="polite">{{ pushMsg() }}</span> }
          </div>
        </div>

        <h2>Call for help</h2>
        <div class="card sos">
          <div class="sos-top">
            <div>
              <p>If {{ d.sos.who === 'Someone' ? 'someone at home' : d.sos.who }} needs help, they can say <b>救命</b>, <b>cứu tôi với</b> or <b>help me</b> to a speaker, press a button, or hold the button here. The family is told at once, again every 5 minutes until someone taps “I’m on it”, and the speaker tells them who’s coming.</p>
              <p class="muted" style="margin-top:0.5rem">For their own phone or tablet, open <a routerLink="/family/sos">the button on its own page</a> and add it to the Home Screen. HomeHub doesn’t call 911 and isn’t a monitored service; if HomeHub or the Wi-Fi is down, it can’t send anything.</p>
            </div>
            @if (!d.sos.open) { <app-help-button (sent)="load()" /> }
          </div>
          @if (pastAlerts().length) {
            <h3 class="sub">Recent</h3>
            <ul class="recent">
              @for (a of pastAlerts(); track a.id) { <li>{{ alertLine(a) }}</li> }
            </ul>
          }
          @if (admin()) {
            <button type="button" class="settings-toggle" (click)="sosSettings.set(!sosSettings())" [attr.aria-expanded]="sosSettings()">
              {{ sosSettings() ? '▾' : '▸' }} Settings: name, texts and calls, buttons, test
            </button>
            @if (sosSettings()) { <div style="margin-top:0.8rem"><app-sos-settings [sos]="d.sos" (changed)="load()" /></div> }
          }
        </div>

        <h2>Spoken reminders</h2>
        <div class="card"><app-reminders [data]="d" (changed)="load()" /></div>

        <h2>Voice command card</h2>
        <div class="card print">
          <p>A card to print and keep by the speaker: what to say, in each language, with your devices’ nicknames.</p>
          <a class="btn-primary" routerLink="/family/card">Open the card</a>
        </div>

        @if (editing(); as e) {
          <app-checkin-editor [data]="d" [existing]="e === 'new' ? null : e" [devicesList]="devices()" (saved)="editing.set(null); load()" (closed)="editing.set(null)" />
        }
      } @else if (failed()) {
        <p class="muted">The Family page couldn’t be loaded. Reload the page to try again.</p>
      } @else {
        <p class="muted">Loading…</p>
      }
    </div>
  `,
})
export class FamilyComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  readonly push = inject(PushService);
  readonly pushBusy = signal(false);
  readonly pushMsg = signal('');
  readonly pushHelp = computed(() => PushService.help(this.push.state()));

  readonly data = signal<Family | null>(null);
  readonly devices = signal<DeviceLite[]>([]);
  readonly failed = signal(false);
  readonly editing = signal<Checkin | 'new' | null>(null);
  readonly pausing = signal<number | null>(null);
  readonly testing = signal(false);
  readonly testResult = signal('');
  pauseUntil = '';

  readonly admin = computed(() => this.auth.user()?.role === 'admin');
  readonly clock = clockText;
  readonly days = daysText;

  readonly sosSettings = signal(false);
  private poll?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    this.load();
    // A call for help shows up, and who's on it, without reloading the page.
    this.poll = setInterval(() => {
      if (document.visibilityState !== 'visible' || this.editing()) return;
      this.http.get<Family>('/api/family').subscribe({ next: (f) => this.data.set(f), error: () => undefined });
    }, 15_000);
  }

  ngOnDestroy(): void { clearInterval(this.poll); }

  readonly pastAlerts = computed(() => (this.data()?.sos.recent ?? []).filter((a) => a.id !== this.data()?.sos.open?.id));

  alertLine(a: SosAlert): string {
    const tz = this.data()!.timezone;
    const day = new Date(a.startedAt).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz });
    const end = a.cancelledAt ? `cancelled by ${a.cancelledBy}` : a.ackedBy ? `${a.ackedBy} was on it` : a.endedAt ? 'nobody said they were on it' : 'going';
    return `${day}, ${timeIn(a.startedAt, tz)}: ${howText(a)}; ${end}.`;
  }

  load(): void {
    forkJoin({ family: this.http.get<Family>('/api/family'), devices: this.http.get<DeviceLite[]>('/api/devices') }).subscribe({
      next: ({ family, devices }) => { this.data.set(family); this.devices.set(devices); this.failed.set(false); },
      error: () => this.failed.set(true),
    });
  }

  todayDate(): string { return todayIn(this.data()?.timezone ?? 'UTC'); }
  isPaused(c: Checkin): boolean { return !!c.pausedUntil && c.pausedUntil >= this.todayDate(); }

  readonly told = computed(() => {
    const a = this.data()?.audience ?? { phones: 0, people: [], emails: 0 };
    const whose = a.people.length ? ` (${listText(a.people)})` : '';
    const parts = [
      a.phones ? `notification on ${a.phones} ${a.phones === 1 ? 'device' : 'devices'}${whose}` : '',
      a.emails ? `email to ${a.emails} ${a.emails === 1 ? 'address' : 'addresses'}` : '',
    ].filter(Boolean);
    return parts.length
      ? { ok: true, text: `Alerts go by ${parts.join(' and ')}.` }
      : { ok: false, text: 'Nobody would be told yet: no phone has HomeHub notifications on, and email isn’t set up.' };
  });

  /** How today went, or what happens next. */
  today(c: Checkin): { tone: Tone; text: string } {
    const tz = this.data()!.timezone;
    const today = this.todayDate();
    const by = clockText(c.by);
    if (!c.enabled) return { tone: 'plain', text: 'Off: no check today.' };
    if (this.isPaused(c)) {
      const until = new Date(`${c.pausedUntil}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      return { tone: 'plain', text: `Paused until ${until}.` };
    }
    if (c.lastDay === today) {
      const sign = c.lastSignAt ? `${timeIn(c.lastSignAt, tz)}: ${c.lastSign}` : '';
      const ask = c.lastAsk;
      const told = `The family was told at ${c.alertedAt ? timeIn(c.alertedAt, tz) : by}.`;
      switch (c.lastResult) {
        case 'ok':
          if (ask?.answer === 'yes') return { tone: 'good', text: `Today: no activity by ${by}, so HomeHub asked at home. ${c.name} said they’re OK at ${ask.answeredAt ? timeIn(ask.answeredAt, tz) : by}.` };
          if (ask) return { tone: 'good', text: `Today: no activity by ${by}, so HomeHub asked at home. Then activity at ${sign}.` };
          return { tone: 'good', text: `Today: up and about. First activity at ${sign}.` };
        case 'asking': return { tone: 'warn', text: `Today: no activity by ${by}, so HomeHub is asking at home${ask && ask.asks > 1 ? ' again' : ''}. The family is told if nobody says they’re OK.` };
        case 'all-clear': return { tone: 'good', text: `Today: no activity by ${by}, so the family was told. Then activity at ${sign}.` };
        case 'alerted':
          if (ask?.answer === 'no') return { tone: 'bad', text: `Today: ${c.name} said they’re not OK when HomeHub asked at home. ${told}` };
          if (ask) return { tone: 'bad', text: `Today: no activity by ${by}, and nobody answered when HomeHub asked at home. ${told} HomeHub will say when it sees activity.` };
          return { tone: 'bad', text: `Today: no activity by ${by}. ${told} HomeHub will say when it sees activity.` };
        case 'missed': return { tone: 'warn', text: `Today: HomeHub was off at ${by}, so it couldn’t check.` };
        case 'away': return { tone: 'plain', text: 'Today: not checked, Away mode was on.' };
        default: return { tone: 'plain', text: `Checks at ${by} tomorrow.` };
      }
    }
    const weekday = new Date(`${today}T12:00:00`).getDay();
    if (!c.days.includes(weekday)) return { tone: 'plain', text: 'Not checked today.' };
    return { tone: 'plain', text: `Checks at ${by} today.` };
  }

  async enablePush(): Promise<void> {
    this.pushBusy.set(true);
    this.pushMsg.set('');
    try {
      await this.push.enable();
      this.load();
    } catch (err) {
      this.pushMsg.set(err instanceof Error ? err.message : 'Notifications couldn’t be turned on.');
    } finally {
      this.pushBusy.set(false);
    }
  }

  patch(c: Checkin, body: Partial<Checkin>): void {
    this.http.put(`/api/family/checkins/${c.id}`, body).subscribe({ next: () => this.load() });
  }

  test(c: Checkin): void {
    this.testing.set(true);
    this.testResult.set('');
    this.http.post<{ phones: number; emails: number }>(`/api/family/checkins/${c.id}/test`, {}).subscribe({
      next: (a) => {
        this.testing.set(false);
        this.testResult.set(a.phones || a.emails ? 'Sent. Check that everyone got it.' : 'Nobody to send it to yet.');
      },
      error: (e) => { this.testing.set(false); this.testResult.set(errorText(e, 'The test couldn’t be sent.')); },
    });
  }
}
