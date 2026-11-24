import { Component, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { AuthService } from '../../core/auth/auth.service';
import { SocketService, DeviceStateEvent, DeviceOnlineEvent, DeviceOverrideEvent } from '../../core/socket/socket.service';
import { DeviceRowComponent, OverrideRequest } from './device-row/device-row.component';
import { DeviceFilterComponent, matchesDevice, type DeviceFilter } from '../../shared/device-filter/device-filter.component';
import { SystemStatusComponent } from './system-status.component';
import { HomeSetupNoticeComponent } from './home-setup-notice.component';
import { CamerasCardComponent } from './cameras-card.component';
import { AlarmCardComponent } from './alarm-card.component';
import { AwayComponent } from './away.component';
import { RoomsViewComponent } from './rooms-view.component';
import { WallFrameComponent } from './wall-frame.component';
import { Device } from '../../shared/models/device.model';
import { isVacuum } from '../../shared/vacuum';

const COLLAPSED_KEY = 'homehub.dashboard.collapsed';
const VIEW_KEY = 'homehub.dashboard.view';

function loadView(): 'rooms' | 'list' {
  try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'rooms'; } catch { return 'rooms'; }
}
const OFFLINE = 'Offline';
const UNASSIGNED = 'Unassigned';

interface DeviceSection {
  name: string;
  devices: Device[];
  count: string;
  canTurnOff: boolean;
  /** Something in the room is on, which tints the card green. */
  anyOn: boolean;
}

function loadCollapsed(): Set<string> {
  try {
    const saved = localStorage.getItem(COLLAPSED_KEY);
    if (saved) return new Set(JSON.parse(saved) as string[]);
  } catch { /* storage can be unavailable, so use the default */ }
  return new Set([OFFLINE]);
}

/**
 * A state change just arrived: keep "since" right without reloading. The
 * cause isn't sent with the change, and the row only shows the time.
 */
function changed(d: Device, state: boolean): Device['lastChange'] {
  if (d.state === state && d.lastChange) return d.lastChange;
  return { state, source: 'homehub', detail: null, via: null, userName: null, at: new Date().toISOString() };
}

