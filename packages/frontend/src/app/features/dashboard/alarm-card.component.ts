import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { SocketService } from '../../core/socket/socket.service';
import { AuthService } from '../../core/auth/auth.service';

type ArmState = 'disarmed' | 'armed-stay' | 'armed-away' | 'armed-night' | 'unknown';
type SensorKind = 'door' | 'window' | 'motion' | 'glass' | 'smoke' | 'co' | 'temperature' | 'other';
type SensorState = 'open' | 'closed' | 'active' | 'idle' | 'wet' | 'dry' | 'unknown';
type Mode = 'stay' | 'away' | 'night';

interface Partition { id: string; name: string; state: ArmState; pending: ArmState | null; canNight: boolean; sensorIds: string[] }
interface Sensor {
  id: string; name: string; kind: SensorKind; state: SensorState; bypassed: boolean; lowBattery: boolean; changedAt: string | null;
  /** Alarm.com's words for a state HomeHub doesn't name. */
  label?: string | null;
  /** When HomeHub last saw it open and close (null: not seen). */
  lastOpened?: string | null;
  lastClosed?: string | null;
  /** A garage door's opener (not on the alarm); its device id in HomeHub. */
  opener?: number;
}
/** A garage door with an opener HomeHub controls: not on the alarm, shown with its doors. */
interface GarageDoor { id: number; name: string; state: 'open' | 'closed' | 'unknown'; lastOpened: string | null; lastClosed: string | null }
interface AlarmEvent { at: string; kind: 'arm' | 'sensor'; name: string; state: string; source: 'app' | 'outside'; userName: string | null; detail: string | null }
export interface AlarmView {
  connection: 'signed-out' | 'standby' | 'connecting' | 'ready' | 'expired' | 'error';
  detail: string | null;
  partitions: Partition[];
  sensors: Sensor[];
  updatedAt: string | null;
  live: boolean;
  pinLength: number | null;
  recent: AlarmEvent[];
  garage?: GarageDoor[];
}

/** What the sheet is asking. */
type Ask =
  | { kind: 'arm'; p: Partition; mode: Mode; open: string[] | null }
  | { kind: 'disarm'; p: Partition };

const ARM_WORDS: Record<ArmState, string> = {
  disarmed: 'Disarmed', 'armed-stay': 'Armed · Stay', 'armed-away': 'Armed · Away', 'armed-night': 'Armed · Night', unknown: 'Unknown',
};
const MODE_WORDS: Record<Mode, string> = { stay: 'Arm Stay', away: 'Arm Away', night: 'Arm Night' };
const MODE_HELP: Record<Mode, string> = {
  stay: 'For when you’re home: doors and windows are armed, motion sensors aren’t.',
  away: 'For when everyone’s out: doors, windows and motion are armed. Leave before the exit delay ends.',
  night: 'For the night, as your panel sets it up.',
};
const STATE_WORDS: Record<SensorState, string> = {
  open: 'Open', closed: 'Closed', active: 'Motion', idle: 'No motion', wet: 'Wet', dry: 'Dry', unknown: '—',
};
const EVENT_WORDS: Record<string, string> = {
  disarmed: 'Disarmed', 'armed-stay': 'Armed Stay', 'armed-away': 'Armed Away', 'armed-night': 'Armed Night', open: 'opened', closed: 'closed',
};
/** States worth a look: shown first, in amber. */
const NOTABLE = new Set<SensorState>(['open', 'active', 'wet']);
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];

/**
 * The alarm system, through Alarm.com: armed or not, which doors and windows are open, and
 * arming and disarming. Disarming asks for the alarm PIN every time; arming with a door open says
 * which and asks before arming anyway. Shown once an admin signs in under Settings → Integrations.
 */
