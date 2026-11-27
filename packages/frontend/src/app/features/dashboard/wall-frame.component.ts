import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { LockService } from '../../core/lock/lock.service';
import { AppUpdateService } from '../../core/services/app-update.service';
import { SystemService } from '../../core/services/system.service';
import { AuthService } from '../../core/auth/auth.service';
import { setWallHome, wallGoHome } from '../../core/wall-home';

interface Weather { unit: 'C' | 'F'; temperature: number; summary: string; today: { high: number; low: number; rain: number } }
interface Scene { id: number; name: string; icon: string | null }
interface Schedule { id: number; deviceAlias: string; state: boolean; enabled: boolean; next?: string | null; problem?: string | null; stayOnMinutes?: number | null }
interface Coming { key: string; at: number; names: string; state: boolean }

const WINDOWED_KEY = 'homehub.wall.windowed';
/**
 * A tablet or bigger. A phone can show the wall display for a look, but isn't made one: its lock
 * would then send it here every time, full screen, as happened on a phone that had opened it once.
 */
const WALL_SIZED = '(min-width: 600px) and (min-height: 600px)';
const wallSized = () => typeof matchMedia !== 'function' || matchMedia(WALL_SIZED).matches;
const NIGHT_KEY = 'homehub.wall.night';
/** How long a tap keeps the night screen away. */
const AWAKE_MS = 2 * 60_000;

function loadNight(): { from: string; to: string; on: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(NIGHT_KEY) ?? 'null');
    if (v && /^\d{2}:\d{2}$/.test(v.from) && /^\d{2}:\d{2}$/.test(v.to)) return { from: v.from, to: v.to, on: v.on !== false };
  } catch { /* the default */ }
  return { from: '22:00', to: '06:30', on: true };
}

