import { Component, OnDestroy, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import type { Device } from '../../../shared/models/device.model';
import { type ActivityEvent, actionWord, causeText, clock, when } from '../../../shared/activity/activity-text';
import { ThermostatControlComponent } from '../../../shared/thermostat/thermostat-control.component';
import { ThermostatService, offQuestion, summary } from '../../../shared/thermostat/thermostat.service';
import { isVacuum, vacuumDetail, vacuumNeedsHelp } from '../../../shared/vacuum';
import { AuthService } from '../../../core/auth/auth.service';

export interface OverrideRequest { device: Device; durationMinutes: number; }

@Component({
  selector: 'app-device-row',
  standalone: true,
  imports: [DecimalPipe, RouterLink, ThermostatControlComponent],
  styles: [`
    :host { display: block; border-top: 1px solid var(--border); }
    :host(:first-child) { border-top: none; }
    .row { display: flex; align-items: center; gap: 0.6rem; min-height: 3.2rem; padding: 0.25rem 0; }
    .row.offline { opacity: 0.6; }

    .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--text-muted); }
    .dot.on { background: var(--green); box-shadow: 0 0 6px var(--green); }
    .dot.offline { background: var(--red); }
    .dot.on.door { background: #f59e0b; box-shadow: 0 0 6px #f59e0b; }
    .detail.door-open { color: #fbbf24; }
    .dot.on.no-power { background: #f59e0b; box-shadow: 0 0 6px #f59e0b; }
    .detail.no-power { color: #fbbf24; }
    .no-power-help { font-size: 0.8rem; color: #fbbf24; line-height: 1.4; margin: 0; }
    .dot.help { background: #f59e0b; box-shadow: 0 0 6px #f59e0b; }
    .detail.help { color: #fbbf24; }
    .small.go { background: var(--green); border-color: var(--green); color: #04140c; font-weight: 600; }
    .small:disabled { opacity: 0.5; }
    .vac-msg { font-size: 0.78rem; margin: 0; color: var(--text-muted); }
    .vac-msg.err { color: #fbbf24; }
    .small.picked { border-color: var(--green); color: var(--green); }
    .room-name { flex: 1 1 9rem; min-width: 0; font-size: 0.85rem; padding: 0.4rem 0.6rem; }
    .link-btn { background: none; border: none; padding: 0; color: var(--accent, #60a5fa); font-size: 0.8rem; cursor: pointer; text-align: left; }

    .name {
      flex: 1; min-width: 0; padding: 0.3rem 0; background: transparent; color: var(--text);
      text-align: left; border-radius: 0;
    }
    .alias { display: block; font-size: 0.95rem; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .detail { display: block; font-size: 0.75rem; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .detail.timer { color: #93c5fd; }

    .timer-btn {
      width: 2.5rem; height: 2.5rem; padding: 0; flex-shrink: 0;
      background: transparent; color: var(--text-muted); font-size: 1rem;
    }
    .timer-btn.active { color: #60a5fa; }

    .switch {
      position: relative; width: 3.1rem; height: 2.5rem; padding: 0; flex-shrink: 0; background: transparent;
    }
    .switch::before {
      content: ''; position: absolute; left: 0.2rem; right: 0.2rem; top: 0.6rem; bottom: 0.6rem;
      border-radius: 999px; background: var(--bg); border: 1px solid var(--border); transition: background 0.15s;
    }
    .switch::after {
      content: ''; position: absolute; left: 0.45rem; top: 0.85rem; width: 0.8rem; height: 0.8rem;
      border-radius: 50%; background: var(--text-muted); transition: transform 0.15s;
    }
    .switch.on::before { background: var(--green); border-color: var(--green); }
    .switch.on::after { background: #fff; transform: translateX(1.3rem); }

    .panel { padding: 0 0 0.75rem 1.1rem; display: flex; flex-direction: column; gap: 0.55rem; }
    .panel-label { font-size: 0.75rem; color: var(--text-muted); }
    .buttons { display: flex; gap: 0.4rem; flex-wrap: wrap; align-items: center; }
    .small {
      background: var(--bg); border: 1px solid var(--border); color: var(--text);
      font-size: 0.8rem; padding: 0.4rem 0.8rem; border-radius: var(--radius);
    }
    .small.danger { background: var(--red); border-color: var(--red); color: #fff; font-weight: 600; }
    .links { display: flex; gap: 1rem; font-size: 0.8rem; flex-wrap: wrap; }
    .recent { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.78rem; color: var(--text-muted); }
    .recent b { color: var(--text); font-weight: 500; }
  `],
  template: `
    <div class="row" [class.offline]="!device().online">
      <span class="dot" [class.on]="device().online && device().state" [class.door]="isDoor()" [class.no-power]="noPower()" [class.help]="vacuumHelp()" [class.offline]="!device().online"></span>
      <button class="name" type="button" [attr.aria-expanded]="open()" (click)="togglePanel()">
        <span class="alias">{{ device().alias }}</span>
        @if (detail(); as text) { <span class="detail" [class.timer]="device().overrideUntil || autoOffText()" [class.door-open]="isDoor() && device().online && device().state && !device().overrideUntil && !autoOffText()" [class.no-power]="noPower()" [class.help]="vacuumHelp()">{{ text }}</span> }
      </button>
      <button class="timer-btn" type="button" [class.active]="device().overrideUntil || device().autoOff"
              [attr.aria-label]="'Timer for ' + device().alias" (click)="togglePanel()">⏱</button>
      <button class="switch" type="button" role="switch" [class.on]="device().state"
              [attr.aria-checked]="device().state" [attr.aria-label]="device().alias"
              [disabled]="busy() || !device().online" (click)="tapSwitch()"></button>
    </div>

    @if (confirming()) {
      <div class="panel">
        <span class="panel-label">{{ confirmQuestion() }}</span>
        <div class="buttons">
          <button class="small danger" type="button" (click)="confirm()">{{ confirmAction() }}</button>
          <button class="small" type="button" (click)="confirming.set(false)">Cancel</button>
        </div>
      </div>
    }

    @if (open()) {
      <div class="panel">
        @if (noPower()) {
          <p class="no-power-help">HomeHub has this on, but it isn't drawing any power. A wall switch on the same
            circuit may be off: flip it to turn the light on. If this keeps happening, that switch is wired
            into the light's power instead of to HomeHub's switch, and needs rewiring.</p>
        }
        @if (isThermostat()) { <app-thermostat-control [deviceId]="device().id" /> }
        @if (isVac()) {
          @if (namedRooms().length && !device().vacuum?.cleaning) {
            <span class="panel-label">Clean</span>
            <div class="buttons" role="group" aria-label="Rooms to clean">
              <button class="small" type="button" [class.picked]="!picked().length" [attr.aria-pressed]="!picked().length" (click)="picked.set([])">Whole house</button>
              @for (room of namedRooms(); track room.key) {
                <button class="small" type="button" [class.picked]="picked().includes(room.key)" [attr.aria-pressed]="picked().includes(room.key)" (click)="togglePick(room.key)">{{ room.name }}</button>
              }
            </div>
          }
          <div class="buttons">
            @if (vacuumCanStart()) {
              <button class="small go" type="button" [disabled]="busy() || vacBusy() || !device().online" (click)="vacuumStart()">{{ startLabel() }}</button>
            }
            @if (device().vacuum?.activity === 'cleaning') {
              <button class="small" type="button" [disabled]="busy() || vacBusy() || !device().online" (click)="vacuumPause()">Pause</button>
            }
            @if (vacuumCanSendHome()) {
              <button class="small" type="button" [disabled]="busy() || vacBusy() || !device().online" (click)="vacuumHome()">Send home</button>
            }
          </div>
          @if (vacError()) { <p class="vac-msg err">{{ vacError() }}</p> }
          @else if (device().vacuum?.binFull) { <p class="vac-msg err">Its bin is full. Empty it so it can clean properly.</p> }
          @else if (device().vacuum?.activity === 'stuck') { <p class="vac-msg err">It needs a hand where it stopped. The iRobot app shows where that is.</p> }
          @if (isAdmin()) {
            @for (room of unnamedRooms(); track room.key) {
              <span class="panel-label">New room seen {{ seen(room.seenAt) }}. What's it called?</span>
              <div class="buttons">
                <input class="room-name" type="text" maxlength="40" placeholder="e.g. Kitchen" [attr.list]="'vac-rooms-' + device().id"
                       [attr.aria-label]="'Name for the room seen ' + time(room.seenAt)" [value]="drafts()[room.key] ?? ''" (input)="setDraft(room.key, $event)" (keydown.enter)="saveRoom(room.key)" />
                <button class="small go" type="button" [disabled]="vacBusy() || !(drafts()[room.key] ?? '').trim()" (click)="saveRoom(room.key)">Save</button>
                <button class="small" type="button" [disabled]="vacBusy()" (click)="forgetRoom(room.key)">Forget</button>
              </div>
            }
            @if (namedRooms().length) {
              <button class="link-btn" type="button" [attr.aria-expanded]="editingRooms()" (click)="editingRooms.set(!editingRooms())">{{ editingRooms() ? 'Done' : 'Rename or forget rooms' }}</button>
              @if (editingRooms()) {
                @for (room of namedRooms(); track room.key) {
                  <div class="buttons">
                    <input class="room-name" type="text" maxlength="40" [attr.list]="'vac-rooms-' + device().id" [attr.aria-label]="'Name for ' + room.name"
                           [value]="drafts()[room.key] ?? room.name" (input)="setDraft(room.key, $event)" (keydown.enter)="saveRoom(room.key)" />
                    <button class="small" type="button" [disabled]="vacBusy() || !(drafts()[room.key] ?? '').trim() || drafts()[room.key] === room.name" (click)="saveRoom(room.key)">Rename</button>
                    <button class="small" type="button" [disabled]="vacBusy()" (click)="forgetRoom(room.key)">Forget</button>
                  </div>
                }
              }
            }
            <datalist [id]="'vac-rooms-' + device().id">
              @for (n of ROOM_NAMES; track n) { <option [value]="n"></option> }
            </datalist>
          }
          @if (!namedRooms().length && !unnamedRooms().length) {
            <p class="vac-msg">To clean single rooms from here, start a clean of one room in the iRobot app (New job, then pick one room). HomeHub learns that room and asks for its name. Do it once for each room.</p>
          } @else if (unnamedRooms().length && !isAdmin()) {
            <p class="vac-msg">The robot cleaned a room HomeHub hasn't got a name for yet. An administrator can name it here.</p>
          }
        }
        <span class="panel-label">
          {{ isVac() ? 'iRobot Roomba' + (device().model ? ' · ' + device().model : '') : (device().model ?? device().driverType) }}
          @if (device().hasEmeter && device().wattage != null) { · {{ device().wattage | number:'1.1-1' }} W }
        </span>
        @if (timerChoices().length || device().overrideUntil) {
          <span class="panel-label">{{ isDoor() ? 'Close after' : isCamera() ? (device().state ? 'Pause after' : 'Keep paused for') : isVac() ? 'Send home after' : (device().state ? 'Turn off after' : 'Keep off for') }}</span>
          <div class="buttons">
            @for (minutes of timerChoices(); track minutes) {
              <button class="small" type="button" (click)="setTimer(minutes)">{{ minutes < 60 ? minutes + ' min' : minutes / 60 + 'h' }}</button>
            }
            @if (device().overrideUntil) {
              <button class="small" type="button" (click)="overrideCancelled.emit(device())">Cancel timer</button>
            }
          </div>
        }
        @if (recent().length) {
          <span class="panel-label">Recent activity</span>
          <div class="recent">
            @for (e of recent(); track e.id) {
              <span><b>{{ time(e.at) }}</b> · {{ recentText(e) }}</span>
            }
          </div>
        }
        <div class="links">
          <a routerLink="/activity" [queryParams]="{ deviceId: device().id }">All activity</a>
          <a routerLink="/schedules" [queryParams]="{ device: device().id }">Schedules</a>
          @if (device().hasEmeter) { <a routerLink="/energy" [queryParams]="{ area: 'live' }">Energy</a> }
          @if (isCamera()) { <a routerLink="/cameras">Live view and snapshots</a> }
        </div>
      </div>
    }
  `,
})
export class DeviceRowComponent implements OnDestroy {
  device = input.required<Device>();
  busy   = input(false);
  /** Opens with its panel showing: the Rooms view's controls for one device. */
  startOpen = input(false);

  toggled           = output<Device>();
  overrideSet       = output<OverrideRequest>();
  overrideCancelled = output<Device>();

  readonly open       = signal(false);
  readonly confirming = signal(false);

  /** Garage door openers: "on" means open. */
  readonly isDoor = computed(() => this.device().driverType === 'meross');
  /** Wyze cameras: "on" means watching, "off" paused. */
  readonly isCamera = computed(() => this.device().driverType === 'wyze');
  /** Matter thermostats: "on" means heating, cooling or auto; the row also shows the temperatures. */
  readonly isThermostat = computed(() => this.device().driverConfig?.['kind'] === 'thermostat');
  /** Robot vacuums: "on" means out cleaning, "off" home on its dock. */
  readonly isVac = computed(() => isVacuum(this.device()));
  readonly vacuumHelp = computed(() => this.isVac() && this.device().online && vacuumNeedsHelp(this.device().vacuum));
  /** Docked, stopped, or paused: it can set off. Its status unknown, the switch's state decides. */
  readonly vacuumCanStart = computed(() => {
    const v = this.device().vacuum;
    return v ? ['docked', 'idle', 'paused', 'returning'].includes(v.activity) : !this.device().state;
  });
  /** Out on a job, or stopped away from its dock. */
  readonly vacuumCanSendHome = computed(() => {
    const v = this.device().vacuum;
    return v ? v.cleaning || v.activity === 'idle' : this.device().state;
  });
  readonly vacBusy = signal(false);
  readonly vacError = signal('');
  private readonly auth = inject(AuthService);
  readonly isAdmin = computed(() => this.auth.user()?.role === 'admin');
  readonly namedRooms = computed(() => (this.device().vacuumRooms ?? []).filter((r) => r.name));
  readonly unnamedRooms = computed(() => (this.device().vacuumRooms ?? []).filter((r) => !r.name));
  /** Rooms picked to clean, in the order they were picked. None is the whole house. */
  readonly picked = signal<string[]>([]);
  readonly drafts = signal<Record<string, string | undefined>>({});
  readonly editingRooms = signal(false);
  /** Suggested names: the usual rooms a robot vacuum cleans. */
  readonly ROOM_NAMES = ['Kitchen', 'Living Room', 'Family Room', 'Dining Room', 'Breakfast Room', 'Bedroom', 'Master Bedroom',
    'Bathroom', 'Master Bath', 'Hallway', 'Entryway', 'Front Door', 'Laundry Room', 'Office', 'Closet', 'Playroom', 'Basement'];
  readonly startLabel = computed(() => {
    const keys = this.picked().filter((k) => this.namedRooms().some((r) => r.key === k));
    if (keys.length === 1) return `Clean ${this.namedRooms().find((r) => r.key === keys[0])!.name}`;
    if (keys.length > 1) return `Clean ${keys.length} rooms`;
    return this.device().vacuum?.activity === 'paused' ? 'Resume' : this.namedRooms().length ? 'Clean whole house' : 'Start cleaning';
  });
  private readonly thermostats = inject(ThermostatService);
  private readonly watchThermostat = effect(() => { if (this.isThermostat()) untracked(() => this.thermostats.watch(this.device().id)); });

  /** Ticks while a turn-off is coming, so the countdown moves. */
  private readonly now = signal(Date.now());
  private ticker?: ReturnType<typeof setInterval>;

  constructor() {
    effect(() => { if (this.startOpen()) untracked(() => { this.open.set(true); this.loadRecent(); }); });
    effect(() => {
      const timed = !!this.device().autoOff?.at;
      if (timed && !this.ticker) this.ticker = setInterval(() => this.now.set(Date.now()), 1000);
      if (!timed && this.ticker) { clearInterval(this.ticker); this.ticker = undefined; }
    });
    // While the panel is open, keep Recent activity current: the device can
    // change again, or HomeHub can find it didn't do what was asked.
    effect(() => {
      const d = this.device();
      void d.state; void d.lastChange;
      if (!untracked(this.open)) return;
      clearTimeout(this.recentTimer);
      this.recentTimer = setTimeout(() => this.loadRecent(), 700);
    });
  }

  ngOnDestroy(): void {
    if (this.ticker) clearInterval(this.ticker);
    clearTimeout(this.recentTimer);
  }

  /**
   * "Off at 9:04 AM · in 17 min · schedule" within the hour, "Off at 9:30 PM
   * · timer" further off, or for a motion rule still waiting for the room to
   * empty, "On · off 10 min after motion stops". The time comes first: a
   * countdown alone hides that a 2-hour schedule started at sunrise, not now.
   */
  readonly autoOffText = computed(() => {
    const d = this.device(), a = d.autoOff;
    if (!a || !d.online || !d.state) return '';
    const cause = a.cause === 'motion' ? 'no motion' : a.cause;
    const verb = this.isDoor() ? 'Closes' : this.isCamera() ? 'Pauses' : this.isVac() ? 'Home at' : 'Off';
    if (a.at === null) return `On · off ${a.afterMinutes ?? ''} min after motion stops`.replace('  ', ' ');
    const left = Date.parse(a.at) - this.now();
    if (left <= 0) return this.isDoor() ? 'Closing…' : this.isCamera() ? 'Pausing…' : this.isVac() ? 'Going home…' : 'Turning off…';
    const at = this.isVac() ? `${verb} ${clock(a.at)}` : `${verb} at ${clock(a.at)}`;
    if (left < 60_000) return `${at} · in ${Math.ceil(left / 1000)} s · ${cause}`;
    if (left <= 60 * 60_000) return `${at} · in ${Math.ceil(left / 60_000)} min · ${cause}`;
    return `${at} · ${cause}`;
  });

  /** On, but drawing no power: a wall switch past HomeHub's has cut it. */
  readonly noPower = computed(() => { const d = this.device(); return d.online && d.state && !!d.noPower; });

  readonly detail = computed(() => {
    const device = this.device();
    if (!device.online) return 'Offline';
    if (this.noPower()) return 'On, but no power';
    const autoOff = this.autoOffText();
    if (autoOff) return autoOff;
    if (device.overrideUntil) {
      const time = new Date(device.overrideUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      if (this.isDoor()) return `${device.overrideState ? 'Closes at' : 'Closed until'} ${time}`;
      if (this.isVac()) return `${vacuumDetail(device.vacuum, device.state)} · home at ${time}`;
      return `${device.overrideState ? 'Off at' : 'Off until'} ${time}`;
    }
    if (this.isThermostat()) {
      const t = this.thermostats.views().get(device.id);
      return t ? summary(t) : '';
    }
    if (this.isVac()) return vacuumDetail(device.vacuum, device.state);
    const since = this.since();
    if (this.isDoor()) return (device.state ? 'Open' : 'Closed') + (device.state && since ? ` since ${since}` : '');
    if (this.isCamera()) return (device.state ? 'Watching' : 'Paused') + (!device.state && since ? ` since ${since}` : '');
    const watts = device.hasEmeter && device.state && device.wattage != null ? `${device.wattage.toFixed(1)} W` : '';
    if (device.state && since) return watts ? `${watts} · since ${since}` : `On since ${since}`;
    if (watts) return watts;
    return '';
  });

  readonly confirmQuestion = computed(() => {
    const d = this.device();
    if (this.isDoor()) return `${d.state ? 'Close' : 'Open'} ${d.alias}?`;
    if (this.isCamera()) return `Pause ${d.alias}? It stops watching until you resume it.`;
    if (this.isThermostat()) return offQuestion(this.thermostats.views().get(d.id), d.alias);
    return `${d.alias} is protected. Turn it ${d.state ? 'off' : 'on'}?`;
  });

  readonly confirmAction = computed(() => {
    const d = this.device();
    if (this.isDoor()) return d.state ? 'Close' : 'Open';
    if (this.isCamera()) return 'Pause';
    return `Turn ${d.state ? 'off' : 'on'}`;
  });

  /** When the device last changed to its current state, if Activity knows. */
  private readonly since = computed(() => {
    const d = this.device(), c = d.lastChange;
    return c && c.state === d.state ? when(c.at) : null;
  });

  /**
   * Timer lengths offered. A garage door is left open for minutes, not hours,
   * and holding a closed door closed means nothing, so a closed door gets none.
   */
  readonly timerChoices = computed(() => {
    if (this.isDoor()) return this.device().state ? [15, 30, 60] : [];
    // Sends it home part way through: a job runs an hour or two at most.
    if (this.isVac()) return this.device().state ? [30, 60, 120] : [];
    // A thermostat has a schedule and Away mode instead: turning the heat off after an hour isn't a timer people want.
    if (this.isThermostat()) return [];
    return [60, 120, 240];
  });

  readonly recent = signal<ActivityEvent[]>([]);
  private readonly http = inject(HttpClient);
  private recentTimer?: ReturnType<typeof setTimeout>;

  togglePanel(): void {
    this.open.update((open) => !open);
    if (this.open()) this.loadRecent();
  }

  private loadRecent(): void {
    this.http.get<ActivityEvent[]>(`/api/activity?deviceId=${this.device().id}&kind=power&limit=4`).subscribe({
      next: (list) => this.recent.set(list),
      error: () => this.recent.set([]),
    });
  }

  /** "6:35 PM" today, "Yesterday 12:30 AM", or "Nov 1, 6:12 PM": a time alone can't say which night. */
  time = (iso: string) => {
    const t = when(iso);
    // when() gives today's events as a bare time; say "Today" so every line has its day.
    if (t === clock(iso)) return `Today ${t}`;
    return t.charAt(0).toUpperCase() + t.slice(1);
  };

  /** "today 9:56 PM", "yesterday 7:10 AM", "Nov 1, 6:12 PM". */
  seen = (iso: string) => this.time(iso).replace(/^(Today|Yesterday)/, (w) => w.toLowerCase());

  recentText(e: ActivityEvent): string {
    return `${actionWord(e.driverType, e.state)} ${causeText(e)}`;
  }

  /** A compact switch is easy to hit by accident, which matters for a water valve. */
  tapSwitch(): void {
    // Resuming a camera is safe; pausing it, or switching another protected device, is confirmed.
    const resumingCamera = this.isCamera() && !this.device().state;
    // Turning a thermostat off stops all heating and cooling, so it's asked; turning it on isn't.
    const thermostatOff = this.isThermostat() && this.device().state;
    if ((this.device().isProtected && !resumingCamera) || thermostatOff) this.confirming.set(true);
    else this.toggled.emit(this.device());
  }

  /** Start the picked rooms; or the whole house, or carry on with a paused job: the device's "on". */
  vacuumStart(): void {
    this.vacError.set('');
    const keys = this.picked().filter((k) => this.namedRooms().some((r) => r.key === k));
    if (!keys.length) { this.toggled.emit({ ...this.device(), state: false }); return; }
    this.vacBusy.set(true);
    this.http.post(`/api/roomba/${this.device().id}/clean`, { rooms: keys }).subscribe({
      next: () => { this.vacBusy.set(false); this.picked.set([]); },
      error: (e) => { this.vacBusy.set(false); this.vacError.set(e?.error?.error ?? 'Couldn’t start it.'); },
    });
  }

  togglePick(key: string): void {
    this.picked.update((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  }

  setDraft(key: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.drafts.update((d) => ({ ...d, [key]: value }));
  }

  saveRoom(key: string): void {
    const name = (this.drafts()[key] ?? '').trim();
    if (!name) return;
    this.vacError.set('');
    this.vacBusy.set(true);
    this.http.put(`/api/roomba/${this.device().id}/rooms`, { key, name }).subscribe({
      next: () => { this.vacBusy.set(false); this.drafts.update((d) => { const { [key]: _gone, ...rest } = d; return rest; }); },
      error: (e) => { this.vacBusy.set(false); this.vacError.set(e?.error?.error ?? 'Couldn’t save the name.'); },
    });
  }

  forgetRoom(key: string): void {
    this.vacError.set('');
    this.vacBusy.set(true);
    this.http.post(`/api/roomba/${this.device().id}/rooms/remove`, { key }).subscribe({
      next: () => { this.vacBusy.set(false); this.picked.update((p) => p.filter((k) => k !== key)); },
      error: (e) => { this.vacBusy.set(false); this.vacError.set(e?.error?.error ?? 'Couldn’t forget the room.'); },
    });
  }

  /** Back to its dock: the device's "off". */
  vacuumHome(): void {
    this.vacError.set('');
    this.toggled.emit({ ...this.device(), state: true });
  }

  vacuumPause(): void {
    this.vacError.set('');
    this.vacBusy.set(true);
    this.http.post(`/api/roomba/${this.device().id}/pause`, {}).subscribe({
      next: () => this.vacBusy.set(false),
      error: (e) => { this.vacBusy.set(false); this.vacError.set(e?.error?.error ?? 'Couldn’t pause it.'); },
    });
  }

  confirm(): void {
    this.confirming.set(false);
    this.toggled.emit(this.device());
  }

  setTimer(durationMinutes: number): void {
    this.overrideSet.emit({ device: this.device(), durationMinutes });
    this.open.set(false);
  }
}