@Component({
  selector: 'app-alarm-card',
  standalone: true,
  imports: [RouterLink],
  styles: [`
    :host { display: block; }
    .alarm { padding: 0; margin-bottom: 1rem; overflow: hidden; }
    .head { display: flex; align-items: center; gap: .75rem; width: 100%; padding: .6rem .75rem; background: none; color: inherit; text-align: left; border-radius: 0; }
    .shield { width: 2.1rem; height: 2.1rem; border-radius: 50%; display: grid; place-items: center; flex-shrink: 0; background: #ffffff14; color: var(--text-muted); }
    .shield svg { width: 1.15rem; height: 1.15rem; }
    .armed .shield { background: #ef444433; color: #fca5a5; }
    .disarmed .shield { background: #22c55e29; color: #4ade80; }
    .text { flex: 1; min-width: 0; }
    .title { font-weight: 700; font-size: .95rem; }
    .state { font-weight: 600; margin-left: .4rem; font-size: .85rem; color: var(--text-muted); }
    .armed .state { color: #fca5a5; }
    .disarmed .state { color: #4ade80; }
    .alarm .state.wait { color: #fbbf24; }
    .line { display: block; font-size: .8rem; color: var(--text-muted); margin-top: .1rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .line.hot, .line.warn { color: #fbbf24; }
    .line.warn { white-space: normal; }
    .chev { color: var(--text-muted); font-size: .8rem; }
    .acts { display: flex; gap: .5rem; padding: 0 .75rem .65rem; flex-wrap: wrap; align-items: center; }
    .acts button { flex: 1; min-width: 6.5rem; padding: .6rem; border-radius: 10px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-weight: 600; }
    .acts .off { border-color: #22c55e80; color: #4ade80; }
    .acts small { flex-basis: 100%; color: var(--text-muted); font-size: .75rem; }
    .list { list-style: none; margin: 0; padding: .2rem .75rem .5rem; border-top: 1px solid #ffffff14; }
    .list li { display: flex; align-items: center; gap: .6rem; padding: .38rem 0; font-size: .85rem; border-bottom: 1px solid #ffffff0d; }
    .list li:last-child { border-bottom: none; }
    .name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .name small { display: block; font-size: .72rem; color: var(--text-muted); }
    .what { color: var(--text-muted); white-space: nowrap; font-size: .8rem; }
    .hot .what { color: #fbbf24; font-weight: 600; }
    .list i { width: 7px; height: 7px; border-radius: 50%; background: #64748b; flex-shrink: 0; }
    .hot i { background: #fbbf24; }
    .tag { font-size: .7rem; color: var(--text-muted); border: 1px solid var(--border); border-radius: 99px; padding: 0 .4rem; }
    h4 { margin: .5rem .75rem 0; font-size: .75rem; color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
    .foot { font-size: .75rem; color: var(--text-muted); padding: 0 .75rem .65rem; margin: 0; }
    .err { color: #fca5a5; min-height: 1.2rem; font-size: .85rem; margin: 0 0 .6rem; }
    .dots { display: flex; justify-content: center; gap: .8rem; margin: .4rem 0 .8rem; }
    .dots i { width: .8rem; height: .8rem; border-radius: 50%; border: 2px solid var(--text-muted); }
    .dots i.on { background: var(--text); border-color: var(--text); }
    .keys { display: grid; grid-template-columns: repeat(3, 1fr); gap: .6rem; max-width: 17rem; margin: 0 auto 1rem; }
    .keys button { height: 3.6rem; border-radius: 14px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 1.4rem; padding: 0; }
    .keys .blank { visibility: hidden; }
  `],
  template: `
    @if (view(); as v) {
      <section class="card alarm" [class.armed]="armed()" [class.disarmed]="arm() === 'disarmed'">
        <button type="button" class="head" (click)="open.set(!open())" [attr.aria-expanded]="open()" [attr.aria-label]="'Alarm: ' + armWords() + '. ' + summary()">
          <span class="shield" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />@if (armed()) {<path d="M9.5 12.5l2 2 3.5-4" />}</svg>
          </span>
          <span class="text">
            <span class="title">Alarm@if (v.partitions.length) {<span class="state" [class.wait]="!!pending()">{{ pending() ? pendingWords() : armWords() }}</span>}</span>
            @if (problem(); as p) { <span class="line warn">{{ p }}</span> }
            @else { <span class="line" [class.hot]="openCount() > 0">{{ summary() }}</span> }
          </span>
          <span class="chev" aria-hidden="true">{{ open() ? '▲' : '▼' }}</span>
        </button>

        @if (v.connection === 'ready') {
          @for (p of v.partitions; track p.id) {
            <div class="acts" role="group" [attr.aria-label]="'Arm or disarm ' + p.name">
              @if (v.partitions.length > 1) { <small>{{ p.name }}: {{ words(p) }}</small> }
              @if (p.state === 'disarmed' || p.state === 'unknown') {
                <button type="button" (click)="ask({ kind: 'arm', p, mode: 'stay', open: null })" [disabled]="!!p.pending || sending()">Arm Stay</button>
                <button type="button" (click)="ask({ kind: 'arm', p, mode: 'away', open: null })" [disabled]="!!p.pending || sending()">Arm Away</button>
                @if (p.canNight) { <button type="button" (click)="ask({ kind: 'arm', p, mode: 'night', open: null })" [disabled]="!!p.pending || sending()">Arm Night</button> }
              } @else {
                <button type="button" class="off" (click)="ask({ kind: 'disarm', p })" [disabled]="!!p.pending || sending()">Disarm</button>
              }
            </div>
          }
        }

        @if (open()) {
          @if (doors().length) {
            <ul class="list" aria-label="Alarm sensors and garage doors">
              @for (s of sorted(); track s.id) {
                <li [class.hot]="isNotable(s)">
                  <i aria-hidden="true"></i>
                  <span class="name">{{ s.name }}@if (seen(s); as t) {<small>{{ t }}</small>}</span>
                  @if (s.opener) { <span class="tag" title="From the garage door opener. The alarm doesn’t watch this door.">Opener</span> }
                  @if (s.bypassed) { <span class="tag">Bypassed</span> }
                  @if (s.lowBattery) { <span class="tag">Low battery</span> }
                  <span class="what">{{ s.state === 'unknown' ? (s.label || '—') : stateWords(s.state) }}@if (s.changedAt && isNotable(s)) { · {{ ago(s.changedAt) }}}</span>
                </li>
              }
            </ul>
          }
          @if (v.recent.length) {
            <h4>Recent</h4>
            <ul class="list" aria-label="Recent alarm activity">
              @for (e of v.recent; track $index) {
                <li><span class="name">{{ eventWords(e) }}</span><span class="what">{{ when(e.at) }}</span></li>
              }
            </ul>
          }
          <p class="foot">
            Through Alarm.com{{ v.updatedAt ? ', updated ' + ago(v.updatedAt) : '' }}{{ v.live ? '' : '. Live updates paused: checking every minute' }}.
            @if (v.pinLength === null) { Disarming here needs an alarm PIN, set in Settings. }
            @if (admin()) { <a routerLink="/settings" [queryParams]="{ section: 'integrations' }">Settings</a> }
          </p>
        }
      </section>

      @if (asking(); as a) {
        <div class="hh-scrim" (click)="close()">
          <div class="hh-sheet" role="dialog" aria-modal="true" aria-labelledby="alarm-ask" (click)="$event.stopPropagation()">
            <div class="hh-grab"></div>
            @if (a.kind === 'arm') {
              @if (a.open) {
                <h3 id="alarm-ask">{{ a.open.join(', ') }} {{ a.open.length === 1 ? 'is' : 'are' }} open</h3>
                <p>Close {{ a.open.length === 1 ? 'it' : 'them' }} first, or arm anyway: the alarm bypasses {{ a.open.length === 1 ? 'it' : 'them' }}, so {{ a.open.length === 1 ? 'it isn’t' : 'they aren’t' }} protected until disarmed.</p>
              } @else {
                <h3 id="alarm-ask">{{ modeWords(a.mode) }}?</h3>
                <p>{{ modeHelp(a.mode) }}</p>
              }
              <p class="err" role="alert">{{ error() }}</p>
              <div class="hh-acts">
                <button type="button" (click)="close()">Cancel</button>
                <button type="button" class="danger" (click)="sendArm(a)" [disabled]="sending()">{{ sending() ? 'Sending…' : a.open ? 'Arm anyway' : modeWords(a.mode) }}</button>
              </div>
            } @else {
              <h3 id="alarm-ask">Disarm {{ v.partitions.length > 1 ? a.p.name : 'the alarm' }}</h3>
              @if (v.pinLength === null) {
                <p>Disarming from HomeHub needs an alarm PIN. An admin can set one in Settings → Integrations → Alarm.com. Meanwhile, use the keypad or the Alarm.com app.</p>
                <div class="hh-acts"><button type="button" (click)="close()">OK</button></div>
              } @else {
                <p>Enter the alarm PIN.</p>
                <div class="dots" aria-hidden="true">@for (d of slots(); track $index) { <i [class.on]="d"></i> }</div>
                <p class="err" role="alert">{{ error() }}</p>
                <div class="keys">
                  @for (k of keys; track $index) {
                    @if (k === '') { <button type="button" class="blank" tabindex="-1" aria-hidden="true"></button> }
                    @else { <button type="button" (click)="press(k, a.p)" [disabled]="sending() || waitUntil() > now()" [attr.aria-label]="k === '⌫' ? 'Delete' : k">{{ k }}</button> }
                  }
                </div>
                <div class="hh-acts"><button type="button" (click)="close()">Cancel</button></div>
              }
            }
          </div>
        </div>
      }
    }
  `,
})
export class AlarmCardComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly socket = inject(SocketService);
  private readonly auth = inject(AuthService);
  readonly keys = KEYS;

  readonly view = signal<AlarmView | null>(null);
  readonly open = signal(false);
  readonly asking = signal<Ask | null>(null);
  readonly sending = signal(false);
  readonly error = signal('');
  readonly entry = signal('');
  readonly waitUntil = signal(0);
  readonly now = signal(Date.now());
  readonly admin = computed(() => this.auth.user()?.role === 'admin');

  /** The whole home's state: armed if any partition is, so a split system never reads "Disarmed" while part of it is armed. */
  readonly arm = computed<ArmState>(() => {
    const parts = this.view()?.partitions ?? [];
    if (!parts.length) return 'unknown';
    return parts.find((p) => p.state.startsWith('armed'))?.state ?? (parts.every((p) => p.state === 'disarmed') ? 'disarmed' : 'unknown');
  });
  readonly armed = computed(() => this.arm().startsWith('armed'));
  readonly armWords = computed(() => {
    const parts = this.view()?.partitions ?? [];
    if (parts.length > 1 && new Set(parts.map((p) => p.state)).size > 1) return parts.map((p) => `${p.name}: ${ARM_WORDS[p.state]}`).join(' · ');
    return ARM_WORDS[this.arm()];
  });
  readonly pending = computed(() => this.view()?.partitions.find((p) => p.pending)?.pending ?? null);
  readonly pendingWords = computed(() => (this.pending() === 'disarmed' ? 'Disarming…' : 'Arming…'));

  readonly openCount = computed(() => this.notable().filter((s) => s.state !== 'active').length);
  /** The alarm's sensors, and the garage doors HomeHub's openers report. */
  readonly doors = computed<Sensor[]>(() => {
    const v = this.view();
    if (!v) return [];
    const garage = (v.garage ?? []).map((g): Sensor => ({
      id: `opener-${g.id}`, name: g.name, kind: 'door', state: g.state, bypassed: false, lowBattery: false, changedAt: null,
      label: g.state === 'unknown' ? 'Not answering' : null, lastOpened: g.lastOpened, lastClosed: g.lastClosed, opener: g.id,
    }));
    return [...v.sensors, ...garage];
  });
  readonly notable = computed(() => this.doors().filter((s) => this.isNotable(s)));
  readonly sorted = computed(() => [...this.doors()]
    .sort((a, b) => Number(this.isNotable(b)) - Number(this.isNotable(a)) || a.name.localeCompare(b.name, undefined, { numeric: true })));

  readonly summary = computed(() => {
    const v = this.view();
    if (!v) return '';
    if (!v.sensors.length) return v.partitions.length ? 'No sensors listed' : 'Waiting for Alarm.com…';
    // Motion stays in the list only: Alarm.com goes on reporting it for a while after it stops.
    const open = this.notable().filter((s) => s.state !== 'active');
    return open.length ? `Open: ${open.map((s) => s.name).join(', ')}` : 'All doors and windows closed';
  });

  /** Something wrong with the connection, in words; null when all is well. */
  readonly problem = computed(() => {
    const v = this.view();
    if (!v) return null;
    const last = v.updatedAt ? ` Last heard ${this.ago(v.updatedAt)}.` : '';
    switch (v.connection) {
      case 'connecting': return v.updatedAt ? null : 'Connecting to Alarm.com…';
      case 'expired': return `Alarm.com needs signing in again: Settings → Integrations → Alarm.com.${last}`;
      case 'error': return `Alarm.com isn’t answering${v.detail ? ` (${v.detail})` : ''}.${last} Use the keypad meanwhile.`;
      case 'standby': return 'Read by the active HomeHub.';
      default: return null;
    }
  });

  readonly slots = computed(() => Array.from({ length: this.view()?.pinLength ?? 4 }, (_, i) => i < this.entry().length));

  private stop?: () => void;
  private stopDoors?: () => void;
  private timer?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    this.load();
    this.stop = this.socket.onAlarmState((v) => this.take(v as AlarmView));
    // A garage door opener changed: its state and times come with the alarm's view.
    this.stopDoors = this.socket.onDeviceState((e) => {
      const door = this.view()?.garage?.find((g) => g.id === e.id);
      if (door && (door.state === 'open') !== e.state) this.load();
    });
    this.timer = setInterval(() => { if (!document.hidden) this.now.set(Date.now()); }, 1_000);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  ngOnDestroy(): void {
    this.stop?.();
    this.stopDoors?.();
    if (this.timer) clearInterval(this.timer);
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  /** Coming back to the app: read again, since socket events may have been missed while asleep. */
  private readonly onVisible = () => { if (!document.hidden) this.load(); };

  private load(): void {
    this.http.get<AlarmView>('/api/alarm').subscribe({ next: (v) => this.take(v), error: () => undefined });
  }

  private take(v: AlarmView): void {
    this.view.set(v && v.connection !== 'signed-out' ? v : null);
    this.now.set(Date.now());
  }

  ask(a: Ask): void {
    this.error.set('');
    this.entry.set('');
    if (a.kind === 'arm') {
      // Say which doors and windows are open up front; the server checks again.
      const on = new Set(a.p.sensorIds);
      const open = (this.view()?.sensors ?? []).filter((s) => (!on.size || on.has(s.id)) && s.state === 'open' && !s.bypassed).map((s) => s.name);
      this.asking.set({ ...a, open: open.length ? open : null });
      return;
    }
    this.asking.set(a);
  }

  close(): void {
    if (this.sending()) return;
    this.asking.set(null);
    this.entry.set('');
    this.error.set('');
  }

  sendArm(a: Extract<Ask, { kind: 'arm' }>): void {
    this.sending.set(true);
    this.error.set('');
    this.http.post<AlarmView>('/api/alarm/arm', { mode: a.mode, partitionId: a.p.id, bypass: !!a.open }).subscribe({
      next: (v) => { this.sending.set(false); this.take(v); this.asking.set(null); },
      error: (e: HttpErrorResponse) => {
        this.sending.set(false);
        if (e.status === 409 && Array.isArray(e.error?.open)) { this.asking.set({ ...a, open: e.error.open }); return; }
        this.error.set(e.error?.error ?? 'Couldn’t arm it. Use the keypad or the Alarm.com app.');
      },
    });
  }

  press(k: string, p: Partition): void {
    const len = this.view()?.pinLength ?? 4;
    if (k === '⌫') { this.entry.update((e) => e.slice(0, -1)); return; }
    if (this.entry().length >= len) return;
    this.entry.update((e) => e + k);
    if (this.entry().length === len) this.sendDisarm(p);
  }

  private sendDisarm(p: Partition): void {
    const pin = this.entry();
    this.sending.set(true);
    this.error.set('');
    this.http.post<AlarmView>('/api/alarm/disarm', { pin, partitionId: p.id }).subscribe({
      next: (v) => { this.sending.set(false); this.entry.set(''); this.take(v); this.asking.set(null); },
      error: (e: HttpErrorResponse) => {
        this.sending.set(false);
        this.entry.set('');
        const retry = Number(e.error?.retryAfterSeconds) || 0;
        if (retry) this.waitUntil.set(Date.now() + retry * 1000);
        this.error.set(e.error?.error ?? 'Couldn’t disarm it. Use the keypad or the Alarm.com app.');
      },
    });
  }

  isNotable(s: Sensor): boolean { return NOTABLE.has(s.state); }
  stateWords(state: SensorState): string { return STATE_WORDS[state] ?? state; }
  words(p: Partition): string { return ARM_WORDS[p.state]; }
  modeWords(m: Mode): string { return MODE_WORDS[m]; }
  modeHelp(m: Mode): string { return MODE_HELP[m]; }

  eventWords(e: AlarmEvent): string {
    const what = EVENT_WORDS[e.state] ?? e.state;
    if (e.kind === 'sensor') return `${e.name} ${what}`;
    if (e.source === 'app') return `${what} by ${e.userName ?? 'HomeHub'} in HomeHub${e.detail ? ` · ${e.detail}` : ''}`;
    // From Alarm.com's history: "by Keypad", "by Anna".
    if (e.detail?.startsWith('by ')) return `${what} ${e.detail}`;
    return `${what} from the keypad or Alarm.com app${e.detail ? ` · ${e.detail}` : ''}`;
  }

  when(iso: string): string {
    const d = new Date(iso);
    const now = new Date(this.now());
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (now.toDateString() === d.toDateString()) return time;
    const y = new Date(now); y.setDate(y.getDate() - 1);
    if (y.toDateString() === d.toDateString()) return `yesterday ${time}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
  }

  /** "Opened 7:12 PM · closed 7:15 PM": the last times HomeHub saw a door or window change. */
  seen(s: Sensor): string | null {
    const parts: string[] = [];
    if (s.lastOpened) parts.push(`opened ${this.when(s.lastOpened)}`);
    if (s.lastClosed) parts.push(`closed ${this.when(s.lastClosed)}`);
    if (!parts.length) return null;
    const text = parts.join(' · ');
    return text[0].toUpperCase() + text.slice(1);
  }

  ago(iso: string): string {
    const mins = Math.round((this.now() - Date.parse(iso)) / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} h ago`;
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}
