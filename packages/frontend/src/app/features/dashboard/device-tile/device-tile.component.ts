import { Component, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Device } from '../../../shared/models/device.model';

export interface OverrideRequest { device: Device; durationMinutes: number; }

@Component({
  selector: 'app-device-tile',
  standalone: true,
  imports: [DecimalPipe],
  styles: [`
    .tile {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      transition: border-color 0.2s;
    }
    .tile.on  { border-color: var(--green); }
    .tile.off { border-color: var(--border); }
    .tile.offline { opacity: 0.55; }

    .tile-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }
    .alias {
      font-weight: 600;
      font-size: 1rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tile-header-right { display: flex; align-items: center; gap: 0.35rem; }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .status-dot.online-on  { background: var(--green); box-shadow: 0 0 6px var(--green); }
    .status-dot.online-off { background: var(--text-muted); }
    .status-dot.offline    { background: var(--red); }

    .override-btn {
      background: transparent;
      border: none;
      font-size: 0.85rem;
      padding: 0.1rem 0.15rem;
      color: var(--text-muted);
      cursor: pointer;
      line-height: 1;
      border-radius: 3px;
      flex-shrink: 0;
    }
    .override-btn:hover { color: var(--text); background: var(--surface); }
    .override-btn.has-override { color: #60a5fa; }

    .override-badge {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(59, 130, 246, 0.12);
      border: 1px solid rgba(59, 130, 246, 0.3);
      border-radius: var(--radius);
      padding: 0.2rem 0.5rem 0.2rem 0.6rem;
      font-size: 0.72rem;
      color: #93c5fd;
      gap: 0.4rem;
    }
    .override-cancel {
      background: none;
      border: none;
      color: #93c5fd;
      cursor: pointer;
      font-size: 0.9rem;
      padding: 0;
      line-height: 1;
      flex-shrink: 0;
    }
    .override-cancel:hover { color: #fff; }

    .override-panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 0.5rem 0.6rem;
    }
    .override-panel-label {
      display: block;
      font-size: 0.72rem;
      color: var(--text-muted);
      margin-bottom: 0.4rem;
    }
    .override-durations { display: flex; gap: 0.4rem; }
    .override-dur-btn {
      flex: 1;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 0.3rem 0;
      font-size: 0.8rem;
      border-radius: var(--radius);
      cursor: pointer;
    }
    .override-dur-btn:hover { background: var(--border); }

    .meta {
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .wattage {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--text);
    }

    .toggle {
      width: 100%;
      padding: 0.55rem;
      font-weight: 600;
      font-size: 0.9rem;
    }
    .toggle.on  { background: var(--green);   color: #000; }
    .toggle.off { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
    .toggle.on:hover:not(:disabled)  { background: #16a34a; }
    .toggle.off:hover:not(:disabled) { background: var(--border); }
  `],
  template: `
    <div class="card tile" [class.on]="device().state && device().online"
                            [class.off]="!device().state"
                            [class.offline]="!device().online">
      <div class="tile-header">
        <span class="alias" [title]="device().alias">{{ device().alias }}</span>
        <div class="tile-header-right">
          <button
            class="override-btn"
            [class.has-override]="device().overrideUntil"
            [title]="device().overrideUntil ? 'Override active — click to change' : 'Override schedule'"
            (click)="togglePanel(); $event.stopPropagation()">⏱</button>
          <span class="status-dot"
                [class.online-on]="device().online && device().state"
                [class.online-off]="device().online && !device().state"
                [class.offline]="!device().online">
          </span>
        </div>
      </div>

      @if (device().overrideUntil) {
        <div class="override-badge">
          <span>Override · until {{ formatUntil(device().overrideUntil!) }}</span>
          <button class="override-cancel" title="Cancel override" (click)="overrideCancelled.emit(device())">×</button>
        </div>
      }

      @if (showPanel()) {
        <div class="override-panel">
          <span class="override-panel-label">
            Keep {{ device().state ? 'ON' : 'OFF' }} for:
          </span>
          <div class="override-durations">
            <button class="override-dur-btn" (click)="emitOverride(60)">1h</button>
            <button class="override-dur-btn" (click)="emitOverride(120)">2h</button>
            <button class="override-dur-btn" (click)="emitOverride(240)">4h</button>
          </div>
        </div>
      }

      @if (device().hasEmeter && device().state && device().wattage != null) {
        <div class="wattage">{{ device().wattage | number:'1.1-1' }} W</div>
      } @else {
        <div class="meta">
          {{ !device().online ? 'Offline' : (device().state ? 'On' : 'Off') }}
          @if (device().model) { · {{ device().model }} }
        </div>
      }

      <button
        class="toggle"
        [class.on]="device().state"
        [class.off]="!device().state"
        [disabled]="busy()"
        (click)="toggled.emit(device())">
        {{ device().state ? 'Turn Off' : 'Turn On' }}
      </button>
    </div>
  `,
})
export class DeviceTileComponent {
  device  = input.required<Device>();
  busy    = input<boolean>(false);

  toggled          = output<Device>();
  overrideSet      = output<OverrideRequest>();
  overrideCancelled = output<Device>();

  readonly showPanel = signal(false);

  togglePanel(): void {
    this.showPanel.update((v) => !v);
  }

  emitOverride(durationMinutes: number): void {
    this.overrideSet.emit({ device: this.device(), durationMinutes });
    this.showPanel.set(false);
  }

  formatUntil(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
