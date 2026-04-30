import { Component, OnInit, OnDestroy, signal, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatePipe, DecimalPipe } from '@angular/common';
import { SensorService } from '../../core/services/sensor.service';
import { SocketService } from '../../core/socket/socket.service';
import type { Sensor } from '../../shared/models/sensor.model';

@Component({
  selector: 'app-sensors',
  standalone: true,
  imports: [RouterLink, DatePipe, DecimalPipe],
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
  `],
  template: `
    <div class="page">
      <div class="topbar">
        <h1>Sensors</h1>
        <a routerLink="/dashboard" class="back-link">← Dashboard</a>
      </div>

      @if (loading()) {
        <div class="loading">Loading…</div>
      } @else if (sensors().length === 0) {
        <div class="empty">
          No sensors registered yet.
          <p>Provision an AuraFlow ESP32 and register it via <code>POST /api/sensors</code>.</p>
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

  loading = signal(true);
  sensors = signal<Sensor[]>([]);

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
}
