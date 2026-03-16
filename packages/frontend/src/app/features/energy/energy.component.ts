import { Component, OnInit, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { Device } from '../../shared/models/device.model';

type Range = '24h' | '7d' | '30d';

interface EnergyReading {
  timestamp: string;
  wattage: number | null;
}

interface DeviceHistory {
  deviceId: number;
  alias: string;
  range: Range;
  readings: EnergyReading[];
}

const RANGE_LABELS: Record<Range, string> = {
  '24h': 'Last 24 hours',
  '7d':  'Last 7 days',
  '30d': 'Last 30 days',
};

const CHART_W = 480;
const CHART_H = 120;
const PAD_L   = 42;
const PAD_R   = 8;
const PAD_T   = 10;
const PAD_B   = 24;

function buildPath(readings: EnergyReading[]): string {
  const points = readings.filter((r) => r.wattage != null);
  if (points.length < 2) return '';

  const xs   = points.map((_, i) => i);
  const ys   = points.map((r) => r.wattage as number);
  const minX = 0;
  const maxX = points.length - 1;
  const minY = 0;
  const maxY = Math.max(...ys, 1);

  const w = CHART_W - PAD_L - PAD_R;
  const h = CHART_H - PAD_T - PAD_B;

  const px = (i: number) => PAD_L + (i / (maxX || 1)) * w;
  const py = (v: number) => PAD_T + h - (v / maxY) * h;

  const pts = points.map((r, i) => `${px(i).toFixed(1)},${py(r.wattage as number).toFixed(1)}`);
  return `M ${pts.join(' L ')}`;
}

function buildArea(readings: EnergyReading[]): string {
  const points = readings.filter((r) => r.wattage != null);
  if (points.length < 2) return '';

  const ys   = points.map((r) => r.wattage as number);
  const maxX = points.length - 1;
  const maxY = Math.max(...ys, 1);

  const w = CHART_W - PAD_L - PAD_R;
  const h = CHART_H - PAD_T - PAD_B;

  const px = (i: number) => PAD_L + (i / (maxX || 1)) * w;
  const py = (v: number) => PAD_T + h - (v / maxY) * h;
  const baseline = PAD_T + h;

  const pts = points.map((r, i) => `${px(i).toFixed(1)},${py(r.wattage as number).toFixed(1)}`);
  const first = `${px(0).toFixed(1)},${baseline}`;
  const last  = `${px(maxX).toFixed(1)},${baseline}`;
  return `M ${first} L ${pts.join(' L ')} L ${last} Z`;
}

function yTicks(readings: EnergyReading[]): { value: number; y: number }[] {
  const ys   = readings.filter((r) => r.wattage != null).map((r) => r.wattage as number);
  const maxY = Math.max(...ys, 1);
  const h    = CHART_H - PAD_T - PAD_B;
  const step = maxY <= 10 ? 2 : maxY <= 100 ? 20 : maxY <= 500 ? 100 : 200;
  const ticks: { value: number; y: number }[] = [];
  for (let v = 0; v <= maxY; v += step) {
    ticks.push({ value: v, y: PAD_T + h - (v / maxY) * h });
  }
  return ticks;
}

function xLabels(readings: EnergyReading[], range: Range): { label: string; x: number }[] {
  const points = readings.filter((r) => r.wattage != null);
  if (points.length < 2) return [];

  const w    = CHART_W - PAD_L - PAD_R;
  const maxI = points.length - 1;
  const px   = (i: number) => PAD_L + (i / (maxI || 1)) * w;

  // Pick ~5 evenly spaced labels
  const step = Math.max(1, Math.floor(points.length / 5));
  return points
    .filter((_, i) => i % step === 0 || i === maxI)
    .map((r, _, arr) => {
      const orig = points.indexOf(r);
      const d    = new Date(r.timestamp);
      const lbl  = range === '24h'
        ? d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
        : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return { label: lbl, x: px(orig) };
    });
}

@Component({
  selector: 'app-energy',
  standalone: true,
  imports: [RouterLink, DecimalPipe],
  styles: [`
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1.5rem;
    }
    .topbar h1 { font-size: 1.4rem; font-weight: 700; }
    .back-link { color: var(--text-muted); font-size: 0.9rem; }
    .back-link:hover { color: var(--text); }

    .range-tabs {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
    }
    .range-tab {
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 0.35rem 1rem;
      font-size: 0.85rem;
      border-radius: var(--radius);
    }
    .range-tab.active {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    .range-tab:hover:not(.active) { background: var(--bg); color: var(--text); }

    .summary-cards {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      margin-bottom: 1.5rem;
    }
    .summary-card {
      flex: 1;
      min-width: 130px;
      text-align: center;
    }
    .summary-card .value {
      font-size: 1.6rem;
      font-weight: 700;
      color: var(--accent);
    }
    .summary-card .label {
      font-size: 0.78rem;
      color: var(--text-muted);
      margin-top: 0.2rem;
    }

    .device-charts { display: flex; flex-direction: column; gap: 1.25rem; }

    .chart-card h3 {
      font-size: 0.95rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
    }
    .chart-wrap { overflow-x: auto; }
    svg { display: block; width: 100%; max-width: ${CHART_W}px; height: ${CHART_H}px; }

    .no-data {
      text-align: center;
      padding: 2rem 1rem;
      color: var(--text-muted);
      font-size: 0.9rem;
    }

    .no-emeter {
      text-align: center;
      padding: 3rem 1rem;
      color: var(--text-muted);
    }
    .no-emeter p { margin-top: 0.5rem; font-size: 0.9rem; }

    .loading { text-align: center; padding: 2rem; color: var(--text-muted); }
  `],
  template: `
    <div class="page">

      <div class="topbar">
        <div style="display:flex; align-items:center; gap:1rem">
          <a class="back-link" routerLink="/dashboard">← Dashboard</a>
          <h1>Energy</h1>
        </div>
      </div>

      <!-- Range selector -->
      <div class="range-tabs">
        @for (r of ranges; track r.value) {
          <button
            class="range-tab"
            [class.active]="selectedRange() === r.value"
            (click)="setRange(r.value)">
            {{ r.label }}
          </button>
        }
      </div>

      @if (loading()) {
        <div class="loading">Loading…</div>

      } @else if (emeterDevices().length === 0) {
        <div class="no-emeter">
          <strong>No energy-monitoring devices</strong>
          <p>Add a HS110 or KP115 plug to see power history.</p>
        </div>

      } @else {
        <!-- Summary row -->
        <div class="summary-cards">
          <div class="card summary-card">
            <div class="value">{{ currentTotal() | number:'1.1-1' }} W</div>
            <div class="label">Live total draw</div>
          </div>
          <div class="card summary-card">
            <div class="value">{{ emeterDevices().length }}</div>
            <div class="label">Monitored devices</div>
          </div>
          @if (kwhRate() > 0) {
            <div class="card summary-card">
              <div class="value">\${{ monthlyCost() | number:'1.2-2' }}</div>
              <div class="label">Est. monthly cost</div>
            </div>
          }
        </div>

        <!-- Per-device charts -->
        <div class="device-charts">
          @for (hist of histories(); track hist.deviceId) {
            <div class="card chart-card">
              <h3>
                {{ hist.alias }}
                @if (currentWattage(hist.deviceId); as w) {
                  <span style="font-weight:400; color:var(--text-muted); font-size:0.82rem; margin-left:0.5rem">{{ w | number:'1.1-1' }} W now</span>
                }
              </h3>

              @if (hist.readings.length < 2) {
                <div class="no-data">No readings for this period yet.</div>
              } @else {
                <div class="chart-wrap">
                  <svg [attr.viewBox]="'0 0 ' + chartW + ' ' + chartH" preserveAspectRatio="none">
                    <!-- Y grid + labels -->
                    @for (tick of getYTicks(hist.readings); track tick.value) {
                      <line [attr.x1]="padL" [attr.x2]="chartW - padR" [attr.y1]="tick.y" [attr.y2]="tick.y"
                            stroke="var(--border)" stroke-width="1" />
                      <text [attr.x]="padL - 4" [attr.y]="tick.y + 4" text-anchor="end"
                            font-size="9" fill="var(--text-muted)">{{ tick.value }}</text>
                    }

                    <!-- X labels -->
                    @for (lbl of getXLabels(hist.readings, selectedRange()); track lbl.x) {
                      <text [attr.x]="lbl.x" [attr.y]="chartH - 4" text-anchor="middle"
                            font-size="9" fill="var(--text-muted)">{{ lbl.label }}</text>
                    }

                    <!-- Area fill -->
                    <path [attr.d]="buildArea(hist.readings)"
                          fill="rgba(59,130,246,0.12)" />

                    <!-- Line -->
                    <path [attr.d]="buildPath(hist.readings)"
                          fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round" />
                  </svg>
                </div>
              }
            </div>
          }
        </div>
      }

    </div>
  `,
})
export class EnergyComponent implements OnInit {
  // Expose constants to template
  readonly chartW = CHART_W;
  readonly chartH = CHART_H;
  readonly padL   = PAD_L;
  readonly padR   = PAD_R;

  readonly ranges: { value: Range; label: string }[] = [
    { value: '24h', label: '24 h' },
    { value: '7d',  label: '7 d'  },
    { value: '30d', label: '30 d' },
  ];

  private readonly _loading       = signal(true);
  private readonly _selectedRange = signal<Range>('24h');
  private readonly _allDevices    = signal<Device[]>([]);
  private readonly _histories     = signal<DeviceHistory[]>([]);

  readonly loading       = this._loading.asReadonly();
  readonly selectedRange = this._selectedRange.asReadonly();
  readonly histories     = this._histories.asReadonly();

  readonly emeterDevices = computed(() => this._allDevices().filter((d) => d.hasEmeter));
  readonly currentTotal  = computed(() =>
    this._allDevices().reduce((sum, d) => sum + (d.wattage ?? 0), 0)
  );
  readonly kwhRate = computed(() => parseFloat(localStorage.getItem('kwhRate') ?? '0') || 0);
  readonly monthlyCost = computed(() => {
    // Current total watts → kWh/month = watts/1000 * 24 * 30
    const kwhPerMonth = (this.currentTotal() / 1000) * 24 * 30;
    return kwhPerMonth * this.kwhRate();
  });

  // Chart helper functions exposed to template
  buildPath = buildPath;
  buildArea = buildArea;
  getYTicks = yTicks;
  getXLabels = xLabels;

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.loadAll();
  }

  setRange(r: Range): void {
    this._selectedRange.set(r);
    this.loadHistories(this._allDevices().filter((d) => d.hasEmeter));
  }

  currentWattage(deviceId: number): number | null {
    return this._allDevices().find((d) => d.id === deviceId)?.wattage ?? null;
  }

  private loadAll(): void {
    this.http.get<Device[]>('/api/devices').subscribe({
      next: (devices) => {
        this._allDevices.set(devices);
        const emeter = devices.filter((d) => d.hasEmeter);
        if (emeter.length === 0) { this._loading.set(false); return; }
        this.loadHistories(emeter);
      },
      error: () => this._loading.set(false),
    });
  }

  private loadHistories(devices: Device[]): void {
    this._loading.set(true);
    const range   = this._selectedRange();
    let   pending = devices.length;
    const results: DeviceHistory[] = [];

    if (pending === 0) { this._loading.set(false); return; }

    for (const d of devices) {
      this.http.get<DeviceHistory>(`/api/devices/${d.id}/energy/history?range=${range}`).subscribe({
        next: (h)  => { results.push(h); },
        error: ()  => { /* skip failed device */ },
        complete: () => {
          if (--pending === 0) {
            results.sort((a, b) => a.alias.localeCompare(b.alias));
            this._histories.set(results);
            this._loading.set(false);
          }
        },
      });
    }
  }
}
