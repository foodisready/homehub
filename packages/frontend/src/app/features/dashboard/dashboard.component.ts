import { Component, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { AuthService } from '../../core/auth/auth.service';
import { SocketService, DeviceStateEvent, DeviceOnlineEvent } from '../../core/socket/socket.service';
import { DeviceTileComponent, OverrideRequest } from './device-tile/device-tile.component';
import { Device } from '../../shared/models/device.model';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [DeviceTileComponent, DecimalPipe, RouterLink],
  styles: [`
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1.5rem;
    }
    .topbar h1 { font-size: 1.4rem; font-weight: 700; }
    .topbar-right { display: flex; align-items: center; gap: 1rem; }
    .user-info { font-size: 0.85rem; color: var(--text-muted); }
    .btn-logout {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 0.35rem 0.85rem;
      font-size: 0.8rem;
    }
    .btn-logout:hover { background: var(--surface); color: var(--text); }

    .summary {
      display: flex;
      gap: 1rem;
      margin-bottom: 1.5rem;
      flex-wrap: wrap;
    }
    .summary-chip {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 0.3rem 0.9rem;
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .summary-chip strong { color: var(--text); }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
      gap: 1rem;
    }

    .empty {
      text-align: center;
      padding: 3rem 1rem;
      color: var(--text-muted);
    }
    .empty p { margin-top: 0.5rem; font-size: 0.9rem; }

    .loading { color: var(--text-muted); padding: 2rem 0; text-align: center; }
  `],
  template: `
    <div class="page">

      <!-- Top bar -->
      <div class="topbar">
        <h1>HomeHub</h1>
        <div class="topbar-right">
          <a routerLink="/schedules" style="font-size:0.85rem; color:var(--text-muted)">Schedules</a>
          <a routerLink="/scenes" style="font-size:0.85rem; color:var(--text-muted)">Scenes</a>
          <a routerLink="/sensors" style="font-size:0.85rem; color:var(--text-muted)">Sensors</a>
          <a routerLink="/energy" style="font-size:0.85rem; color:var(--text-muted)">Energy</a>
          <a routerLink="/chat" style="font-size:0.85rem; color:var(--text-muted)">Chat</a>
          <a routerLink="/settings" style="font-size:0.85rem; color:var(--text-muted)">Settings</a>
          @if (auth.user(); as u) {
            <span class="user-info">{{ u.name }}</span>
          }
          <button class="btn-logout" (click)="logout()">Sign out</button>
        </div>
      </div>

      <!-- Summary chips -->
      @if (devices().length > 0) {
        <div class="summary">
          <span class="summary-chip">
            <strong>{{ onCount() }}</strong> / {{ devices().length }} on
          </span>
          <span class="summary-chip">
            <strong>{{ onlineCount() }}</strong> online
          </span>
          @if (totalWattage() > 0) {
            <span class="summary-chip">
              <strong>{{ totalWattage() | number:'1.1-1' }} W</strong> total
            </span>
          }
        </div>
      }

      <!-- Device grid -->
      @if (loading()) {
        <div class="loading">Loading devices…</div>
      } @else if (devices().length === 0) {
        <div class="empty">
          <strong>No devices yet</strong>
          <p>Add a Kasa plug by IP in Settings, or run discovery.</p>
        </div>
      } @else {
        <div class="grid">
          @for (device of devices(); track device.id) {
            <app-device-tile
              [device]="device"
              [busy]="busyIds().has(device.id)"
              (toggled)="toggle($event)"
              (overrideSet)="setOverride($event)"
              (overrideCancelled)="cancelOverride($event)" />
          }
        </div>
      }

    </div>
  `,
})
export class DashboardComponent implements OnInit, OnDestroy {
  private readonly _devices  = signal<Device[]>([]);
  private readonly _busyIds  = signal<Set<number>>(new Set());
  private readonly _loading  = signal(true);

  readonly devices     = this._devices.asReadonly();
  readonly busyIds     = this._busyIds.asReadonly();
  readonly loading     = this._loading.asReadonly();
  readonly onCount     = computed(() => this._devices().filter((d) => d.state).length);
  readonly onlineCount = computed(() => this._devices().filter((d) => d.online).length);
  readonly totalWattage = computed(() =>
    this._devices().reduce((sum, d) => sum + (d.wattage ?? 0), 0)
  );

  private unsubState?:  () => void;
  private unsubOnline?: () => void;

  constructor(
    readonly auth:   AuthService,
    private http:    HttpClient,
    private socket:  SocketService,
    private router:  Router,
  ) {}

  ngOnInit(): void {
    this.loadDevices();
    this.subscribeSocket();
  }

  ngOnDestroy(): void {
    this.unsubState?.();
    this.unsubOnline?.();
  }

  private loadDevices(): void {
    this.http.get<Device[]>('/api/devices').subscribe({
      next:  (devices) => { this._devices.set(devices); this._loading.set(false); },
      error: () => this._loading.set(false),
    });
  }

  private subscribeSocket(): void {
    this.unsubState = this.socket.onDeviceState((ev: DeviceStateEvent) => {
      this._devices.update((list) =>
        list.map((d) => d.id === ev.id ? { ...d, state: ev.state, wattage: ev.wattage } : d)
      );
    });

    this.unsubOnline = this.socket.onDeviceOnline((ev: DeviceOnlineEvent) => {
      this._devices.update((list) =>
        list.map((d) => d.id === ev.id ? { ...d, online: ev.online } : d)
      );
    });
  }

  toggle(device: Device): void {
    const action = device.state ? 'off' : 'on';

    // Optimistic update
    this._devices.update((list) =>
      list.map((d) => d.id === device.id ? { ...d, state: !d.state } : d)
    );
    this._busyIds.update((s) => new Set(s).add(device.id));

    this.http.post(`/api/devices/${device.id}/${action}`, {}).subscribe({
      error: () => {
        // Revert on failure
        this._devices.update((list) =>
          list.map((d) => d.id === device.id ? { ...d, state: device.state } : d)
        );
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

  logout(): void {
    this.auth.logout();
    this.socket.disconnect();
    this.router.navigate(['/login']);
  }
}
