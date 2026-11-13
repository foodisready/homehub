import { Component, ElementRef, HostListener, computed, input, model, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Device } from '../models/device.model';

export type DeviceFilter = 'all' | 'on' | 'offline';

const BRAND_NAMES: Record<string, string> = {
  kasa: 'Kasa', tuya: 'Tuya', shelly: 'Shelly', matter: 'Matter', meross: 'Meross', wyze: 'Wyze',
};

/** The brand a device's driver stands for, as people know it: kasa → Kasa. */
export function brandOf(device: Pick<Device, 'driverType'>): string {
  const t = device.driverType ?? '';
  return BRAND_NAMES[t] ?? (t ? t[0].toUpperCase() + t.slice(1) : 'Other');
}

/**
 * Searches names, nicknames, rooms and brands, so any word someone would use
 * finds a device. `brand` keeps one brand, as brandOf names it.
 */
export function matchesDevice(device: Device, search: string, filter: DeviceFilter, brand = 'all'): boolean {
  if (filter === 'on' && !(device.online && device.state)) return false;
  if (filter === 'offline' && device.online) return false;
  if (brand !== 'all' && brandOf(device) !== brand) return false;

  const wanted = search.trim().toLowerCase();
  if (!wanted) return true;
  return [device.alias, device.room ?? '', brandOf(device), ...device.nicknames]
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
    .chips.brands { margin-top: 0.5rem; }
    .chip {
      background: transparent; border: 1px solid var(--border); border-radius: 999px;
      color: var(--text-muted); font-size: 0.8rem; padding: 0.35rem 0.85rem;
    }
    .chip.active { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
    /* "On 2": green while something is on, unless it's the selected filter. */
    .chip.lit:not(.active) { border-color: var(--green); color: #4ade80; font-weight: 600; }
  `],
  template: `
    <div class="search">
      <input #box class="own-clear" type="search" [ngModel]="search()" (ngModelChange)="search.set($event)"
             placeholder="Search devices or rooms" aria-label="Search devices" autocomplete="off" />
      @if (search()) {
        <button class="clear" type="button" aria-label="Clear search" (click)="search.set('')">✕</button>
      }
    </div>
    <div class="chips" role="group" aria-label="Filter devices">
      @for (option of options(); track option.value) {
        <button class="chip" type="button" [class.active]="filter() === option.value"
                [class.lit]="option.value === 'on' && option.count > 0"
                [attr.aria-pressed]="filter() === option.value" (click)="filter.set(option.value)">
          {{ option.label }} {{ option.count }}
        </button>
      }
    </div>
    @if (brandOptions(); as brands) {
      <div class="chips brands" role="group" aria-label="Show devices by brand">
        @for (option of brands; track option.value) {
          <button class="chip" type="button" [class.active]="brand() === option.value"
                  [attr.aria-pressed]="brand() === option.value" (click)="brand.set(option.value)">
            {{ option.label }} {{ option.count }}
          </button>
        }
      </div>
    }
  `,
})
export class DeviceFilterComponent {
  devices = input.required<Device[]>();
  search  = model('');
  filter  = model<DeviceFilter>('all');
  /** Brand buttons, for Settings, where devices get fixed a brand at a time. */
  showBrands = input(false);
  brand   = model('all');

  private box = viewChild.required<ElementRef<HTMLInputElement>>('box');

  readonly options = computed(() => {
    const devices = this.devices();
    return [
      { value: 'all' as const,     label: 'All',     count: devices.length },
      { value: 'on' as const,      label: 'On',      count: devices.filter((d) => d.online && d.state).length },
      { value: 'offline' as const, label: 'Offline', count: devices.filter((d) => !d.online).length },
    ];
  });

  /** All, then each brand by name, only when there's more than one brand. */
  readonly brandOptions = computed(() => {
    if (!this.showBrands()) return null;
    const counts = new Map<string, number>();
    for (const d of this.devices()) counts.set(brandOf(d), (counts.get(brandOf(d)) ?? 0) + 1);
    if (counts.size < 2) return null;
    return [
      { value: 'all', label: 'All brands', count: this.devices().length },
      ...[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ value: name, label: name, count })),
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
