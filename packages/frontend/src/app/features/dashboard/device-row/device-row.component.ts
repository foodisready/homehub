import { Component, OnDestroy, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import type { Device } from '../../../shared/models/device.model';
import { type ActivityEvent, actionWord, causeText, clock, when } from '../../../shared/activity/activity-text';

export interface OverrideRequest { device: Device; durationMinutes: number; }

@Component({
  selector: 'app-device-row',
  standalone: true,
  imports: [DecimalPipe, RouterLink],
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
      <span class="dot" [class.on]="device().online && device().state" [class.door]="isDoor()" [class.offline]="!device().online"></span>
      <button class="name" type="button" [attr.aria-expanded]="open()" (click)="togglePanel()">
        <span class="alias">{{ device().alias }}</span>
        @if (detail(); as text) { <span class="detail" [class.timer]="device().overrideUntil || autoOffText()" [class.door-open]="isDoor() && device().online && device().state && !device().overrideUntil && !autoOffText()">{{ text }}</span> }
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
        <span class="panel-label">
          {{ device().model ?? device().driverType }}
          @if (device().hasEmeter && device().wattage != null) { · {{ device().wattage | number:'1.1-1' }} W }
        </span>
        @if (timerChoices().length || device().overrideUntil) {
          <span class="panel-label">{{ isDoor() ? 'Close after' : isCamera() ? (device().state ? 'Pause after' : 'Keep paused for') : (device().state ? 'Turn off after' : 'Keep off for') }}</span>
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
          <a routerLink="/schedules">Schedules</a>
          @if (device().hasEmeter) { <a routerLink="/energy">Energy</a> }
          @if (isCamera()) { <a routerLink="/cameras">Live view and snapshots</a> }
        </div>
      </div>
    }
  `,
})
export class DeviceRowComponent implements OnDestroy {
  device = input.required<Device>();
  busy   = input(false);

  toggled           = output<Device>();
  overrideSet       = output<OverrideRequest>();
  overrideCancelled = output<Device>();

  readonly open       = signal(false);
  readonly confirming = signal(false);

  /** Garage door openers: "on" means open. */
  readonly isDoor = computed(() => this.device().driverType === 'meross');
  /** Wyze cameras: "on" means watching, "off" paused. */
  readonly isCamera = computed(() => this.device().driverType === 'wyze');

  /** Ticks while a turn-off is coming, so the countdown moves. */
  private readonly now = signal(Date.now());
  private ticker?: ReturnType<typeof setInterval>;

  constructor() {
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
    const verb = this.isDoor() ? 'Closes' : this.isCamera() ? 'Pauses' : 'Off';
    if (a.at === null) return `On · off ${a.afterMinutes ?? ''} min after motion stops`.replace('  ', ' ');
    const left = Date.parse(a.at) - this.now();
    if (left <= 0) return this.isDoor() ? 'Closing…' : this.isCamera() ? 'Pausing…' : 'Turning off…';
    const at = `${verb} at ${clock(a.at)}`;
    if (left < 60_000) return `${at} · in ${Math.ceil(left / 1000)} s · ${cause}`;
    if (left <= 60 * 60_000) return `${at} · in ${Math.ceil(left / 60_000)} min · ${cause}`;
    return `${at} · ${cause}`;
  });

  readonly detail = computed(() => {
    const device = this.device();
    if (!device.online) return 'Offline';
    const autoOff = this.autoOffText();
    if (autoOff) return autoOff;
    if (device.overrideUntil) {
      const time = new Date(device.overrideUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      if (this.isDoor()) return `${device.overrideState ? 'Closes at' : 'Closed until'} ${time}`;
      return `${device.overrideState ? 'Off at' : 'Off until'} ${time}`;
    }
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

  recentText(e: ActivityEvent): string {
    return `${actionWord(e.driverType, e.state)} ${causeText(e)}`;
  }

  /** A compact switch is easy to hit by accident, which matters for a water valve. */
  tapSwitch(): void {
    // Resuming a camera is safe; pausing it, or switching another protected device, is confirmed.
    const resumingCamera = this.isCamera() && !this.device().state;
    if (this.device().isProtected && !resumingCamera) this.confirming.set(true);
    else this.toggled.emit(this.device());
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