const joinNames = (n: string[]) => (n.length <= 1 ? n.join('') : n.length > 3
  ? `${n.slice(0, 2).join(', ')} and ${n.length - 2} more` : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`);

/**
 * The wall display: HomeHub on a tablet that's always on. A large clock, the weather, what the
 * schedules do next and the scenes along the top; the rooms (projected in, from the Home page)
 * below. It keeps the screen awake where the browser allows, and at night turns to a dim clock
 * that drifts a little each minute, so nothing burns into the screen; a tap brings it back.
 *
 * Its choices (night hours) are this browser's own: a wall tablet is set up once, on itself.
 */
@Component({
  selector: 'app-wall-frame',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; min-height: 100vh; padding: 1.1rem clamp(1rem, 2.5vw, 2rem) 2rem; box-sizing: border-box; }
    .top { display: grid; grid-template-columns: auto 1fr minmax(16rem, 26rem); gap: 1rem 2rem; align-items: start; margin-bottom: 1.1rem; }
    @media (max-width: 760px) { .top { grid-template-columns: 1fr auto; } .coming { grid-column: 1 / -1; } }
    .clock { font-size: clamp(3.2rem, 8vw, 5.5rem); font-weight: 700; line-height: 1; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
    .clock small { font-size: 0.35em; font-weight: 600; letter-spacing: 0; margin-left: 0.3rem; color: var(--text-muted); }
    .date { color: var(--text-muted); font-size: 1.05rem; margin-top: 0.35rem; }
    .weather { align-self: center; }
    .weather b { font-size: clamp(2rem, 4vw, 2.8rem); font-weight: 600; }
    .weather span { display: block; color: var(--text-muted); font-size: 0.95rem; margin-top: 0.2rem; }
    .weather span:first-letter { text-transform: uppercase; }
    .coming { background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 0.8rem 1rem; }
    .coming h2 { margin: 0 0 0.4rem; font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); font-weight: 600; }
    .coming ol { list-style: none; margin: 0; padding: 0; }
    .coming li { display: grid; grid-template-columns: 4.8rem 1fr; gap: 0.6rem; padding: 0.3rem 0; font-size: 0.95rem; }
    .coming li b { font-variant-numeric: tabular-nums; }
    .coming li span { overflow-wrap: anywhere; color: var(--text); }
    .coming .none { color: var(--text-muted); font-size: 0.9rem; margin: 0; }
    .bar { display: flex; gap: 0.6rem; align-items: center; margin-bottom: 1.1rem; flex-wrap: wrap; }
    .scene { border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 999px; padding: 0.7rem 1.2rem; font-size: 1rem; font-weight: 600; min-height: 3rem; }
    .scene.done { border-color: var(--green); color: #4ade80; }
    .scene:active { transform: scale(0.97); }
    .menu-btn { position: fixed; right: 1rem; bottom: 1rem; z-index: 20; width: 3rem; height: 3rem; border-radius: 50%; border: 1px solid var(--border); background: var(--surface); color: var(--text-muted); font-size: 1.3rem; padding: 0; opacity: 0.7; }
    .lock-btn, .home-btn { right: 4.6rem; display: grid; place-items: center; }
    .home-btn.with-lock { right: 8.2rem; }
    .lock-btn svg, .home-btn svg { width: 1.2rem; height: 1.2rem; }
    .sheet-h { margin: 1.1rem 0 0.4rem; font-size: 0.95rem; }
    .ver { margin-top: 0.9rem; text-align: center; }
    .pin-row { display: flex; gap: 0.6rem; align-items: flex-end; flex-wrap: wrap; margin-bottom: 0.6rem; }
    .pin-row label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; color: var(--text-muted); }
    .pin-row input { width: 7.5rem; letter-spacing: 0.3em; }
    /* PINs are typed into plain boxes that hide the digits: a password box would have the browser offer
       to save the PIN as the site's password, and replace the real one. */
    .pin-row input.pin { -webkit-text-security: disc; text-security: disc; }
    .pin-row input::placeholder { letter-spacing: normal; }
    .pin-row button { padding: 0.55rem 1rem; border-radius: 10px; }
    .err { color: var(--red); font-size: 0.85rem; margin: 0 0 0.6rem; }
    .danger-btn { background: var(--red); color: #fff; border: none; padding: 0.55rem 1rem; border-radius: 10px; font-weight: 600; }
    .ok { color: #4ade80; font-size: 0.85rem; margin: 0 0 0.6rem; }
    .linkish { background: none; border: none; color: var(--accent); padding: 0; font-size: 0.85rem; }
    /* Bigger rooms on a big screen: read and tapped from across the room. */
    @media (min-width: 1000px) { .rooms { zoom: 1.18; } }
    .night { position: fixed; inset: 0; z-index: 300; background: #000; color: #9ca3af; cursor: pointer; overflow: hidden; }
    .night .face { position: absolute; transition: left 2s, top 2s; text-align: center; opacity: 0.55; }
    .night .face b { display: block; font-size: clamp(4rem, 12vw, 8rem); font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -0.03em; }
    .night .face span { display: block; margin-top: 0.6rem; font-size: 1.05rem; }
    .row { display: flex; gap: 0.8rem; align-items: center; flex-wrap: wrap; margin: 0 0 0.9rem; }
    .row label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; color: var(--text-muted); }
    .check { flex-direction: row !important; align-items: center; gap: 0.5rem !important; font-size: 0.95rem !important; color: var(--text) !important; white-space: nowrap; flex-basis: 100%; }
    .check input { width: auto; margin: 0; }
    .tip { font-size: 0.85rem; color: var(--text-muted); line-height: 1.45; }
  `],
  template: `
    <div class="top">
      <div>
        <div class="clock">{{ time().hm }}<small>{{ time().ampm }}</small></div>
        <div class="date">{{ time().date }}</div>
      </div>
      <div class="weather">
        @if (weather(); as w) {
          <b>{{ w.temperature }}°</b>
          <span>{{ w.summary }} · H {{ w.today.high }}° L {{ w.today.low }}°{{ w.today.rain >= 20 ? ' · ' + w.today.rain + '% rain' : '' }}</span>
        }
      </div>
      <section class="coming" aria-labelledby="wall-coming">
        <h2 id="wall-coming">Coming up</h2>
        @if (coming().length) {
          <ol>
            @for (c of coming(); track c.key) { <li><b>{{ clock(c.at) }}</b><span>{{ c.names }} {{ c.state ? 'on' : 'off' }}</span></li> }
          </ol>
        } @else { <p class="none">Nothing scheduled in the next 12 hours.</p> }
      </section>
    </div>

    @if (scenes().length) {
      <div class="bar" role="group" aria-label="Scenes">
        @for (s of scenes(); track s.id) {
          <button type="button" class="scene" [class.done]="ran() === s.id" (click)="run(s)">{{ ran() === s.id ? '✓ ' : '' }}{{ s.name }}</button>
        }
      </div>
    }

    <div class="rooms"><ng-content /></div>
    <button type="button" class="menu-btn home-btn" [class.with-lock]="lock.pinSet()" (click)="goHome()" aria-label="Back to the top of the wall display">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7M5 9.5V20h14V9.5" /></svg>
    </button>
    @if (lock.pinSet()) {
      <button type="button" class="menu-btn lock-btn" (click)="lock.lockNow()" aria-label="Lock now">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4" /></svg>
      </button>
    }
    <button type="button" class="menu-btn" (click)="openMenu()" aria-label="Wall display settings">⋯</button>

    @if (asleep()) {
      <div class="night" (click)="wake()" role="button" aria-label="Wake the screen">
        <div class="face" [style.left.%]="drift().x" [style.top.%]="drift().y" [style.transform]="'translate(-50%, -50%)'">
          <b>{{ time().hm }}</b>
          @if (coming()[0]; as c) { <span>{{ clock(c.at) }} · {{ c.names }} {{ c.state ? 'on' : 'off' }}</span> }
        </div>
      </div>
    }

    @if (menu()) {
      <div class="hh-scrim" (click)="menu.set(false)">
        <div class="hh-sheet" role="dialog" aria-modal="true" aria-labelledby="wall-menu" (click)="$event.stopPropagation()">
          <div class="hh-grab"></div>
          <h3 id="wall-menu">Wall display</h3>
          <div class="row">
            <label class="check"><input type="checkbox" [(ngModel)]="nightOn" (ngModelChange)="saveNight()" /> Dim at night</label>
            <label>From <input type="time" [(ngModel)]="nightFrom" (ngModelChange)="saveNight()" [disabled]="!nightOn" /></label>
            <label>Until <input type="time" [(ngModel)]="nightTo" (ngModelChange)="saveNight()" [disabled]="!nightOn" /></label>
          </div>
          <p class="tip">
            @if (wakeLock() === 'held') { The screen stays on while this page is open. }
            @else { This browser can’t keep the screen on from here{{ secure ? '' : ' (it needs a secure address)' }}. On the tablet, open Settings → Display → Screen timeout and choose the longest, or turn on Developer options → Stay awake, which keeps it on while charging. }
            Tap the dim clock at night to see everything for {{ awakeMinutes }} minutes.
          </p>
          <h4 class="sheet-h">Lock with a PIN</h4>
          @if (lock.pinSet() === false || pinMode() === 'change') {
            <p class="tip">{{ lock.pinSet() ? 'Enter the PIN now, then the new one.' : 'So only people who know it can use this screen. It locks by hand with the lock button, or by itself after a while without a touch, and the PIN opens it.' }}</p>
            <div class="pin-row">
              @if (lock.pinSet()) { <label>PIN now <input type="text" class="pin" spellcheck="false" data-lpignore="true" data-1p-ignore inputmode="numeric" autocomplete="off" maxlength="8" [(ngModel)]="pinCurrent" /></label> }
              <label>New PIN <input type="text" class="pin" spellcheck="false" data-lpignore="true" data-1p-ignore inputmode="numeric" autocomplete="off" maxlength="8" [(ngModel)]="pinNew" placeholder="4–8 digits" /></label>
              <label>Again <input type="text" class="pin" spellcheck="false" data-lpignore="true" data-1p-ignore inputmode="numeric" autocomplete="off" maxlength="8" [(ngModel)]="pinAgain" /></label>
              <button type="button" class="btn-primary" (click)="savePin()" [disabled]="pinBusy()">Save</button>
              @if (pinMode() === 'change') { <button type="button" class="linkish" (click)="pinMode.set('')">Cancel</button> }
            </div>
          } @else if (lock.pinSet()) {
            @if (pinMode() === 'remove') {
              <div class="pin-row">
                <label>PIN now <input type="text" class="pin" spellcheck="false" data-lpignore="true" data-1p-ignore inputmode="numeric" autocomplete="off" maxlength="8" [(ngModel)]="pinCurrent" /></label>
                <button type="button" class="danger-btn" (click)="removePin()" [disabled]="pinBusy()">Remove PIN</button>
                <button type="button" class="linkish" (click)="pinMode.set('')">Cancel</button>
              </div>
            } @else {
              <div class="row">
                <label class="check"><input type="checkbox" [ngModel]="lock.settings().auto" (ngModelChange)="setAuto($event)" /> Lock by itself after</label>
                <label>Without a touch
                  <select [ngModel]="lock.settings().idleMinutes" (ngModelChange)="setIdle($event)" [disabled]="!lock.settings().auto">
                    @for (m of idleChoices; track m) { <option [ngValue]="m">{{ m }} {{ m === 1 ? 'minute' : 'minutes' }}</option> }
                  </select>
                </label>
              </div>
              <p class="tip">The PIN is this login’s, so it works on any screen signed in as {{ userName() }}. If it’s forgotten, “Forgot the PIN?” on the lock screen signs out; sign in again with the password. <button type="button" class="linkish" (click)="pinMode.set('change'); pinMsg.set('')">Change PIN</button> · <button type="button" class="linkish" (click)="pinMode.set('remove'); pinMsg.set('')">Remove PIN</button></p>
            }
          }
          @if (pinErr()) { <p class="err" role="alert">{{ pinErr() }}</p> }
          @if (pinMsg()) { <p class="ok" role="status">{{ pinMsg() }}</p> }
          <div class="hh-acts">
            @if (lock.pinSet()) { <button type="button" (click)="menu.set(false); lock.lockNow()">Lock now</button> }
            <button type="button" data-no-auto-full (click)="fullscreen()">{{ isFull() ? 'Leave full screen' : 'Full screen' }}</button>
            <button type="button" data-no-auto-full (click)="leave()">Leave wall display</button>
          </div>
          <p class="tip">Leaving opens the rest of HomeHub for a while: <b>Home</b> comes back here, and so does the tablet by itself after 2 minutes without a touch.{{ lock.pinSet() ? ' Leaving asks for the PIN.' : '' }}
            <button type="button" class="linkish" (click)="stopBeingWall()">Stop using this tablet as a wall display</button></p>
          @if (version(); as v) {
            <p class="tip ver">HomeHub {{ v }}{{ updates.outdated() ? ' · this screen has an older version and loads the new one once nobody’s using it' : '' }}</p>
          }
        </div>
      </div>
    }
  `,
})
export class WallFrameComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  readonly lock = inject(LockService);
  readonly updates = inject(AppUpdateService);
  private readonly system = inject(SystemService);
  /** The version HomeHub is running, for the menu: "v0.3.2". */
  readonly version = signal('');
  private readonly auth = inject(AuthService);
  readonly userName = computed(() => this.auth.user()?.name ?? 'this login');
  readonly idleChoices = [1, 2, 5, 10, 15, 30];
  readonly pinMode = signal<'' | 'change' | 'remove'>('');
  readonly pinBusy = signal(false);
  readonly pinErr = signal('');
  readonly pinMsg = signal('');
  pinCurrent = '';
  pinNew = '';
  pinAgain = '';

  readonly now = signal(Date.now());
  readonly weather = signal<Weather | null>(null);
  readonly scenes = signal<Scene[]>([]);
  private readonly schedules = signal<Schedule[]>([]);
  readonly timeZone = signal<string | undefined>(undefined);
  readonly ran = signal<number | null>(null);
  readonly menu = signal(false);
  readonly wakeLock = signal<'held' | 'none'>('none');
  readonly isFull = signal(!!document.fullscreenElement);
  readonly secure = window.isSecureContext;
  readonly awakeMinutes = AWAKE_MS / 60_000;
  private readonly awakeUntil = signal(0);
  private readonly night = signal(loadNight());
  nightOn = this.night().on;
  nightFrom = this.night().from;
  nightTo = this.night().to;

  private timers: ReturnType<typeof setInterval>[] = [];
  private screenLock: { release(): Promise<void> } | null = null;

  readonly time = computed(() => {
    const d = new Date(this.now()), tz = this.timeZone();
    const parts = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', timeZone: tz }).formatToParts(d);
    const ampm = parts.find((p) => p.type === 'dayPeriod')?.value ?? '';
    const hm = parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
    return { hm, ampm, date: d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz }) };
  });

  clock(ms: number): string {
    const t = new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: this.timeZone() });
    return /^12:00\s?AM$/i.test(t) ? 'Midnight' : t.replace(':00', '');
  }

  /** The next 12 hours of schedules, devices switching at the same moment on one line, at most 4 lines. */
  readonly coming = computed<Coming[]>(() => {
    const now = this.now(), until = now + 12 * 3_600_000;
    const lines = new Map<string, { at: number; names: string[]; state: boolean }>();
    const add = (at: number, name: string, state: boolean) => {
      if (at <= now || at > until) return;
      const key = `${Math.floor(at / 60_000)}-${state}`;
      const l = lines.get(key) ?? { at, names: [], state };
      if (!l.names.includes(name)) l.names.push(name);
      lines.set(key, l);
    };
    for (const s of this.schedules()) {
      if (!s.enabled || !s.next || s.problem) continue;
      const at = Date.parse(s.next);
      add(at, s.deviceAlias, s.state);
      if (s.state && s.stayOnMinutes) add(at + s.stayOnMinutes * 60_000, s.deviceAlias, false);
    }
    return [...lines.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 4)
      .map(([key, l]) => ({ key, at: l.at, names: joinNames(l.names), state: l.state }));
  });

  /** Minutes since midnight on the home's clock. */
  private minuteOfDay(): number {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone: this.timeZone() })
      .formatToParts(this.now()).map((x) => [x.type, x.value]));
    return (Number(p['hour']) % 24) * 60 + Number(p['minute']);
  }

  readonly asleep = computed(() => {
    const n = this.night();
    if (!n.on || this.now() < this.awakeUntil() || this.menu()) return false;
    const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const [from, to, at] = [m(n.from), m(n.to), this.minuteOfDay()];
    return from <= to ? at >= from && at < to : at >= from || at < to;
  });

  /** Where the night clock sits: a step each minute, round a small loop. */
  readonly drift = computed(() => {
    const step = Math.floor(this.now() / 60_000) % 12;
    const a = (step / 12) * 2 * Math.PI;
    return { x: 50 + Math.cos(a) * 14, y: 45 + Math.sin(a) * 12 };
  });

  ngOnInit(): void {
    setWallHome(wallSized());
    this.timers.push(setInterval(() => this.now.set(Date.now()), 15_000));
    this.http.get<{ timezone?: string }>('/api/home-settings').subscribe({ next: (h) => this.timeZone.set(h.timezone), error: () => undefined });
    this.loadWeather();
    this.loadSchedules();
    this.http.get<Scene[]>('/api/scenes').subscribe({ next: (s) => this.scenes.set(s.slice(0, 8)), error: () => undefined });
    this.timers.push(setInterval(() => this.loadWeather(), 15 * 60_000));
    this.timers.push(setInterval(() => this.loadSchedules(), 5 * 60_000));
    void this.holdScreen();
    document.addEventListener('visibilitychange', this.onVisible);
    document.addEventListener('fullscreenchange', this.onFull);
    document.addEventListener('pointerup', this.onTouch, true);
  }

  ngOnDestroy(): void {
    this.timers.forEach(clearInterval);
    document.removeEventListener('visibilitychange', this.onVisible);
    document.removeEventListener('fullscreenchange', this.onFull);
    document.removeEventListener('pointerup', this.onTouch, true);
    void this.screenLock?.release().catch(() => undefined);
    this.screenLock = null;
  }

  private loadWeather(): void {
    this.http.get<Weather>('/api/home-settings/weather').subscribe({ next: (w) => this.weather.set(w), error: () => undefined });
  }

  private loadSchedules(): void {
    this.http.get<Schedule[]>('/api/schedules').subscribe({ next: (s) => this.schedules.set(s), error: () => undefined });
  }

  /** The browser drops the screen lock when the page is hidden, so it's asked for again on return. */
  private readonly onVisible = () => {
    if (document.hidden) return;
    this.now.set(Date.now());
    this.loadSchedules();
    void this.holdScreen();
  };
  private readonly onFull = () => {
    const full = !!document.fullscreenElement;
    // Left by the person, with the phone's own swipe or Back, while looking at it: that's their
    // choice, so a tap no longer goes full screen again. Left because the screen went off, it does.
    if (!full && this.isFull() && document.visibilityState === 'visible' && !this.leaving) this.stayWindowed = true;
    this.isFull.set(full);
  };

  /** Set by "Leave full screen": touches stop going full screen until "Full screen" is chosen. */
  private get stayWindowed(): boolean {
    try { return sessionStorage.getItem(WINDOWED_KEY) === '1'; } catch { return this.windowed; }
  }
  private set stayWindowed(on: boolean) {
    this.windowed = on;
    try { if (on) sessionStorage.setItem(WINDOWED_KEY, '1'); else sessionStorage.removeItem(WINDOWED_KEY); } catch { /* this page only */ }
  }
  /** Kept for the tab, so a reload for an update doesn't undo it. */
  private windowed = false;
  /** Leaving the wall display ends full screen too; coming back still goes full screen. */
  private leaving = false;
  /**
   * A browser goes full screen only from a touch, so the first touch on a touch screen does it,
   * and the tap still does what it was on. Again after the tablet wakes or Chrome leaves it.
   */
  private readonly onTouch = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || this.stayWindowed || document.fullscreenElement || !wallSized()) return;
    // The menu's own Full screen and Leave buttons decide for themselves.
    if ((e.target as Element | null)?.closest?.('[data-no-auto-full]')) return;
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  private async holdScreen(): Promise<void> {
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void>; addEventListener(t: string, f: () => void): void }> } };
    if (!nav.wakeLock) { this.wakeLock.set('none'); return; }
    try {
      const held = await nav.wakeLock.request('screen');
      this.screenLock = held;
      this.wakeLock.set('held');
      held.addEventListener('release', () => { this.screenLock = null; this.wakeLock.set('none'); });
    } catch {
      this.wakeLock.set('none');
    }
  }

  run(s: Scene): void {
    this.http.post(`/api/scenes/${s.id}/run`, {}).subscribe({
      next: () => { this.ran.set(s.id); setTimeout(() => { if (this.ran() === s.id) this.ran.set(null); }, 2500); },
      error: () => undefined,
    });
  }

  wake(): void {
    this.awakeUntil.set(Date.now() + AWAKE_MS);
    this.now.set(Date.now());
  }

  /** Back to the top: any room open closes, and the clock and scenes are in view. */
  goHome(): void {
    wallGoHome.update((n) => n + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  openMenu(): void {
    this.lock.refresh();
    this.system.version().subscribe({ next: (v) => this.version.set(v.running), error: () => undefined });
    this.pinMode.set(''); this.pinErr.set(''); this.pinMsg.set('');
    this.pinCurrent = this.pinNew = this.pinAgain = '';
    this.menu.set(true);
  }

  savePin(): void {
    this.pinErr.set(''); this.pinMsg.set('');
    if (!/^\d{4,8}$/.test(this.pinNew)) { this.pinErr.set('A PIN is 4 to 8 digits.'); return; }
    if (this.pinNew !== this.pinAgain) { this.pinErr.set('The two PINs aren’t the same.'); return; }
    const first = !this.lock.pinSet();
    this.pinBusy.set(true);
    this.lock.setPin(this.pinNew, this.pinCurrent || undefined).subscribe({
      next: () => {
        this.pinBusy.set(false); this.pinMode.set('');
        this.pinCurrent = this.pinNew = this.pinAgain = '';
        this.pinMsg.set(first ? `PIN saved. This screen now locks by itself after ${this.lock.settings().idleMinutes} minutes without a touch.` : 'PIN changed.');
      },
      error: (e) => { this.pinBusy.set(false); this.pinErr.set(e?.error?.error ?? 'The PIN couldn’t be saved.'); },
    });
  }

  removePin(): void {
    this.pinErr.set(''); this.pinBusy.set(true);
    this.lock.removePin(this.pinCurrent).subscribe({
      next: () => { this.pinBusy.set(false); this.pinMode.set(''); this.pinCurrent = ''; this.pinMsg.set('PIN removed. This screen won’t lock.'); },
      error: (e) => { this.pinBusy.set(false); this.pinErr.set(e?.error?.error ?? 'It couldn’t be removed.'); },
    });
  }

  // A wall tablet locks without a touch, not after being away.
  setAuto(on: boolean): void { this.lock.saveSettings({ ...this.lock.settings(), auto: on, away: false }); }
  setIdle(m: number): void { this.lock.saveSettings({ ...this.lock.settings(), idleMinutes: Number(m), away: false }); }

  saveNight(): void {
    const v = { on: this.nightOn, from: this.nightFrom || '22:00', to: this.nightTo || '06:30' };
    this.night.set(v);
    try { localStorage.setItem(NIGHT_KEY, JSON.stringify(v)); } catch { /* this visit only */ }
  }

  fullscreen(): void {
    this.stayWindowed = !!document.fullscreenElement;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }

  /** Off to the rest of HomeHub for a while, after the PIN: it's still a wall tablet, so Home and time bring it back. */
  leave(): void {
    this.menu.set(false);
    this.lock.askPin('leave the wall display', () => {
      this.leaving = true;
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      void this.router.navigateByUrl('/dashboard');
    });
  }

  /** For good, after the PIN: HomeHub opens on the Dashboard here again, and doesn't come back by itself. */
  stopBeingWall(): void {
    this.menu.set(false);
    this.lock.askPin('stop using this tablet as a wall display', () => {
      this.leaving = true;
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      setWallHome(false);
      void this.router.navigateByUrl('/dashboard');
    });
  }
}