/** A thermostat: "All off" leaves it alone. */
const isThermostat = (d: Device) => d.driverConfig?.['kind'] === 'thermostat';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [DeviceRowComponent, RoomsViewComponent, DeviceFilterComponent, SystemStatusComponent, HomeSetupNoticeComponent, CamerasCardComponent, AlarmCardComponent, AwayComponent, DecimalPipe, WallFrameComponent],
  styles: [`
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 0.75rem 1rem;
      margin-bottom: 1.5rem;
    }
    .topbar h1 { font-size: 1.4rem; font-weight: 700; }
    @media (min-width: 900px) { .topbar { display: none; } }
    .topbar-right { display: flex; align-items: center; flex-wrap: wrap; gap: 0.6rem 1rem; }

    app-device-filter { margin-bottom: 1rem; }
    .view-bar { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
    .view-bar .total { margin: 0; }
    .seg { display: inline-flex; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: 3px; margin-left: auto; }
    .seg button { border: 0; background: none; color: var(--text-muted); padding: 0.3rem 0.9rem; border-radius: 999px; font-size: 0.82rem; }
    .seg button[aria-pressed="true"] { background: var(--accent); color: #fff; font-weight: 600; }
    .total { color: var(--text-muted); font-size: 0.8rem; margin-bottom: 0.75rem; }

    .rooms {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr));
      gap: 0.75rem;
      align-items: start;
    }
    .room { padding: 0.35rem 1rem; }
    .room-head { display: flex; align-items: center; gap: 0.5rem; min-height: 2.8rem; }
    .room-toggle {
      flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 0.5rem;
      padding: 0.4rem 0; background: transparent; color: var(--text); text-align: left;
    }
    .chevron { color: var(--text-muted); font-size: 0.75rem; transition: transform 0.15s; }
    .chevron.closed { transform: rotate(-90deg); }
    .room-name { font-weight: 700; font-size: 0.95rem; }
    .room-count { color: var(--text-muted); font-size: 0.78rem; white-space: nowrap; }
    /* A room with something on: green edge and count, so it stands out even when folded. */
    .room.lit { box-shadow: inset 3px 0 0 var(--green); }
    .room.lit .room-count { color: #4ade80; font-weight: 600; }
    .all-off {
      background: transparent; border: 1px solid var(--border); color: var(--text-muted);
      font-size: 0.75rem; padding: 0.3rem 0.65rem; flex-shrink: 0;
    }
    .all-off:hover:not(:disabled) { color: var(--text); }
    /* Outlined, not filled: a solid green button would read as "turn on". */
    .room.lit .all-off { border-color: var(--green); color: #4ade80; }
    .room.lit .all-off:hover:not(:disabled) { background: rgba(34, 197, 94, 0.12); color: #86efac; }

    .empty {
      text-align: center;
      padding: 3rem 1rem;
      color: var(--text-muted);
    }
    .empty p { margin-top: 0.5rem; font-size: 0.9rem; }

    .loading { color: var(--text-muted); padding: 2rem 0; text-align: center; }
  `],
  template: `
    @if (wall) {
      <!-- The wall display (/wall): the rooms, with a clock, weather, Coming up and scenes above. -->
      <app-wall-frame>
        <app-alarm-card />
        @if (loading()) { <div class="loading">Loading devices…</div> }
        @else {
          <app-rooms-view [devices]="devices()" [busyIds]="busyIds()"
                          (toggled)="toggle($event)" (overrideSet)="setOverride($event)"
                          (overrideCancelled)="cancelOverride($event)" (allOff)="allOff($event)" (roomOpened)="checkDevices($event)" />
        }
      </app-wall-frame>
    } @else {
    <div class="page">

      <!-- On wider screens the app's top bar shows the name instead -->
      <div class="topbar">
        <h1>HomeHub</h1>
      </div>

      <!-- HomeHub self-update card (shows when an upstream release is available) -->
      <app-system-status />
      <app-home-setup-notice />
      <!-- Away mode: a button when off, a banner while on -->
      <app-away />
      <!-- The alarm, read from Alarm.com, once signed in -->
      <app-alarm-card />
      <!-- Every camera, Ring and IP included, which aren't device rows -->
      <app-cameras-card />

      @if (loading()) {
        <div class="loading">Loading devices…</div>
      } @else if (devices().length === 0) {
        <div class="empty">
          <strong>No devices yet</strong>
          <p>Add a Kasa plug by IP in Settings, or run discovery.</p>
        </div>
      } @else {
        <app-device-filter [devices]="devices()" [(search)]="search" [(filter)]="filter" />
        <div class="view-bar">
          @if (totalWattage() > 0) { <div class="total">{{ totalWattage() | number:'1.1-1' }} W in use</div> }
          <div class="seg" role="group" aria-label="Show devices as">
            <button type="button" [attr.aria-pressed]="view() === 'rooms'" (click)="setView('rooms')">Rooms</button>
            <button type="button" [attr.aria-pressed]="view() === 'list'" (click)="setView('list')">List</button>
          </div>
        </div>

        @if (view() === 'rooms') {
          <app-rooms-view [devices]="roomDevices()" [busyIds]="busyIds()"
                          (toggled)="toggle($event)" (overrideSet)="setOverride($event)"
                          (overrideCancelled)="cancelOverride($event)" (allOff)="allOff($event)" (roomOpened)="checkDevices($event)" />
        } @else {
        <div class="rooms">
          @for (section of sections(); track section.name) {
            <section class="card room" [class.lit]="section.anyOn">
              <div class="room-head">
                <button class="room-toggle" type="button" [attr.aria-expanded]="isOpen(section.name)"
                        (click)="toggleSection(section.name)">
                  <span class="chevron" [class.closed]="!isOpen(section.name)">▼</span>
                  <span class="room-name">{{ section.name }}</span>
                  <span class="room-count">{{ section.count }}</span>
                </button>
                @if (section.canTurnOff) {
                  <button class="all-off" type="button" (click)="allOff(section.devices)">All off</button>
                }
              </div>
              @if (isOpen(section.name)) {
                @for (device of section.devices; track device.id) {
                  <app-device-row
                    [device]="device"
                    [busy]="busyIds().has(device.id)"
                    (toggled)="toggle($event)"
                    (overrideSet)="setOverride($event)"
                    (overrideCancelled)="cancelOverride($event)" />
                }
              }
            </section>
          } @empty {
            <div class="empty">No devices match.</div>
          }
        </div>
        }
      }

    </div>
    }
  `,
})
export class DashboardComponent implements OnInit, OnDestroy {

  private readonly _devices  = signal<Device[]>([]);
  private readonly _busyIds  = signal<Set<number>>(new Set());
  private readonly _loading  = signal(true);

  readonly devices     = this._devices.asReadonly();
  readonly busyIds     = this._busyIds.asReadonly();
  readonly loading     = this._loading.asReadonly();
  readonly search = signal('');
  readonly filter = signal<DeviceFilter>('all');
  private readonly collapsed = signal(loadCollapsed());
  /** Rooms (tiles, and a room's devices as bubbles) or the list. */
  readonly view = signal(loadView());

  setView(v: 'rooms' | 'list'): void {
    this.view.set(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* the choice lasts this visit */ }
  }

