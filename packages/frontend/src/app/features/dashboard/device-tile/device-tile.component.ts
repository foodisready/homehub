import { Component, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Device } from '../../../shared/models/device.model';

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
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .status-dot.online-on  { background: var(--green); box-shadow: 0 0 6px var(--green); }
    .status-dot.online-off { background: var(--text-muted); }
    .status-dot.offline    { background: var(--red); }

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
        <span class="status-dot"
              [class.online-on]="device().online && device().state"
              [class.online-off]="device().online && !device().state"
              [class.offline]="!device().online">
        </span>
      </div>

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
  device = input.required<Device>();
  busy   = input<boolean>(false);
  toggled = output<Device>();
}
