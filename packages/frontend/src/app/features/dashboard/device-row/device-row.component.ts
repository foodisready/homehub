import { Component, computed, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import type { Device } from '../../../shared/models/device.model';

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
    .links { display: flex; gap: 1rem; font-size: 0.8rem; }
  `],
  template: `
    <div class="row" [class.offline]="!device().online">
      <span class="dot" [class.on]="device().online && device().state" [class.door]="isDoor()" [class.offline]="!device().online"></span>
      <button class="name" type="button" [attr.aria-expanded]="open()" (click)="togglePanel()">
        <span class="alias">{{ device().alias }}</span>
        @if (detail(); as text) { <span class="detail" [class.timer]="device().overrideUntil" [class.door-open]="isDoor() && device().online && device().state && !device().overrideUntil">{{ text }}</span> }
      </button>
      <button class="timer-btn" type="button" [class.active]="device().overrideUntil"
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
        <span class="panel-label">{{ isDoor() ? (device().state ? 'Close after' : 'Keep closed for') : (device().state ? 'Turn off after' : 'Keep off for') }}</span>
        <div class="buttons">
          @for (hours of [1, 2, 4]; track hours) {
            <button class="small" type="button" (click)="setTimer(hours * 60)">{{ hours }}h</button>
          }
          @if (device().overrideUntil) {
            <button class="small" type="button" (click)="overrideCancelled.emit(device())">Cancel timer</button>
          }
        </div>
        <div class="links">
          <a routerLink="/schedules">Schedules</a>
          @if (device().hasEmeter) { <a routerLink="/energy">Energy</a> }
        </div>
      </div>
    }
  `,
})
export class DeviceRowComponent {
  device = input.required<Device>();
  busy   = input(false);

  toggled           = output<Device>();
  overrideSet       = output<OverrideRequest>();
  overrideCancelled = output<Device>();

  readonly open       = signal(false);
  readonly confirming = signal(false);

  /** Garage door openers: "on" means open. */
  readonly isDoor = computed(() => this.device().driverType === 'meross');

  readonly detail = computed(() => {
    const device = this.device();
    if (!device.online) return 'Offline';
    if (device.overrideUntil) {
      const time = new Date(device.overrideUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      if (this.isDoor()) return `${device.overrideState ? 'Closes at' : 'Closed until'} ${time}`;
      return `${device.overrideState ? 'Off at' : 'Off until'} ${time}`;
    }
    if (this.isDoor()) return device.state ? 'Open' : 'Closed';
    if (device.hasEmeter && device.state && device.wattage != null) return `${device.wattage.toFixed(1)} W`;
    return '';
  });

  readonly confirmQuestion = computed(() => {
    const d = this.device();
    if (this.isDoor()) return `${d.state ? 'Close' : 'Open'} ${d.alias}?`;
    return `${d.alias} is protected. Turn it ${d.state ? 'off' : 'on'}?`;
  });

  readonly confirmAction = computed(() => {
    const d = this.device();
    if (this.isDoor()) return d.state ? 'Close' : 'Open';
    return `Turn ${d.state ? 'off' : 'on'}`;
  });

  togglePanel(): void {
    this.open.update((open) => !open);
  }

  /** A compact switch is easy to hit by accident, which matters for a water valve. */
  tapSwitch(): void {
    if (this.device().isProtected) this.confirming.set(true);
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