  /** What the Rooms view shows: the search and filter's matches, offline ones in their own rooms. */
  readonly roomDevices = computed(() => this._devices().filter((d) => matchesDevice(d, this.search(), this.filter())));

  /** Rooms in name order, then devices with no room, then offline devices. */
  readonly sections = computed<DeviceSection[]>(() => {
    const matching = this._devices()
      .filter((d) => matchesDevice(d, this.search(), this.filter()))
      .sort((a, b) => a.alias.localeCompare(b.alias));

    const rooms = new Map<string, Device[]>();
    for (const device of matching.filter((d) => d.online)) {
      const room = device.room ?? UNASSIGNED;
      rooms.set(room, [...(rooms.get(room) ?? []), device]);
    }
    const names = [...rooms.keys()].sort((a, b) =>
      Number(a === UNASSIGNED) - Number(b === UNASSIGNED) || a.localeCompare(b));

    const sections = names.map((name) => {
      const devices = rooms.get(name)!;
      const on = devices.filter((d) => d.state).length;
      return {
        name,
        devices,
        count: `${on} of ${devices.length} on`,
        // "All off" is for lights and plugs: it leaves thermostats alone, so it never cuts the heat.
        canTurnOff: devices.some((d) => d.state && !d.isProtected && !isThermostat(d) && !isVacuum(d)),
        anyOn: on > 0,
      };
    });

    const offline = matching.filter((d) => !d.online);
    if (offline.length) {
      sections.push({ name: OFFLINE, devices: offline, count: String(offline.length), canTurnOff: false, anyOn: false });
    }
    return sections;
  });

  readonly totalWattage = computed(() =>
    this._devices().reduce((sum, d) => sum + (d.wattage ?? 0), 0)
  );

  private unsubState?:  () => void;
  private unsubOnline?: () => void;
  private unsubNoPower?: () => void;
  private unsubVacuum?: () => void;
  private unsubVacuumRooms?: () => void;
  private unsubOverride?: () => void;
  private unsubMotion?: () => void;
  private unsubReconnect?: () => void;
  private autoOffTimer?: ReturnType<typeof setTimeout>;
  private autoOffInterval?: ReturnType<typeof setInterval>;

  /** On /wall: the wall display, the same rooms with a clock and more above. */
  readonly wall: boolean;

  constructor(
    readonly auth:   AuthService,
    private http:    HttpClient,
    private socket:  SocketService,
    private router:  Router,
    route:           ActivatedRoute,
  ) {
    this.wall = route.snapshot.data['wall'] === true;
  }

  ngOnInit(): void {
    this.catchUp();
    this.subscribeSocket();
    // Schedules and motion rules can start a countdown on their own.
    this.autoOffInterval = setInterval(() => { if (!document.hidden) this.refreshAutoOff(0); }, 60_000);
    // A phone browser pauses a page in the background and drops its live
    // updates, so a timer that ended meanwhile would still show. Catch up.
    this.unsubReconnect = this.socket.onReconnect(() => this.catchUp());
    document.addEventListener('visibilitychange', this.onVisible);
  }

  private readonly onVisible = () => { if (!document.hidden) this.catchUp(); };

  /**
   * Back on screen: show what HomeHub last saw at once, then ask it to read every device now and
   * show that, so a door opened while the phone was in a pocket doesn't wait for the next check.
   */
  private catchUp(): void {
    this.loadDevices(() => this.refreshAutoOff(0));
    this.checkDevices();
  }

  /** Ask HomeHub to read these devices (all, if none) now, then show what it found. */
  checkDevices(ids?: number[]): void {
    this.http.post('/api/devices/check', ids ? { ids } : {}).subscribe({ next: () => this.loadDevices(), error: () => undefined });
  }

  ngOnDestroy(): void {
    this.unsubState?.();
    this.unsubOnline?.();
    this.unsubNoPower?.();
    this.unsubVacuum?.();
    this.unsubVacuumRooms?.();
    this.unsubOverride?.();
    this.unsubMotion?.();
    this.unsubReconnect?.();
    document.removeEventListener('visibilitychange', this.onVisible);
    clearTimeout(this.autoOffTimer);
    clearInterval(this.autoOffInterval);
  }

  /**
   * Turn-off times move when a device switches, a timer is set or a motion
   * sensor reports. Several often arrive together, so wait a moment.
   */
  private refreshAutoOff(delayMs = 600): void {
    clearTimeout(this.autoOffTimer);
    this.autoOffTimer = setTimeout(() => {
      this.http.get<Record<string, Device['autoOff']>>('/api/devices/auto-off').subscribe({
        next: (map) => this._devices.update((list) => list.map((d) => ({ ...d, autoOff: map[d.id] ?? null }))),
        error: () => undefined,
      });
    }, delayMs);
  }

