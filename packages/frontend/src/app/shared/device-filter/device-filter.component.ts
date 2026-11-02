import { Component, ElementRef, HostListener, computed, input, model, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Device } from '../models/device.model';

export type DeviceFilter = 'all' | 'on' | 'offline';

/** Searches names, nicknames and rooms, so any word someone would use finds a device. */
export function matchesDevice(device: Device, search: string, filter: DeviceFilter): boolean {
  if (filter === 'on' && !(device.online && device.state)) return false;
  if (filter === 'offline' && device.online) return false;

  const wanted = search.trim().toLowerCase();
  if (!wanted) return true;
  return [device.alias, device.room ?? '', ...device.nicknames]
    .some((name) => name.toLowerCase().includes(wanted));
}

@Component({
  selector: 'app-device-filter',
  standalone: true,
  imports: [FormsModule],
  styles: [`
    :host { display: block; }
    .search { position: relative; margin-bottom: 0.6rem; }
    .search input { padding-right: 2.4rem; }
    .clear {
      position: absolute; right: 0.3rem; top: 50%; transform: translateY(-50%);
      width: 2rem; height: 2rem; padding: 0; background: transparent; color: var(--text-muted);
    }
    .chips { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .chip {
      background: transparent; border: 1px solid var(--border); border-radius: 999px;
      color: var(--text-muted); font-size: 0.8rem; padding: 0.35rem 0.85rem;
    }
    .chip.active { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  `],
  template: `
    <div class="search">
      <input #box type="search" [ngModel]="search()" (ngModelChange)="search.set($event)"
             placeholder="Search devices or rooms" aria-label="Search devices" autocomplete="off" />
      @if (search()) {
        <button class="clear" type="button" aria-label="Clear search" (click)="search.set('')">✕</button>
      }
    </div>
    <div class="chips" role="group" aria-label="Filter devices">
      @for (option of options(); track option.value) {
        <button class="chip" type="button" [class.active]="filter() === option.value"
                [attr.aria-pressed]="filter() === option.value" (click)="filter.set(option.value)">
          {{ option.label }} {{ option.count }}
        </button>
      }
    </div>
  `,
})
export class DeviceFilterComponent {
  devices = input.required<Device[]>();
  search  = model('');
  filter  = model<DeviceFilter>('all');

  private box = viewChild.required<ElementRef<HTMLInputElement>>('box');

  readonly options = computed(() => {
    const devices = this.devices();
    return [
      { value: 'all' as const,     label: 'All',     count: devices.length },
      { value: 'on' as const,      label: 'On',      count: devices.filter((d) => d.online && d.state).length },
      { value: 'offline' as const, label: 'Offline', count: devices.filter((d) => !d.online).length },
    ];
  });

  /** Pressing "/" jumps to search, unless someone is already typing. */
  @HostListener('document:keydown', ['$event'])
  focusSearch(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (event.key !== '/' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    event.preventDefault();
    this.box().nativeElement.focus();
  }
}
