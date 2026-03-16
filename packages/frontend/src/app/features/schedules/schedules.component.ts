import { Component, OnInit, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { Device } from '../../shared/models/device.model';

interface Schedule {
  id: number;
  deviceId: number;
  deviceAlias: string;
  label: string;
  triggerType: 'cron' | 'solar';
  cronExpression: string | null;
  solarEvent: string | null;
  solarOffsetMinutes: number;
  state: boolean;
  enabled: boolean;
}

const SOLAR_EVENTS = [
  { value: 'sunrise',    label: 'Sunrise' },
  { value: 'sunset',     label: 'Sunset' },
  { value: 'dawn',       label: 'Dawn' },
  { value: 'dusk',       label: 'Dusk' },
  { value: 'goldenHour', label: 'Golden Hour' },
  { value: 'solarNoon',  label: 'Solar Noon' },
];

const CRON_PRESETS = [
  { label: 'Every day at midnight',  value: '0 0 * * *' },
  { label: 'Every day at 6 AM',      value: '0 6 * * *' },
  { label: 'Every day at 9 PM',      value: '0 21 * * *' },
  { label: 'Every weekday at 8 AM',  value: '0 8 * * 1-5' },
  { label: 'Custom…',                value: '' },
];

@Component({
  selector: 'app-schedules',
  standalone: true,
  imports: [FormsModule, RouterLink],
  styles: [`
    .topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
    .topbar h1 { font-size: 1.4rem; font-weight: 700; }
    .back-link { color: var(--text-muted); font-size: 0.9rem; }
    .back-link:hover { color: var(--text); }

    .btn-add {
      background: var(--accent);
      color: #fff;
      font-weight: 600;
      padding: 0.5rem 1.1rem;
    }
    .btn-add:hover { background: var(--accent-hover); }

    /* Schedule list */
    .schedule-list { display: flex; flex-direction: column; gap: 0.75rem; }
    .schedule-row {
      display: flex;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;
    }
    .schedule-info { flex: 1; min-width: 0; }
    .schedule-label { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .schedule-meta { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.2rem; }
    .badge {
      display: inline-block;
      padding: 0.15rem 0.6rem;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
      margin-left: 0.4rem;
    }
    .badge-on  { background: #14532d; color: var(--green); }
    .badge-off { background: #1c1917; color: var(--text-muted); }

    .toggle-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 0.3rem 0.8rem;
      font-size: 0.8rem;
    }
    .toggle-btn.active { border-color: var(--green); color: var(--green); }
    .toggle-btn:hover { background: var(--surface); }

    .delete-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 0.3rem 0.5rem;
      font-size: 1rem;
    }
    .delete-btn:hover { color: var(--red); }

    .empty { text-align: center; padding: 3rem 1rem; color: var(--text-muted); }

    /* Create form */
    .form-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.6);
      display: flex; align-items: center; justify-content: center;
      padding: 1rem; z-index: 100;
    }
    .form-card { width: 100%; max-width: 480px; }
    .form-card h2 { font-size: 1.2rem; font-weight: 700; margin-bottom: 1.25rem; }
    .field { margin-bottom: 1rem; }
    label { display: block; font-size: 0.82rem; font-weight: 500; color: var(--text-muted); margin-bottom: 0.3rem; }
    select {
      width: 100%;
      font-family: inherit; font-size: 1rem;
      background: var(--bg); color: var(--text);
      border: 1px solid var(--border); border-radius: var(--radius);
      padding: 0.6rem 0.9rem; outline: none;
    }
    select:focus { border-color: var(--accent); }
    .row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
    .form-actions { display: flex; gap: 0.75rem; margin-top: 1.25rem; }
    .btn-cancel {
      flex: 1; background: transparent;
      border: 1px solid var(--border); color: var(--text-muted);
    }
    .btn-cancel:hover { background: var(--surface); }
    .btn-save { flex: 2; }

    .label-row { display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.3rem; }
    .label-row .field-label { font-size: 0.82rem; font-weight: 500; color: var(--text-muted); }
    .help-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      border-radius: 50%;
      width: 1.3rem;
      height: 1.3rem;
      font-size: 0.7rem;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      line-height: 1;
      flex-shrink: 0;
    }
    .help-btn:hover { border-color: var(--accent); color: var(--accent); }

    .cron-help {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 0.6rem 0.75rem;
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
      line-height: 1.6;
    }
    .cron-help code {
      font-family: monospace;
      color: var(--text);
      background: var(--bg);
      padding: 0.05rem 0.3rem;
      border-radius: 3px;
    }
    .cron-help table { border-collapse: collapse; width: 100%; margin: 0.3rem 0; }
    .cron-help th { color: var(--text); font-size: 0.7rem; text-align: left; padding: 0.1rem 0.4rem 0.1rem 0; }
    .cron-help td { padding: 0.1rem 0.4rem 0.1rem 0; }
  `],
  template: `
    <div class="page">

      <div class="topbar">
        <div style="display:flex; align-items:center; gap:1rem">
          <a class="back-link" routerLink="/dashboard">← Dashboard</a>
          <h1>Schedules</h1>
        </div>
        @if (auth.user()?.role === 'admin') {
          <button class="btn-add" (click)="showForm.set(true)">+ New Schedule</button>
        }
      </div>

      <!-- List -->
      @if (schedules().length === 0) {
        <div class="empty">No schedules yet. Create one to automate your plugs.</div>
      } @else {
        <div class="schedule-list">
          @for (s of schedules(); track s.id) {
            <div class="card schedule-row">
              <div class="schedule-info">
                <div class="schedule-label">
                  {{ s.label }}
                  <span class="badge" [class.badge-on]="s.state" [class.badge-off]="!s.state">
                    {{ s.state ? 'ON' : 'OFF' }}
                  </span>
                </div>
                <div class="schedule-meta">
                  {{ s.deviceAlias }} ·
                  @if (s.triggerType === 'cron') {
                    {{ s.cronExpression }}
                  } @else {
                    {{ solarLabel(s.solarEvent) }}
                    @if (s.solarOffsetMinutes !== 0) {
                      {{ s.solarOffsetMinutes > 0 ? '+' : '' }}{{ s.solarOffsetMinutes }}min
                    }
                  }
                </div>
              </div>

              @if (auth.user()?.role === 'admin') {
                <button
                  class="toggle-btn"
                  [class.active]="s.enabled"
                  (click)="toggleEnabled(s)">
                  {{ s.enabled ? 'Enabled' : 'Disabled' }}
                </button>
                <button class="delete-btn" title="Delete" (click)="deleteSchedule(s)">✕</button>
              }
            </div>
          }
        </div>
      }
    </div>

    <!-- Create form modal -->
    @if (showForm()) {
      <div class="form-overlay" (click)="closeForm()">
        <div class="card form-card" (click)="$event.stopPropagation()">
          <h2>New Schedule</h2>

          <div class="field">
            <label>Device</label>
            <select [(ngModel)]="form.deviceId">
              <option value="">Select a device…</option>
              @for (d of devices(); track d.id) {
                <option [value]="d.id">{{ d.alias }}</option>
              }
            </select>
          </div>

          <div class="field">
            <label>Label</label>
            <input type="text" [(ngModel)]="form.label" placeholder="e.g. Porch on at sunset" />
          </div>

          <div class="row-2">
            <div class="field">
              <label>Trigger type</label>
              <select [(ngModel)]="form.triggerType">
                <option value="solar">Solar event</option>
                <option value="cron">Cron (fixed time)</option>
              </select>
            </div>
            <div class="field">
              <label>Action</label>
              <select [(ngModel)]="form.state">
                <option [ngValue]="true">Turn ON</option>
                <option [ngValue]="false">Turn OFF</option>
              </select>
            </div>
          </div>

          @if (form.triggerType === 'solar') {
            <div class="row-2">
              <div class="field">
                <label>Solar event</label>
                <select [(ngModel)]="form.solarEvent">
                  @for (e of solarEvents; track e.value) {
                    <option [value]="e.value">{{ e.label }}</option>
                  }
                </select>
              </div>
              <div class="field">
                <label>Offset (minutes)</label>
                <input type="number" [(ngModel)]="form.solarOffsetMinutes" placeholder="0" />
              </div>
            </div>
          }

          @if (form.triggerType === 'cron') {
            <div class="field">
              <label>Preset</label>
              <select (change)="applyPreset($event)">
                @for (p of cronPresets; track p.value) {
                  <option [value]="p.value">{{ p.label }}</option>
                }
              </select>
            </div>
            <div class="field">
              <div class="label-row">
                <span class="field-label">Cron expression</span>
                <button type="button" class="help-btn" (click)="toggleCronHelp($event)">?</button>
              </div>
              @if (showCronHelp()) {
                <div class="cron-help" style="margin-top:0.4rem">
                  <strong style="color:var(--text)">Format:</strong>
                  <code>min&nbsp;&nbsp;hour&nbsp;&nbsp;day&nbsp;&nbsp;month&nbsp;&nbsp;weekday</code><br>
                  <table>
                    <tr><th>Field</th><th>Range</th><th>Example</th></tr>
                    <tr><td>min</td><td>0–59</td><td><code>30</code> = at :30</td></tr>
                    <tr><td>hour</td><td>0–23</td><td><code>21</code> = 9 PM</td></tr>
                    <tr><td>day</td><td>1–31</td><td><code>*</code> = every day</td></tr>
                    <tr><td>month</td><td>1–12</td><td><code>*</code> = every month</td></tr>
                    <tr><td>weekday</td><td>0–6 (Sun=0)</td><td><code>1-5</code> = Mon–Fri</td></tr>
                  </table>
                  <div style="margin-top:0.3rem">
                    <code>0 21 * * *</code> — every day at 9 PM<br>
                    <code>0 8 * * 1-5</code> — weekdays at 8 AM<br>
                    <code>0 8,20 * * *</code> — 8 AM and 8 PM daily
                  </div>
                </div>
              }
              <input type="text" [(ngModel)]="form.cronExpression" placeholder="0 21 * * *" style="margin-top:0.3rem" />
            </div>
          }

          @if (formError()) {
            <p class="error-msg">{{ formError() }}</p>
          }

          <div class="form-actions">
            <button class="btn-cancel" (click)="closeForm()">Cancel</button>
            <button class="btn-primary btn-save" [disabled]="saving()" (click)="save()">
              {{ saving() ? 'Saving…' : 'Save Schedule' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class SchedulesComponent implements OnInit {
  readonly solarEvents  = SOLAR_EVENTS;
  readonly cronPresets  = CRON_PRESETS;

  private readonly _schedules = signal<Schedule[]>([]);
  private readonly _devices   = signal<Device[]>([]);

  readonly schedules  = this._schedules.asReadonly();
  readonly devices    = this._devices.asReadonly();
  readonly showForm      = signal(false);
  readonly saving        = signal(false);
  readonly formError     = signal('');
  readonly showCronHelp  = signal(false);

  form = this.blankForm();

  constructor(readonly auth: AuthService, private http: HttpClient) {}

  ngOnInit(): void {
    this.loadSchedules();
    this.http.get<Device[]>('/api/devices').subscribe((d) => this._devices.set(d));
  }

  private loadSchedules(): void {
    this.http.get<Schedule[]>('/api/schedules').subscribe((s) => this._schedules.set(s));
  }

  private blankForm() {
    return {
      deviceId:           '' as number | '',
      label:              '',
      triggerType:        'solar' as 'solar' | 'cron',
      state:              true,
      solarEvent:         'sunset',
      solarOffsetMinutes: 0,
      cronExpression:     '',
    };
  }

  toggleCronHelp(e: Event): void {
    e.stopPropagation();
    this.showCronHelp.update((v) => !v);
  }

  closeForm(): void {
    this.showForm.set(false);
    this.form = this.blankForm();
    this.formError.set('');
    this.showCronHelp.set(false);
  }

  applyPreset(event: Event): void {
    this.form.cronExpression = (event.target as HTMLSelectElement).value;
  }

  solarLabel(event: string | null): string {
    return SOLAR_EVENTS.find((e) => e.value === event)?.label ?? event ?? '';
  }

  save(): void {
    const { deviceId, label, triggerType, state, solarEvent, solarOffsetMinutes, cronExpression } = this.form;
    if (!deviceId || !label) { this.formError.set('Device and label are required.'); return; }
    if (triggerType === 'cron' && !cronExpression) { this.formError.set('Cron expression is required.'); return; }

    this.saving.set(true);
    this.formError.set('');

    const payload = {
      deviceId: Number(deviceId), label, triggerType, state,
      ...(triggerType === 'solar' ? { solarEvent, solarOffsetMinutes: Number(solarOffsetMinutes) } : {}),
      ...(triggerType === 'cron'  ? { cronExpression } : {}),
    };

    this.http.post<Schedule>('/api/schedules', payload).subscribe({
      next: (created) => {
        this._schedules.update((list) => [created, ...list]);
        this.closeForm();
        this.saving.set(false);
      },
      error: (err) => {
        this.formError.set(err.error?.error ?? 'Failed to save.');
        this.saving.set(false);
      },
    });
  }

  toggleEnabled(s: Schedule): void {
    this.http.patch<Schedule>(`/api/schedules/${s.id}/toggle`, { enabled: !s.enabled }).subscribe({
      next: (updated) => this._schedules.update((list) => list.map((x) => x.id === s.id ? updated : x)),
    });
  }

  deleteSchedule(s: Schedule): void {
    if (!confirm(`Delete "${s.label}"?`)) return;
    this.http.delete(`/api/schedules/${s.id}`).subscribe({
      next: () => this._schedules.update((list) => list.filter((x) => x.id !== s.id)),
    });
  }
}