  private loadDevices(then?: () => void): void {
    this.http.get<Device[]>('/api/devices').subscribe({
      next:  (devices) => { this._devices.set(devices); this._loading.set(false); then?.(); },
      error: () => this._loading.set(false),
    });
  }

  private subscribeSocket(): void {
    this.unsubState = this.socket.onDeviceState((ev: DeviceStateEvent) => {
      this._devices.update((list) =>
        list.map((d) => d.id === ev.id ? { ...d, state: ev.state, wattage: ev.wattage, lastChange: changed(d, ev.state), noPower: ev.state ? d.noPower : false } : d)
      );
      this.refreshAutoOff();
    });

    this.unsubMotion = this.socket.onMotion(() => this.refreshAutoOff());

    this.unsubVacuum = this.socket.onVacuumStatus((ev) => {
      this._devices.update((list) => list.map((d) => d.id === ev.id ? { ...d, vacuum: ev.vacuum } : d));
    });
    this.unsubVacuumRooms = this.socket.onVacuumRooms((ev) => {
      this._devices.update((list) => list.map((d) => d.id === ev.id ? { ...d, vacuumRooms: ev.rooms } : d));
    });

    this.unsubNoPower = this.socket.onDeviceNoPower((ev) => {
      this._devices.update((list) => list.map((d) => d.id === ev.id ? { ...d, noPower: ev.noPower } : d));
    });

    this.unsubOnline = this.socket.onDeviceOnline((ev: DeviceOnlineEvent) => {
      this._devices.update((list) =>
        list.map((d) => d.id === ev.id ? { ...d, online: ev.online } : d)
      );
    });

    this.unsubOverride = this.socket.onDeviceOverride((ev: DeviceOverrideEvent) => {
      this._devices.update((list) =>
        list.map((d) => d.id === ev.id
          ? { ...d, overrideState: ev.overrideState, overrideUntil: ev.overrideUntil }
          : d)
      );
      this.refreshAutoOff();
    });
  }

  /** Results stay visible while searching or filtering, whatever was collapsed. */
  isOpen(name: string): boolean {
    return !!this.search().trim() || this.filter() !== 'all' || !this.collapsed().has(name);
  }

  toggleSection(name: string): void {
    const next = new Set(this.collapsed());
    if (next.has(name)) next.delete(name);
    else next.add(name);
    this.collapsed.set(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch { /* collapsing still works for this visit */ }
  }

  allOff(devices: Device[]): void {
    // Lights and plugs: a robot vacuum out cleaning isn't sent home by turning a room's lights off.
    devices.filter((d) => d.state && !d.isProtected && !isThermostat(d) && !isVacuum(d)).forEach((d) => this.toggle(d));
  }

  toggle(device: Device): void {
    const action = device.state ? 'off' : 'on';

    // Optimistic update
    this._devices.update((list) =>
      list.map((d) => d.id === device.id ? { ...d, state: action === 'on' } : d)
    );
    this._busyIds.update((s) => new Set(s).add(device.id));

    this.http.post(`/api/devices/${device.id}/${action}`, {}).subscribe({
      error: () => {
        // Revert on failure. An error ends the request without "complete", so the switch is freed here too.
        this._devices.update((list) =>
          list.map((d) => d.id === device.id ? { ...d, state: device.state } : d)
        );
        this._busyIds.update((s) => { const next = new Set(s); next.delete(device.id); return next; });
      },
      complete: () => {
        this._busyIds.update((s) => { const next = new Set(s); next.delete(device.id); return next; });
      },
    });
  }

  setOverride({ device, durationMinutes }: OverrideRequest): void {
    // Optimistic: show badge immediately
    const until = new Date(Date.now() + durationMinutes * 60_000).toISOString();
    this._devices.update((list) =>
      list.map((d) => d.id === device.id
        ? { ...d, state: device.state, overrideState: device.state, overrideUntil: until }
        : d)
    );

    this.http.post<Device>(`/api/devices/${device.id}/override`, { state: device.state, durationMinutes }).subscribe({
      next: (updated) => {
        this._devices.update((list) => list.map((d) => d.id === updated.id ? updated : d));
      },
      error: () => {
        this._devices.update((list) =>
          list.map((d) => d.id === device.id ? { ...d, overrideState: null, overrideUntil: null } : d)
        );
      },
    });
  }

  cancelOverride(device: Device): void {
    this.http.delete(`/api/devices/${device.id}/override`).subscribe({
      next: () => {
        this._devices.update((list) =>
          list.map((d) => d.id === device.id ? { ...d, overrideState: null, overrideUntil: null } : d)
        );
      },
    });
  }

}
