import { Component, OnInit, OnDestroy, signal, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth/auth.service';
import { SensorService } from '../../core/services/sensor.service';
import { SocketService } from '../../core/socket/socket.service';
import type { Sensor } from '../../shared/models/sensor.model';

@Component({
  selector: 'app-sensors',
  standalone: true,
  imports: [RouterLink, DatePipe, DecimalPipe, FormsModule],
  styles: [`
    .topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
    .topbar h1 { font-size: 1.4rem; font-weight: 700; }
    .back-link { color: var(--text-muted); font-size: 0.9rem; }
    .back-link:hover { color: var(--text); }

    .sensor-list { display: flex; flex-direction: column; gap: 0.75rem; }
    .sensor-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 1rem; border: 1px solid var(--border);
      border-radius: 8px; background: var(--surface);
      text-decoration: none; color: var(--text);
    }
    .sensor-row:hover { border-color: var(--accent); }
    .sensor-info { display: flex; flex-direction: column; gap: 0.2rem; }
    .sensor-alias { font-weight: 600; }
    .sensor-key { font-size: 0.8rem; color: var(--text-muted); }
    .sensor-meta { font-size: 0.8rem; color: var(--text-muted); }
    .badges { display: flex; gap: 0.4rem; align-items: center; }
    .badge {
      font-size: 0.7rem; padding: 0.2rem 0.55rem; border-radius: 999px;
      background: var(--surface); border: 1px solid var(--border); color: var(--text-muted);
    }
    .badge.flowing { background: #1e40af; border-color: #1e40af; color: #fff; }
    .badge.snoozed { background: #92400e; border-color: #92400e; color: #fff; }
    .badge.stale   { background: #6b1d1d; border-color: #6b1d1d; color: #fff; }
    .empty { text-align: center; padding: 3rem 1rem; color: var(--text-muted); }
    .loading { color: var(--text-muted); padding: 2rem 0; text-align: center; }

    .btn { font-size: 0.85rem; padding: 0.4rem 0.85rem; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; }
    .btn:hover { border-color: var(--accent); }
    .btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }

    .create-form {
      background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
      padding: 1rem; margin-bottom: 1rem;
      display: flex; flex-direction: column; gap: 0.5rem;
    }
    .create-form input {
      background: var(--surface); border: 1px solid var(--border); color: var(--text);
      padding: 0.4rem 0.6rem; border-radius: 6px;
    }
    .create-form .row { display: flex; gap: 0.5rem; align-items: center; }
    .err-msg { color: #f87171; font-size: 0.85rem; }
  `],
  template: `
    <div class="page">
      <div class="topbar">
        <h1>Sensors</h1>
        <div style="display:flex;align-items:center;gap:0.75rem">
          <button class="btn primary" (click)="createOpen.set(!createOpen())">
            {{ createOpen() ? 'Cancel' : '+ Add sensor' }}
          </button>
          <a routerLink="/dashboard" class="back-link">← Dashboard</a>
        </div>
      </div>

      @if (createOpen()) {
        <div class="create-form">
          <label style="font-size:0.85rem;color:var(--text-muted)">Sensor ID — burn this into the ESP32 NVS</label>
          <input [(ngModel)]="newSensorId" placeholder="e.g. auraflow-mainline-01" autocomplete="off" />
          <label style="font-size:0.85rem;color:var(--text-muted)">Display name</label>
          <input [(ngModel)]="newAlias" placeholder="e.g. Main line" autocomplete="off" />
          <div class="row">
            <button class="btn primary" (click)="createSensor()"
                    [disabled]="!newSensorId.trim() || !newAlias.trim() || creating()">
              {{ creating() ? 'Creating…' : 'Create' }}
            </button>
            @if (createErr()) { <span class="err-msg">{{ createErr() }}</span> }
          </div>
        </div>
      }

      @if (loading()) {
        <div class="loading">Loading…</div>
      } @else if (sensors().length === 0) {
        <div class="empty">
          No sensors registered yet.
          <p>Click <strong>+ Add sensor</strong> above to register your first AuraFlow device.</p>
        </div>
      } @else {
        <div class="sensor-list">
          @for (s of sensors(); track s.id) {
            <a class="sensor-row" [routerLink]="['/sensors', s.id]">
              <div class="sensor-info">
                <div class="sensor-alias">{{ s.alias }}</div>
                <div class="sensor-key">{{ s.sensorId }} · {{ s.type }}</div>
                <div class="sensor-meta">
                  @if (s.lastSeenAt) {
                    last seen {{ s.lastSeenAt | date:'short' }}
                  } @else {
                    never reported
                  }
                  @if (s.lastSignalQuality !== null) {
                    · signal {{ s.lastSignalQuality | number:'1.0-0' }}
                  }
                </div>
              </div>
              <div class="badges">
                @if (s.snoozedUntil && isFuture(s.snoozedUntil)) {
                  <span class="badge snoozed">snoozed</span>
                }
                @if (s.pendingState === 'flowing') {
                  <span class="badge flowing">flowing</span>
                }
                @if (isStale(s)) {
                  <span class="badge stale">stale</span>
                }
              </div>
            </a>
          }
        </div>
      }
    </div>
  `,
})
export class SensorsComponent implements OnInit, OnDestroy {
  private svc    = inject(SensorService);
  private socket = inject(SocketService);
  readonly auth  = inject(AuthService);

  loading  = signal(true);
  sensors  = signal<Sensor[]>([]);

  createOpen   = signal(false);
  creating     = signal(false);
  createErr    = signal('');
  newSensorId  = '';
  newAlias     = '';

  private offReading?: () => void;

  ngOnInit(): void {
    this.svc.list().subscribe({
      next: (s) => { this.sensors.set(s); this.loading.set(false); },
      error: () => this.loading.set(false),
    });

    // Refresh last-seen-at as readings come in for any sensor.
    this.socket.connect();
    this.offReading = this.socket.onSensorReading((ev) => {
      this.sensors.update((list) => list.map((s) =>
        s.id === ev.id ? { ...s, lastSeenAt: ev.recordedAt } : s,
      ));
    });
  }

  ngOnDestroy(): void {
    this.offReading?.();
  }

  isFuture(iso: string): boolean {
    return new Date(iso.replace(' ', 'T') + 'Z').getTime() > Date.now();
  }

  isStale(s: Sensor): boolean {
    return !!s.staleSince;
  }

  createSensor(): void {
    if (!this.newSensorId.trim() || !this.newAlias.trim()) return;
    this.creating.set(true);
    this.createErr.set('');
    this.svc.create({
      sensorId: this.newSensorId.trim(),
      alias:    this.newAlias.trim(),
      type:     'flow',
    }).subscribe({
      next: () => {
        this.newSensorId = '';
        this.newAlias    = '';
        this.creating.set(false);
        this.createOpen.set(false);
        this.svc.list().subscribe((s) => this.sensors.set(s));
      },
      error: (err) => {
        this.creating.set(false);
        const code = err?.error?.code;
        this.createErr.set(
          code === 'CONFLICT'   ? 'A sensor with that ID already exists.'
          : code === 'FORBIDDEN' ? 'Admin access required to create a sensor.'
          : err?.error?.error    ?? 'Create failed.'
        );
      },
    });
  }
}
