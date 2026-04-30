import {
  Component, OnInit, OnDestroy, AfterViewInit, ViewChild, ElementRef,
  signal, computed, inject,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import Chart from 'chart.js/auto';
import { SensorService } from '../../core/services/sensor.service';
import { SocketService } from '../../core/socket/socket.service';
import type { Sensor, FlowEvent, FlowReading } from '../../shared/models/sensor.model';

const ONE_HOUR_MS  = 60 * 60 * 1000;
const M3H_TO_LPM   = 1000 / 60;

const LEVEL_LABEL: Record<number, string> = {
  0: 'Normal',
  1: 'L1 — flowing',
  2: 'L2 — 30+ min',
  3: 'L3 — possible leak',
};

const LEVEL_COLOR: Record<number, string> = {
  0: '#475569',
  1: '#1e40af',
  2: '#b45309',
  3: '#b91c1c',
};

@Component({
  selector: 'app-sensor-detail',
  standalone: true,
  imports: [RouterLink, DatePipe, DecimalPipe, FormsModule],
  styles: [`
    .topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.25rem; }
    .topbar h1 { font-size: 1.4rem; font-weight: 700; }
    .back-link { color: var(--text-muted); font-size: 0.9rem; }
    .back-link:hover { color: var(--text); }

    .meta { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.25rem; font-size: 0.85rem; color: var(--text-muted); }
    .meta strong { color: var(--text); }

    .snooze-banner {
      background: #92400e; color: #fff; padding: 0.7rem 1rem; border-radius: 8px;
      margin-bottom: 1rem; display: flex; align-items: center; justify-content: space-between;
    }
    .btn { font-size: 0.85rem; padding: 0.4rem 0.85rem; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; }
    .btn:hover { border-color: var(--accent); }
    .btn.danger { background: #6b1d1d; color: #fff; border-color: #6b1d1d; }
    .btn.danger:hover { background: #8b2828; }

    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
    .card h2 { font-size: 0.95rem; font-weight: 600; margin-bottom: 0.75rem; }

    .chart-wrap { position: relative; height: 240px; }

    .controls { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .controls input { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 0.35rem 0.6rem; border-radius: 6px; width: 5rem; }

    .events { display: flex; flex-direction: column; gap: 0.5rem; }
    .event-row {
      display: grid; grid-template-columns: auto 1fr auto auto; gap: 0.75rem; align-items: center;
      padding: 0.6rem 0.8rem; border: 1px solid var(--border); border-radius: 6px; font-size: 0.85rem;
    }
    .level-pill { font-size: 0.7rem; padding: 0.15rem 0.5rem; border-radius: 999px; color: #fff; font-weight: 600; }

    .empty { color: var(--text-muted); padding: 0.5rem 0; font-size: 0.85rem; }
  `],
  template: `
    <div class="page">
      <div class="topbar">
        <h1>{{ sensor()?.alias ?? 'Sensor' }}</h1>
        <a routerLink="/sensors" class="back-link">← All sensors</a>
      </div>

      @if (sensor(); as s) {
        @if (snoozedActive()) {
          <div class="snooze-banner">
            <span>Alerts L1/L2 suppressed until {{ s.snoozedUntil | date:'short' }}. L3 still fires.</span>
            <button class="btn" (click)="unsnooze()">Unsnooze</button>
          </div>
        }

        <div class="meta">
          <span><strong>{{ s.sensorId }}</strong></span>
          <span>last seen <strong>{{ s.lastSeenAt ? (s.lastSeenAt | date:'short') : '—' }}</strong></span>
          @if (s.lastSignalQuality !== null) {
            <span>signal <strong>{{ s.lastSignalQuality }}</strong></span>
          }
          @if (s.firmwareVersion) {
            <span>fw <strong>{{ s.firmwareVersion }}</strong></span>
          }
          <span>state <strong>{{ s.pendingState }}</strong></span>
        </div>

        <div class="card">
          <h2>Live flow rate (last hour)</h2>
          <div class="chart-wrap"><canvas #chart></canvas></div>
        </div>

        <div class="card">
          <h2>Snooze</h2>
          <div class="controls">
            <span>Suppress L1/L2 alerts for</span>
            <input type="number" [(ngModel)]="snoozeHours" min="1" max="72" />
            <span>hours</span>
            <button class="btn" (click)="snooze()">Snooze</button>
            @if (snoozedActive()) {
              <button class="btn danger" (click)="unsnooze()">Cancel snooze</button>
            }
          </div>
        </div>

        <div class="card">
          <h2>Recent events</h2>
          @if (events().length === 0) {
            <div class="empty">No flow events recorded yet.</div>
          } @else {
            <div class="events">
              @for (ev of events(); track ev.id) {
                <div class="event-row">
                  <span class="level-pill" [style.background]="levelColor(ev.alertLevel)">
                    L{{ ev.alertLevel }}
                  </span>
                  <span>
                    {{ ev.startTime | date:'short' }}
                    @if (ev.endTime) { → {{ ev.endTime | date:'shortTime' }} } @else { · ongoing }
                  </span>
                  <span>peak {{ ev.peakRate | number:'1.2-2' }} m³/h</span>
                  <span>{{ ev.totalM3 ? ((ev.totalM3 * 264.172) | number:'1.0-1') + ' gal' : '—' }}</span>
                </div>
              }
            </div>
          }
        </div>
      } @else if (loading()) {
        <div class="empty">Loading…</div>
      } @else {
        <div class="empty">Sensor not found.</div>
      }
    </div>
  `,
})
export class SensorDetailComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('chart') chartCanvas?: ElementRef<HTMLCanvasElement>;

  private svc    = inject(SensorService);
  private socket = inject(SocketService);
  private route  = inject(ActivatedRoute);

  loading = signal(true);
  sensor  = signal<Sensor | null>(null);
  events  = signal<FlowEvent[]>([]);

  snoozeHours = 4;
  snoozedActive = computed(() => {
    const s = this.sensor();
    if (!s?.snoozedUntil) return false;
    return new Date(s.snoozedUntil.replace(' ', 'T') + 'Z').getTime() > Date.now();
  });

  private chart?: Chart;
  private offReading?: () => void;
  private offAlert?:   () => void;
  private sensorId    = 0;

  ngOnInit(): void {
    this.sensorId = Number(this.route.snapshot.paramMap.get('id'));
    if (!Number.isFinite(this.sensorId) || this.sensorId <= 0) {
      this.loading.set(false);
      return;
    }
    this.refresh();
    this.socket.connect();
  }

  ngAfterViewInit(): void {
    this.initChart();
  }

  private refresh(): void {
    this.svc.get(this.sensorId).subscribe({
      next: (s) => { this.sensor.set(s); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
    this.svc.events(this.sensorId, { limit: 25 }).subscribe((es) => this.events.set(es));
    this.svc.readings(this.sensorId, {
      from:  new Date(Date.now() - ONE_HOUR_MS).toISOString(),
      limit: 1000,
    }).subscribe((readings) => this.seedChart(readings));
  }

  private initChart(): void {
    if (!this.chartCanvas) return;
    this.chart = new Chart(this.chartCanvas.nativeElement, {
      type: 'line',
      data: {
        labels:   [] as string[],
        datasets: [{
          label:           'L/min',
          data:            [] as number[],
          borderColor:     '#3b82f6',
          backgroundColor: 'rgba(59,130,246,0.15)',
          tension:         0.25,
          pointRadius:     0,
          fill:            true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { maxTicksLimit: 6, color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,0.1)' } },
          y: { beginAtZero: true, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,0.1)' } },
        },
        plugins: { legend: { display: false } },
        animation: false,
      },
    });

    this.offReading = this.socket.onSensorReading((ev) => {
      if (ev.id !== this.sensorId) return;
      this.appendChartPoint(ev.recordedAt, ev.rateM3h);
    });
    this.offAlert = this.socket.onSensorAlert((ev) => {
      if (ev.id !== this.sensorId) return;
      // Reload events so the new level + active row appear.
      this.svc.events(this.sensorId, { limit: 25 }).subscribe((es) => this.events.set(es));
      this.svc.get(this.sensorId).subscribe((s) => this.sensor.set(s));
    });
  }

  private seedChart(readings: FlowReading[]): void {
    if (!this.chart) {
      // chart not ready yet — try again after view init via a microtask
      queueMicrotask(() => this.seedChart(readings));
      return;
    }
    const sorted = [...readings].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    this.chart.data.labels = sorted.map((r) => formatTime(r.recordedAt));
    (this.chart.data.datasets[0].data as number[]) = sorted.map((r) => r.rateM3h * M3H_TO_LPM);
    this.chart.update('none');
  }

  private appendChartPoint(recordedAt: string, rateM3h: number): void {
    if (!this.chart) return;
    const labels = this.chart.data.labels as string[];
    const data   = this.chart.data.datasets[0].data as number[];
    labels.push(formatTime(recordedAt));
    data.push(rateM3h * M3H_TO_LPM);
    // Trim to last hour by point count (rough — assumes ≤ 1 reading every 5s)
    const max = (60 * 60) / 5;
    if (labels.length > max) { labels.shift(); data.shift(); }
    this.chart.update('none');
  }

  snooze(): void {
    if (!this.snoozeHours || this.snoozeHours <= 0) return;
    this.svc.snooze(this.sensorId, this.snoozeHours).subscribe(() => {
      this.svc.get(this.sensorId).subscribe((s) => this.sensor.set(s));
    });
  }

  unsnooze(): void {
    this.svc.unsnooze(this.sensorId).subscribe(() => {
      this.svc.get(this.sensorId).subscribe((s) => this.sensor.set(s));
    });
  }

  levelColor(level: number): string { return LEVEL_COLOR[level] ?? LEVEL_COLOR[0]; }
  levelLabel(level: number): string { return LEVEL_LABEL[level] ?? `L${level}`; }

  ngOnDestroy(): void {
    this.offReading?.();
    this.offAlert?.();
    this.chart?.destroy();
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
